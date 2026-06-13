'use strict';

import { Worker } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:embedder');

// Friendly model name -> fastembed model id (its on-disk cache dir name).
const MODEL_IDS = {
    'bge-small-en-v1.5': 'fast-bge-small-en-v1.5',
    'bge-base-en-v1.5': 'fast-bge-base-en-v1.5',
    'all-minilm-l6-v2': 'fast-all-MiniLM-L6-v2',
};

/**
 * Main-thread proxy to the embedding worker (src/semantic/worker.js).
 *
 * Owns the single worker thread that hosts the fastembed model and exposes a
 * promise-based request/reply API. Used by both the EmbeddingQueue (passage
 * embedding during ingestion/backfill) and SynapsD.search() (query embedding).
 *
 * The worker is spawned lazily on first use so workspaces that never run a
 * semantic query pay no model-load cost.
 */
export default class Embedder {

    #worker = null;
    #readyPromise = null;
    #pending = new Map();
    #nextJobId = 1;
    #dim;

    constructor(options = {}) {
        this.#dim = options.dim || 384;          // BGESmallENV15 default
        this.model = options.model || 'bge-small-en-v1.5';
        this.cacheDir = options.cacheDir || null; // fastembed model store
        this.maxLength = options.maxLength || 512;
    }

    get dim() { return this.#dim; }

    /** True once the worker is spawned + model loaded. */
    get spawned() { return !!this.#worker; }

    /** Whether the model is already extracted in cacheDir (no download needed). */
    modelCached() {
        try {
            const id = MODEL_IDS[this.model] || this.model;
            return this.cacheDir ? fs.existsSync(path.join(this.cacheDir, id)) : false;
        } catch (_) { return false; }
    }

    /** Non-spawning status snapshot for diagnostics UIs. */
    status() {
        return {
            model: this.model,
            dim: this.#dim,
            cacheDir: this.cacheDir,
            modelCached: this.modelCached(),
            workerSpawned: this.spawned,
        };
    }

    /** Lazily spawn + initialize the worker. Idempotent. */
    async ready() {
        if (this.#readyPromise) { return this.#readyPromise; }

        this.#readyPromise = new Promise((resolve, reject) => {
            try {
                this.#worker = new Worker(new URL('./worker.js', import.meta.url));
            } catch (e) {
                reject(e);
                return;
            }

            this.#worker.on('message', (msg) => {
                if (msg?.type === 'ready') {
                    if (msg.dim) { this.#dim = msg.dim; }
                    debug(`Embedder ready (model=${this.model}, dim=${this.#dim})`);
                    resolve(this);
                    return;
                }
                if (msg?.type === 'initError') {
                    reject(new Error(`Embedder init failed: ${msg.error}`));
                    return;
                }
                // Correlated embed reply
                const entry = this.#pending.get(msg.jobId);
                if (!entry) { return; }
                this.#pending.delete(msg.jobId);
                if (msg.error) { entry.reject(new Error(msg.error)); }
                else { entry.resolve(msg.vectors); }
            });

            this.#worker.on('error', (err) => {
                debug(`Embedder worker error: ${err.message}`);
                // Fail every in-flight job; the worker is unusable.
                for (const [, entry] of this.#pending) { entry.reject(err); }
                this.#pending.clear();
                reject(err);
            });

            this.#worker.postMessage({
                type: 'init',
                model: this.model,
                cacheDir: this.cacheDir,
                maxLength: this.maxLength,
            });
        });

        return this.#readyPromise;
    }

    #send(texts, mode) {
        return new Promise((resolve, reject) => {
            const jobId = this.#nextJobId++;
            this.#pending.set(jobId, { resolve, reject });
            this.#worker.postMessage({ type: 'embed', jobId, texts, mode });
        });
    }

    /** Embed an array of passage/document strings -> number[][] (one vec per text). */
    async embedPassages(texts) {
        if (!Array.isArray(texts) || texts.length === 0) { return []; }
        await this.ready();
        return this.#send(texts, 'passage');
    }

    /** Embed a single query string -> number[] (with the model's query instruction). */
    async embedQuery(text) {
        if (typeof text !== 'string' || text.length === 0) { return null; }
        await this.ready();
        const [vec] = await this.#send([text], 'query');
        return vec || null;
    }

    async stop() {
        if (this.#worker) {
            await this.#worker.terminate();
            this.#worker = null;
            this.#readyPromise = null;
        }
    }
}
