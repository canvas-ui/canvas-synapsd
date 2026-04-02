'use strict';

import fs from 'fs';
import path from 'path';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:lance-index');
import * as lancedb from '@lancedb/lancedb';

/**
 * LanceIndex - FTS and vector search via LanceDB
 *
 * Vectors/embeddings are consumer-provided. SynapsD is a document store,
 * not an ML pipeline. Consumers pass pre-computed embeddings on insert.
 */
class LanceIndex {

    #db = null;
    #table = null;
    #rootPath;
    #tableName;
    #ftsBitmapKey;
    #bitmapIndex;

    constructor(options = {}) {
        this.#rootPath = options.rootPath;
        this.#tableName = options.tableName || 'documents';
        this.#ftsBitmapKey = options.ftsBitmapKey || 'internal/lance/fts';
        this.#bitmapIndex = options.bitmapIndex || null;
    }

    get isReady() { return !!this.#table; }

    async initialize() {
        try {
            if (!this.#rootPath) { throw new Error('LanceIndex rootPath required'); }
            if (!fs.existsSync(this.#rootPath)) {
                fs.mkdirSync(this.#rootPath, { recursive: true });
            }

            this.#db = await lancedb.connect(this.#rootPath);

            try {
                this.#table = await this.#db.openTable(this.#tableName);
            } catch (_) {
                // Create table with schema
                const sampleRow = {
                    id: 0,
                    schema: 'sample',
                    updatedAt: new Date().toISOString(),
                    fts_text: 'sample text',
                };
                await this.#db.createTable(this.#tableName, [sampleRow]);
                this.#table = await this.#db.openTable(this.#tableName);
                await this.#table.delete('id = 0');
            }

            // Ensure BM25 index on fts_text exists
            await this.#ensureFtsIndex();

            // Ensure FTS membership bitmap exists
            if (this.#bitmapIndex) {
                await this.#bitmapIndex.createBitmap(this.#ftsBitmapKey);
            }

            debug('LanceIndex initialized');
        } catch (error) {
            debug(`LanceDB initialization failed: ${error.message}`);
            this.#db = null;
            this.#table = null;
        }
    }

    async addMany(docs) {
        if (!this.#table || !Array.isArray(docs) || docs.length === 0) { return; }

        const rows = [];
        const ids = [];
        for (const doc of docs) {
            if (!doc || !doc.id) { continue; }
            const ftsArray = typeof doc.generateFtsData === 'function' ? doc.generateFtsData() : null;
            rows.push({
                id: doc.id,
                schema: doc.schema,
                updatedAt: doc.updatedAt,
                fts_text: Array.isArray(ftsArray) ? ftsArray.join('\n') : '',
            });
            ids.push(doc.id);
        }

        if (rows.length === 0) { return; }

        try { await this.#table.add(rows); } catch (e) {
            debug(`LanceIndex addMany failed: ${e.message}`);
            return;
        }

        if (this.#bitmapIndex) {
            try { await this.#bitmapIndex.tickMany([this.#ftsBitmapKey], ids); } catch (_) { }
        }
    }

    async upsert(doc) {
        if (!this.#table || !doc || !doc.id) { return; }

        const ftsArray = typeof doc.generateFtsData === 'function' ? doc.generateFtsData() : null;
        const ftsText = Array.isArray(ftsArray) ? ftsArray.join('\n') : '';

        const row = {
            id: doc.id,
            schema: doc.schema,
            updatedAt: doc.updatedAt,
            fts_text: ftsText,
        };

        try { await this.#table.delete?.(`id = ${doc.id}`); } catch (_) { }
        await this.#table.add([row]);

        if (this.#bitmapIndex) {
            try { await this.#bitmapIndex.tick(this.#ftsBitmapKey, doc.id); } catch (_) { }
        }
    }

    async delete(docId) {
        if (!this.#table || !docId) { return; }
        await this.#table.delete?.(`id = ${docId}`);
        if (this.#bitmapIndex) {
            try { await this.#bitmapIndex.untick(this.#ftsBitmapKey, docId); } catch (_) { }
        }
    }

    /**
     * Local FTS scoring over a pre-filtered candidate set.
     * Simple token-AND matching with frequency scoring.
     */
    async ftsQuery(queryString, candidateIds, docs, opts = { limit: 50, offset: 0 }) {
        const limit = Math.max(0, Number(opts.limit ?? 50));
        const offset = Math.max(0, Number(opts.offset ?? 0));

        const tokens = String(queryString).toLowerCase().split(/\s+/).filter(Boolean);
        const scored = [];

        for (const doc of docs) {
            const parts = (typeof doc.generateFtsData === 'function' ? doc.generateFtsData() : []) || [];
            const text = parts.join('\n').toLowerCase();
            let score = 0;
            for (const token of tokens) { if (text.includes(token)) { score++; } }
            if (score === tokens.length) { scored.push({ id: doc.id, score, doc }); }
        }

        scored.sort((a, b) => b.score - a.score || a.id - b.id);
        const sliced = limit === 0 ? scored : scored.slice(offset, offset + limit);
        const result = sliced.map(s => s.doc);
        result.count = result.length;
        result.totalCount = scored.length;
        result.error = null;
        return result;
    }

    async backfill(bitmapIndex, documentsStore, parseDoc, limit = 2000) {
        try {
            if (!this.#table) { return; }

            const processedBitmap = await bitmapIndex.getBitmap(this.#ftsBitmapKey, false);

            const idsToProcess = [];
            let skipped = 0;
            for await (const { key } of documentsStore.getRange()) {
                const docId = Number(key);
                if (!Number.isInteger(docId) || docId <= 0) {
                    continue;
                }
                if (processedBitmap && processedBitmap.has(docId)) {
                    skipped++;
                    continue;
                }
                idsToProcess.push(docId);
                if (limit > 0 && idsToProcess.length >= limit) {
                    break;
                }
            }

            if (idsToProcess.length === 0) { return; }

            debug(`backfill: skipped ${skipped} already indexed docs, processing ${idsToProcess.length}`);
            let processed = 0;
            for (const docId of idsToProcess) {
                try {
                    const docData = await documentsStore.get(docId);
                    if (docData) {
                        const doc = parseDoc(docData);
                        await this.upsert(doc);
                        processed++;
                    }
                } catch (e) {
                    debug(`backfill: failed to upsert doc ${docId}: ${e.message}`);
                }
            }

            debug(`backfill: processed ${processed} documents`);
        } catch (e) {
            debug(`backfill: error ${e.message}`);
        }
    }

    async #ensureFtsIndex() {
        if (!this.#table) { return; }
        try {
            await this.#table.createIndex?.({ type: 'BM25', columns: ['fts_text'] });
        } catch (_) { /* ignore if already exists */ }
    }
}

export default LanceIndex;
