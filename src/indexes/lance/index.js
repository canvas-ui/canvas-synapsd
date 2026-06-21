'use strict';

import fs from 'fs';
import path from 'path';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:lance-index');
import * as lancedb from '@lancedb/lancedb';
const { MatchQuery, BooleanQuery, Operator, Occur } = lancedb;

/**
 * Tokenizer config for the BM25 index. Kept in one place so the on-disk
 * signature (see #ensureFtsIndex) can detect changes and rebuild the index
 * on existing data without the operator having to nuke the lance dir.
 *
 * - simple base tokenizer splits on punctuation, so URLs like
 *   `https://example.com/foo-bar` index as [https, example, com, foo, bar].
 * - asciiFolding + lowercase fold "Café" → "cafe"; stem folds "running" → "run".
 * - stop words kept: titles/URLs are short, dropping "the"/"a" loses recall.
 * - withPosition enables future phrase queries.
 */
const FTS_INDEX_CONFIG = {
    withPosition: true,
    baseTokenizer: 'simple',
    lowercase: true,
    stem: true,
    removeStopWords: false,
    asciiFolding: true,
    maxTokenLength: 60,
};
const FTS_CONFIG_SIGNATURE = JSON.stringify(FTS_INDEX_CONFIG);

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
    #ftsColumn = 'fts_text';

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

        const rowsById = new Map();
        for (const doc of docs) {
            if (!doc || !doc.id) { continue; }
            const ftsArray = typeof doc.generateFtsData === 'function' ? doc.generateFtsData() : null;
            rowsById.set(Number(doc.id), {
                id: doc.id,
                schema: doc.schema,
                updatedAt: doc.updatedAt,
                fts_text: Array.isArray(ftsArray) ? ftsArray.join('\n') : '',
            });
        }

        const rows = Array.from(rowsById.values());
        const ids = Array.from(rowsById.keys());
        if (rows.length === 0) { return; }

        try {
            await this.#table.delete?.(`id IN (${ids.join(',')})`);
            await this.#table.add(rows);
        } catch (e) {
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

    // Returns true when the fts row is gone (or nothing to clean), false when the
    // delete threw. Callers gate doc-ID free-pool admission on this — a failed
    // clean must NOT recycle the id (a reused id with a stale fts row corrupts
    // search). Nothing to clean (no table) counts as success.
    async delete(docId) {
        if (!this.#table || !docId) { return true; }
        try {
            await this.#table.delete?.(`id = ${docId}`);
        } catch (e) {
            debug(`LanceIndex delete failed for ${docId}: ${e.message}`);
            return false;
        }
        if (this.#bitmapIndex) {
            try { await this.#bitmapIndex.untick(this.#ftsBitmapKey, docId); } catch (_) { }
        }
        return true;
    }

    // Batch variant. Bulk table.delete is all-or-nothing, so success/failure is
    // batch-wide. See delete() for why callers gate pool admission on the result.
    async deleteMany(docIds) {
        if (!this.#table) { return true; }
        if (!Array.isArray(docIds) || docIds.length === 0) { return true; }
        const ids = docIds.filter(id => id != null);
        if (ids.length === 0) { return true; }
        try {
            await this.#table.delete(`id IN (${ids.join(',')})`);
        } catch (e) {
            debug(`LanceIndex deleteMany failed: ${e.message}`);
            return false;
        }
        if (this.#bitmapIndex) {
            try { await this.#bitmapIndex.untickMany([this.#ftsBitmapKey], ids); } catch (_) { }
        }
        return true;
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

        const ftsQueryObj = this.#buildFtsQuery(queryString);
        if (!ftsQueryObj) {
            // Query had no usable tokens (e.g. all punctuation) — empty, not error.
            return { pageIds: [], totalCount: 0, error: null };
        }

        // Overfetch so post-filtering + pagination still yields enough results
        const fetchLimit = candidateSet
            ? Math.min(candidateSet.size, (limit + offset) * 10 + 1000)
            : limit + offset;

        let rows;
        try {
            rows = await this.#table
                .search(ftsQueryObj)
                // _score is BM25-ordered; selecting it explicitly silences Lance's
                // scoring-autoprojection deprecation warning. Rows come back ranked.
                .select(['id', '_score'])
                .limit(fetchLimit)
                .toArray();
        } catch (e) {
            debug(`ftsQuery: BM25 search failed: ${e.message}`);
            return { pageIds: [], totalCount: 0, error: e.message };
        }

        let rankedIds = Array.from(new Set(rows.map(r => Number(r.id))));
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

    /** Index health/size snapshot for diagnostics UIs. */
    async stats() {
        if (!this.#table) { return { ready: false }; }
        let ftsRows = 0;
        try { ftsRows = await this.#table.countRows(); } catch (_) { }
        let indexedDocs = 0;
        if (this.#bitmapIndex) {
            try { const bm = await this.#bitmapIndex.getBitmap(this.#ftsBitmapKey, false); indexedDocs = bm ? bm.size : 0; } catch (_) { }
        }
        return { ready: true, ftsRows, indexedDocs };
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

    /**
     * Split a free-text query into normalized alphanumeric tokens, matching how
     * the `simple` tokenizer indexes content (splits on punctuation). This means
     * a pasted URL/path query like `file:///docs/report.pdf` becomes
     * [file, docs, report, pdf] and matches the indexed location URLs.
     */
    #tokenizeQuery(queryString) {
        if (typeof queryString !== 'string') { return []; }
        return queryString
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter(t => t.length > 0 && t.length <= FTS_INDEX_CONFIG.maxTokenLength);
    }

    /**
     * Build a fuzzy, high-recall FTS query from a raw user string.
     *
     * Naive BM25 (`table.search(rawString, 'fts')`) routed the string through
     * Lance's query parser, so `:` `/` `"` in URLs broke parsing and a single
     * typo returned nothing. Instead we tokenize ourselves and OR together one
     * fuzzy MatchQuery per token (Should), so any term contributes to the score
     * — close to fuse.js fuzzy matching, with BM25 doing the ranking.
     *
     * Fuzziness scales with token length (short tokens tolerate no edits to
     * avoid noise; longer ones tolerate up to 2), mirroring Elasticsearch AUTO.
     *
     * @returns {FullTextQuery|null} null when the string has no usable tokens
     */
    #buildFtsQuery(queryString) {
        const tokens = this.#tokenizeQuery(queryString);
        if (tokens.length === 0) { return null; }

        const toMatch = (token) => {
            const fuzziness = token.length <= 3 ? 0 : token.length <= 6 ? 1 : 2;
            return new MatchQuery(token, this.#ftsColumn, {
                fuzziness,
                prefixLength: 1,
                maxExpansions: 50,
                operator: Operator.Or,
            });
        };

        if (tokens.length === 1) { return toMatch(tokens[0]); }
        return new BooleanQuery(tokens.map(t => [Occur.Should, toMatch(t)]));
    }

    async #ensureFtsIndex() {
        if (!this.#table) { return; }

        // Rebuild only when the tokenizer config changed since last build — a
        // signature column on the (single-purpose) table records what built the
        // current index, so existing data picks up new tokenizer settings
        // without forcing a costly rebuild on every startup.
        let needsRebuild = true;
        try {
            const indices = await this.#table.listIndices();
            const hasFts = indices.some(idx => Array.isArray(idx.columns)
                ? idx.columns.includes(this.#ftsColumn)
                : idx.column === this.#ftsColumn);
            if (hasFts) {
                needsRebuild = (await this.#readFtsSignature()) !== FTS_CONFIG_SIGNATURE;
            }
        } catch (e) {
            debug(`ensureFtsIndex: listIndices failed, will (re)build: ${e.message}`);
        }

        if (!needsRebuild) { return; }

        try {
            await this.#table.createIndex(this.#ftsColumn, {
                config: lancedb.Index.fts(FTS_INDEX_CONFIG),
                replace: true,
            });
            await this.#writeFtsSignature();
            debug('ensureFtsIndex: (re)built FTS index with current tokenizer config');
        } catch (e) {
            if (!e.message?.includes('already exists')) {
                debug(`ensureFtsIndex: ${e.message}`);
            }
        }
    }

    #signaturePath() {
        return path.join(this.#rootPath, '.fts-config-signature');
    }

    async #readFtsSignature() {
        try {
            return await fs.promises.readFile(this.#signaturePath(), 'utf8');
        } catch (_) {
            return null;
        }
    }

    async #writeFtsSignature() {
        try {
            await fs.promises.writeFile(this.#signaturePath(), FTS_CONFIG_SIGNATURE, 'utf8');
        } catch (e) {
            debug(`writeFtsSignature: ${e.message}`);
        }
    }
}

export default LanceIndex;
