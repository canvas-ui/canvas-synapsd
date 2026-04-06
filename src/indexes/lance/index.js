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

    async deleteMany(docIds) {
        if (!this.#table || !Array.isArray(docIds) || docIds.length === 0) { return; }
        const ids = docIds.filter(id => id != null);
        if (ids.length === 0) { return; }
        try {
            await this.#table.delete(`id IN (${ids.join(',')})`);
        } catch (e) {
            debug(`LanceIndex deleteMany failed: ${e.message}`);
            return;
        }
        if (this.#bitmapIndex) {
            try { await this.#bitmapIndex.untickMany([this.#ftsBitmapKey], ids); } catch (_) { }
        }
    }

    /**
     * BM25 full-text search via LanceDB index.
     * Returns { pageIds, totalCount, error } — caller loads docs from LMDB.
     * candidateIds: if non-empty, results are post-filtered to this set.
     */
    async ftsQuery(queryString, candidateIds = [], opts = {}) {
        if (!this.#table) {
            return { pageIds: [], totalCount: 0, error: 'LanceDB not ready' };
        }

        const limit = Math.max(1, Number(opts.limit ?? 50));
        const offset = Math.max(0, Number(opts.offset ?? 0));
        const candidateSet = candidateIds.length > 0 ? new Set(candidateIds) : null;

        // Overfetch so post-filtering + pagination still yields enough results
        const fetchLimit = candidateSet
            ? Math.min(candidateSet.size, (limit + offset) * 10 + 1000)
            : limit + offset;

        let rows;
        try {
            rows = await this.#table
                .search(queryString, 'fts')
                .select(['id'])
                .limit(fetchLimit)
                .toArray();
        } catch (e) {
            debug(`ftsQuery: BM25 search failed: ${e.message}`);
            return { pageIds: [], totalCount: 0, error: e.message };
        }

        let rankedIds = rows.map(r => Number(r.id));
        if (candidateSet) {
            rankedIds = rankedIds.filter(id => candidateSet.has(id));
        }

        const totalCount = rankedIds.length;
        const pageIds = rankedIds.slice(offset, limit > 0 ? offset + limit : undefined);
        return { pageIds, totalCount, error: null };
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
            const docs = [];
            for (const docId of idsToProcess) {
                try {
                    const docData = await documentsStore.get(docId);
                    if (docData) { docs.push(parseDoc(docData)); }
                } catch (e) {
                    debug(`backfill: failed to read doc ${docId}: ${e.message}`);
                }
            }

            await this.addMany(docs);
            const processed = docs.length;
            debug(`backfill: processed ${processed} documents`);
        } catch (e) {
            debug(`backfill: error ${e.message}`);
        }
    }

    async optimize() {
        if (!this.#table) { return null; }
        try {
            const stats = await this.#table.optimize();
            debug(`optimize: compacted ${stats?.compaction?.fragmentsRemoved ?? '?'} fragments`);
            return stats;
        } catch (e) {
            debug(`optimize: ${e.message}`);
            return null;
        }
    }

    async #ensureFtsIndex() {
        if (!this.#table) { return; }
        try {
            await this.#table.createIndex('fts_text', { config: lancedb.Index.fts() });
        } catch (e) {
            // Ignore "already exists" errors; log anything unexpected
            if (!e.message?.includes('already exists')) {
                debug(`ensureFtsIndex: ${e.message}`);
            }
        }
    }
}

export default LanceIndex;
