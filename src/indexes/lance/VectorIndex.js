'use strict';

import fs from 'fs';
import path from 'path';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:vector-index');
import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, Float64, Int32, Utf8, Float32, FixedSizeList } from 'apache-arrow';

const { RRFReranker } = lancedb.rerankers;

// Default version-retention window for optimize(): prune dataset versions older
// than 1 day (Lance's own default is 7). Env-overridable in hours.
const CLEANUP_RETENTION_HOURS = Math.max(0, Number(process.env.CANVAS_LANCE_RETENTION_HOURS) || 24);
function defaultCleanupCutoff() {
    return CLEANUP_RETENTION_HOURS > 0 ? new Date(Date.now() - CLEANUP_RETENTION_HOURS * 3600 * 1000) : null;
}

// Tokenizer for the chunkText BM25 side of hybrid search. Mirrors the document
// FTS index (URL-aware simple tokenizer, fold + stem) so lexical behavior is
// consistent across the lexical-only and hybrid code paths.
const CHUNK_FTS_CONFIG = {
    withPosition: true,
    baseTokenizer: 'simple',
    lowercase: true,
    stem: true,
    removeStopWords: false,
    asciiFolding: true,
    maxTokenLength: 60,
};

/**
 * VectorIndex — dense + hybrid retrieval over chunk-level rows in a LanceDB
 * table (`vec_text`). One row per (docId, chunkId).
 *
 * Lexical (BM25 on chunkText) and dense (vector kNN) are fused natively by
 * LanceDB's RRF reranker in a single query — this is the hybrid half of the
 * MVP semantic stack; the document-wide FTS table in LanceIndex remains the
 * fts-only path for all abstractions.
 *
 * Vectors are consumer/worker-provided floats. This class only stores and
 * searches them — it does not run the embedding model.
 */
export default class VectorIndex {

    #db = null;
    #table = null;
    #rootPath;
    #tableName;
    #dim;
    #vectorBitmapKey;
    #bitmapIndex;

    constructor(options = {}) {
        this.#rootPath = options.rootPath;
        this.#tableName = options.tableName || 'vec_text';
        this.#dim = options.dim || 384;
        this.#vectorBitmapKey = options.vectorBitmapKey || 'internal/lance/vectors';
        this.#bitmapIndex = options.bitmapIndex || null;
    }

    get isReady() { return !!this.#table; }
    get dim() { return this.#dim; }

    #schema() {
        return new Schema([
            new Field('id', new Float64()),        // docId (Float64 to match LanceIndex, avoids BigInt)
            new Field('chunkId', new Int32()),
            new Field('schema', new Utf8()),
            new Field('updatedAt', new Utf8()),
            new Field('chunkText', new Utf8()),
            new Field('vector', new FixedSizeList(this.#dim, new Field('item', new Float32(), true))),
        ]);
    }

    // The fixed vector width of the on-disk table, or null if unknown. Used to
    // detect a dim change vs the configured model (triggers a recreate).
    async #tableVectorDim() {
        try {
            const schema = await this.#table.schema();
            const field = (schema?.fields || []).find((f) => f.name === 'vector');
            const size = field?.type?.listSize;
            return Number.isInteger(size) ? size : null;
        } catch (_) {
            return null;
        }
    }

    async initialize() {
        try {
            if (!this.#rootPath) { throw new Error('VectorIndex rootPath required'); }
            if (!fs.existsSync(this.#rootPath)) { fs.mkdirSync(this.#rootPath, { recursive: true }); }

            this.#db = await lancedb.connect(this.#rootPath);

            try {
                this.#table = await this.#db.openTable(this.#tableName);
                // Guard against a stale table built for a different embedding dim
                // (e.g. vec_image created at 512 before the CLIP/SigLIP 768 model was
                // wired). A vector added under the wrong dim throws, so recreate the
                // table to match the configured dim. Callers re-embed to refill it.
                const existingDim = await this.#tableVectorDim();
                if (existingDim !== null && existingDim !== this.#dim) {
                    debug(`VectorIndex '${this.#tableName}': dim ${existingDim} != configured ${this.#dim}; recreating`);
                    await this.#db.dropTable(this.#tableName);
                    this.#table = await this.#db.createEmptyTable(this.#tableName, this.#schema());
                }
            } catch (_) {
                this.#table = await this.#db.createEmptyTable(this.#tableName, this.#schema());
            }

            await this.#ensureChunkFtsIndex();

            if (this.#bitmapIndex) {
                await this.#bitmapIndex.createBitmap(this.#vectorBitmapKey);
            }

            debug(`VectorIndex initialized (table=${this.#tableName}, dim=${this.#dim})`);
        } catch (error) {
            debug(`VectorIndex initialization failed: ${error.message}`);
            this.#db = null;
            this.#table = null;
        }
    }

    /**
     * Replace all chunk rows for a document.
     * @param {number} docId
     * @param {string} schema
     * @param {string} updatedAt
     * @param {{chunkId:number, text:string, vector:number[]}[]} chunks
     */
    async upsertChunks(docId, schema, updatedAt, chunks) {
        if (!this.#table || !docId || !Array.isArray(chunks)) { return; }

        const rows = chunks
            .filter(c => Array.isArray(c.vector) && c.vector.length === this.#dim)
            .map(c => ({
                id: docId,
                chunkId: c.chunkId,
                schema: schema || '',
                updatedAt: updatedAt || new Date().toISOString(),
                chunkText: c.text || '',
                vector: c.vector,
            }));

        try {
            await this.#table.delete(`id = ${docId}`);
            if (rows.length > 0) { await this.#table.add(rows); }
        } catch (e) {
            debug(`upsertChunks failed for ${docId}: ${e.message}`);
            return;
        }

        if (this.#bitmapIndex) {
            try {
                if (rows.length > 0) { await this.#bitmapIndex.tick(this.#vectorBitmapKey, docId); }
                else { await this.#bitmapIndex.untick(this.#vectorBitmapKey, docId); }
            } catch (_) { }
        }
    }

    // Returns true when vector rows are gone (or nothing to clean), false when the
    // delete threw — callers gate doc-ID free-pool admission on this.
    async deleteDoc(docId) {
        if (!this.#table || !docId) { return true; }
        try { await this.#table.delete(`id = ${docId}`); } catch (e) {
            debug(`deleteDoc failed for ${docId}: ${e.message}`);
            return false;
        }
        if (this.#bitmapIndex) {
            try { await this.#bitmapIndex.untick(this.#vectorBitmapKey, docId); } catch (_) { }
        }
        return true;
    }

    async deleteMany(docIds) {
        if (!this.#table) { return true; }
        if (!Array.isArray(docIds) || docIds.length === 0) { return true; }
        const ids = docIds.filter(id => id != null);
        if (ids.length === 0) { return true; }
        try { await this.#table.delete(`id IN (${ids.join(',')})`); } catch (e) {
            debug(`deleteMany failed: ${e.message}`);
            return false;
        }
        if (this.#bitmapIndex) {
            try { await this.#bitmapIndex.untickMany([this.#vectorBitmapKey], ids); } catch (_) { }
        }
        return true;
    }

    /** Pure dense kNN. Returns { pageIds, totalCount, error } deduped to docIds (best chunk wins). */
    async vectorSearch(queryVector, candidateIds = [], opts = {}) {
        const { minDistance, maxDistance } = opts;
        const hasFloor = minDistance != null || maxDistance != null;
        return this.#search((q) => {
            let vq = q.nearestTo(queryVector);
            if (hasFloor) {
                // Force cosine so the bound is interpretable ([0,2], 0 = identical)
                // regardless of the index's build metric, then drop neighbours
                // outside [min,max]. Prunes "nearest but irrelevant" kNN hits before
                // fusion — a query with nothing close contributes nothing from the
                // dense side instead of its top-K garbage.
                vq = vq.distanceType('cosine').distanceRange(minDistance ?? undefined, maxDistance ?? undefined);
            }
            return vq;
        }, candidateIds, opts, 'vector');
    }

    /** Hybrid: dense kNN + BM25 on chunkText, fused by RRF. */
    async hybridSearch(queryVector, queryText, candidateIds = [], opts = {}) {
        if (!this.#table) { return { pageIds: [], totalCount: 0, error: 'VectorIndex not ready' }; }

        // RRFReranker.create() is async (builds the native reranker). With no
        // usable query text, fall back to pure dense search.
        const text = typeof queryText === 'string' ? queryText.trim() : '';
        if (!text) { return this.vectorSearch(queryVector, candidateIds, opts); }

        let reranker;
        try {
            reranker = await RRFReranker.create();
        } catch (e) {
            debug(`hybridSearch: reranker init failed, falling back to vector: ${e.message}`);
            return this.vectorSearch(queryVector, candidateIds, opts);
        }

        return this.#search(
            q => q.nearestTo(queryVector).fullTextSearch(text, { columns: ['chunkText'] }).rerank(reranker),
            candidateIds,
            opts,
            'hybrid',
        );
    }

    async #search(buildQuery, candidateIds, opts, label) {
        if (!this.#table) { return { pageIds: [], totalCount: 0, error: 'VectorIndex not ready' }; }

        const limit = Math.max(1, Number(opts.limit ?? 50));
        const offset = Math.max(0, Number(opts.offset ?? 0));
        const candidateSet = candidateIds.length > 0 ? new Set(candidateIds) : null;

        // Chunks expand the result space; overfetch so dedup-to-doc + filtering
        // + pagination still fills a page.
        const fetchLimit = ((limit + offset) * 8) + 200;

        let rows;
        try {
            let q = buildQuery(this.#table.query());
            if (candidateSet) {
                // Push the candidate filter down to LanceDB to prune before ranking.
                q = q.where(`id IN (${Array.from(candidateSet).join(',')})`);
            }
            rows = await q.select(['id']).limit(fetchLimit).toArray();
        } catch (e) {
            debug(`${label} search failed: ${e.message}`);
            return { pageIds: [], totalCount: 0, error: e.message };
        }

        // Rows arrive ranked; keep first (best) occurrence per docId. `_distance`
        // is auto-included by LanceDB even under select(['id']); capture it when
        // asked (opts.withDistances) so callers can surface it for threshold
        // calibration.
        const seen = new Set();
        const rankedIds = [];
        const distances = opts.withDistances ? {} : null;
        for (const r of rows) {
            const id = Number(r.id);
            if (seen.has(id)) { continue; }
            if (candidateSet && !candidateSet.has(id)) { continue; }
            seen.add(id);
            rankedIds.push(id);
            if (distances && distances[id] === undefined) { distances[id] = r._distance; }
        }

        const totalCount = rankedIds.length;
        const pageIds = rankedIds.slice(offset, offset + limit);
        return { pageIds, totalCount, error: null, distances };
    }

    /** Vector-table health/size snapshot for diagnostics UIs. */
    async stats() {
        if (!this.#table) { return { ready: false, dim: this.#dim }; }
        let chunkRows = 0;
        try { chunkRows = await this.#table.countRows(); } catch (_) { }
        let embeddedDocs = 0;
        if (this.#bitmapIndex) {
            try { const bm = await this.#bitmapIndex.getBitmap(this.#vectorBitmapKey, false); embeddedDocs = bm ? bm.size : 0; } catch (_) { }
        }
        let annIndex = false;
        try {
            const indices = await this.#table.listIndices();
            annIndex = indices.some(idx => Array.isArray(idx.columns) ? idx.columns.includes('vector') : idx.column === 'vector');
        } catch (_) { }
        return { ready: true, dim: this.#dim, chunkRows, embeddedDocs, annIndex };
    }

    // Compact fragments AND prune old dataset versions. reindex:true re-embeds
    // churn every row (delete + re-add), so without pruning the table keeps every
    // superseded version around (Lance's default retention is 7 days) — bloating
    // disk and slowing scans. Default to a 1-day retention window; pass a Date to
    // override, or null to keep Lance's default.
    async optimize({ cleanupOlderThan = defaultCleanupCutoff() } = {}) {
        if (!this.#table) { return null; }
        try {
            const opts = cleanupOlderThan ? { cleanupOlderThan } : undefined;
            return await this.#table.optimize(opts);
        } catch (e) { debug(`optimize: ${e.message}`); return null; }
    }

    /**
     * Build an ANN index on the vector column once there are enough rows for it
     * to help. Below the threshold LanceDB brute-forces, which is faster and
     * avoids "not enough rows to train" errors. Best-effort.
     */
    async ensureVectorIndex() {
        if (!this.#table) { return; }
        try {
            const count = await this.#table.countRows();
            if (count < 256) { return; }
            await this.#table.createIndex('vector', { config: lancedb.Index.hnswSq(), replace: true });
            debug(`ensureVectorIndex: built HNSW index over ${count} rows`);
        } catch (e) {
            if (!e.message?.includes('already exists')) { debug(`ensureVectorIndex: ${e.message}`); }
        }
    }

    async #ensureChunkFtsIndex() {
        if (!this.#table) { return; }
        const sigPath = path.join(this.#rootPath, `.${this.#tableName}-fts-signature`);
        const signature = JSON.stringify(CHUNK_FTS_CONFIG);
        let needsRebuild = true;
        try {
            const indices = await this.#table.listIndices();
            const hasFts = indices.some(idx => Array.isArray(idx.columns)
                ? idx.columns.includes('chunkText') : idx.column === 'chunkText');
            if (hasFts) {
                const prev = await fs.promises.readFile(sigPath, 'utf8').catch(() => null);
                needsRebuild = prev !== signature;
            }
        } catch (e) {
            debug(`ensureChunkFtsIndex: listIndices failed: ${e.message}`);
        }
        if (!needsRebuild) { return; }
        try {
            await this.#table.createIndex('chunkText', { config: lancedb.Index.fts(CHUNK_FTS_CONFIG), replace: true });
            await fs.promises.writeFile(sigPath, signature, 'utf8').catch(() => {});
        } catch (e) {
            if (!e.message?.includes('already exists')) { debug(`ensureChunkFtsIndex: ${e.message}`); }
        }
    }
}
