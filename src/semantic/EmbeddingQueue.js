'use strict';

import { EventEmitter } from 'events';
import debugInstance from 'debug';
import { chunkText } from '../utils/chunking.js';
const debug = debugInstance('canvas:synapsd:embed-queue');

/**
 * Main-thread orchestrator for asynchronous embedding.
 *
 * Holds the DB handles (documents store, VectorIndex, bitmap) and offloads only
 * the ONNX inference to the Embedder's worker thread. Ingestion enqueues docIds;
 * the queue reads each document, chunks its embeddable text, embeds the chunks,
 * and upserts the chunk vectors into the VectorIndex. Resumable: docs already in
 * the vectors presence-bitmap are skipped, so a crash/restart re-drives only the
 * unfinished tail (see SynapsD vector backfill on startup).
 *
 * Processing is sequential — the worker serializes inference anyway, and this
 * keeps main-thread read/upsert pressure bounded during bulk wiki.js imports.
 */
export default class EmbeddingQueue extends EventEmitter {

    #embedder;
    #vectorIndex;
    #documentsStore;
    #parseDoc;
    #queue = [];
    #queued = new Set();   // dedupe pending docIds
    #running = false;
    #stopped = false;

    constructor(options = {}) {
        super();
        this.#embedder = options.embedder;
        this.#vectorIndex = options.vectorIndex;
        this.#documentsStore = options.documentsStore;
        this.#parseDoc = options.parseDoc;
    }

    get size() { return this.#queue.length; }
    get isDraining() { return this.#running; }

    enqueue(docId) {
        const id = Number(docId);
        if (!Number.isInteger(id) || id <= 0 || this.#queued.has(id)) { return; }
        this.#queued.add(id);
        this.#queue.push(id);
        this.#kick();
    }

    enqueueMany(docIds) {
        if (!Array.isArray(docIds)) { return; }
        const before = this.#queue.length;
        for (const id of docIds) { this.enqueue(id); }
        debug(`enqueued ${this.#queue.length - before} docs (queue=${this.#queue.length})`);
    }

    /** Resolves when the queue has fully drained (or immediately if idle). */
    async drained() {
        if (!this.#running && this.#queue.length === 0) { return; }
        await new Promise((resolve) => this.once('drained', resolve));
    }

    stop() { this.#stopped = true; }

    #kick() {
        if (this.#running || this.#stopped) { return; }
        this.#running = true;
        // Detach from the caller's stack so enqueue() returns immediately.
        setImmediate(() => this.#drain());
    }

    async #drain() {
        const startPending = this.#queue.length;
        let processed = 0;
        debug(`drain start: ${startPending} docs pending`);
        try {
            while (this.#queue.length > 0 && !this.#stopped) {
                const docId = this.#queue.shift();
                this.#queued.delete(docId);
                try {
                    await this.#process(docId);
                    processed++;
                } catch (e) {
                    // Leave the doc out of the bitmap so a later backfill retries it.
                    debug(`process ${docId} failed: ${e.message}`);
                    this.emit('error', { docId, error: e.message });
                }
            }
        } finally {
            this.#running = false;
            if (this.#queue.length === 0) {
                debug(`drain done: embedded ${processed} docs`);
                this.emit('drained');
            } else { this.#kick(); }
        }
    }

    async #process(docId) {
        const raw = await this.#documentsStore.get(docId);
        if (!raw) { return; }
        const doc = this.#parseDoc(raw);

        const ftsData = typeof doc.generateEmbeddingsData === 'function' ? doc.generateEmbeddingsData() : null;
        const text = Array.isArray(ftsData) ? ftsData.join('\n').trim() : '';

        const chunkOpts = doc.indexOptions?.embeddingOptions?.chunking || {};
        const chunks = text ? chunkText(text, chunkOpts) : [];

        if (chunks.length === 0) {
            // Nothing to embed — clear any stale rows, leave bitmap unticked.
            await this.#vectorIndex.upsertChunks(docId, doc.schema, doc.updatedAt, []);
            return;
        }

        const vectors = await this.#embedder.embedPassages(chunks.map(c => c.text));
        const rows = chunks.map((c, i) => ({ chunkId: c.chunkId, text: c.text, vector: vectors[i] }))
            .filter(r => Array.isArray(r.vector));

        await this.#vectorIndex.upsertChunks(docId, doc.schema, doc.updatedAt, rows);
        debug(`embedded doc ${docId} (${rows.length} chunks)`);
        this.emit('embedded', { docId, chunks: rows.length });
    }
}
