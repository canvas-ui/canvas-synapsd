'use strict';

import fs from 'fs';
import path from 'path';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:lance-index');
import * as lancedb from '@lancedb/lancedb';
const { MatchQuery, BooleanQuery, Operator, Occur } = lancedb;

// Default version-retention window for optimize(): prune dataset versions older
// than 1 day (Lance's own default is 7). Env-overridable in hours.
const CLEANUP_RETENTION_HOURS = Math.max(0, Number(process.env.CANVAS_LANCE_RETENTION_HOURS) || 24);
function defaultCleanupCutoff() {
    return CLEANUP_RETENTION_HOURS > 0 ? new Date(Date.now() - CLEANUP_RETENTION_HOURS * 3600 * 1000) : null;
}

/**
 * Tokenizer config for the BM25 index. Kept in one place so the on-disk
 * signature (see #ensureFtsIndex) can detect changes and rebuild the index
 * on existing data without the operator having to nuke the lance dir.
 *
 * We use an **ngram** base tokenizer (character n-grams) so substring and
 * concatenated/camelCase matches work — the recurring pain point. With `simple`,
 * "JobsIreland.ie" indexed as [jobsireland, ie] and a search for "ireland" or
 * "jobs" missed it; with ngram, "ireland" matches the `jobsireland` substring.
 * - ngramMinLength/MaxLength 3..4: trigram+quadgram. Good recall, bounded index
 *   size (our fields — titles/URLs/short notes — are tiny).
 * - prefixOnly false: index ngrams anywhere in the token, not just the prefix.
 * - lowercase + asciiFolding fold case/accents ("Café" → "cafe").
 * - stem off: stemming is a word-token transform and meaningless on ngrams.
 * Because the field is ngram-tokenized, fuzzy matching on top over-expands —
 * `#buildFtsQuery` uses exact (fuzziness 0) MatchQueries when IS_NGRAM.
 */
const FTS_INDEX_CONFIG = {
    withPosition: false,   // phrases match through cross-word ngrams instead; saves index size
    baseTokenizer: 'ngram',
    lowercase: true,
    stem: false,
    removeStopWords: false,
    asciiFolding: true,
    maxTokenLength: 60,
    ngramMinLength: 3,
    ngramMaxLength: 4,
    prefixOnly: false,
};
const FTS_CONFIG_SIGNATURE = JSON.stringify(FTS_INDEX_CONFIG);
const IS_NGRAM = FTS_INDEX_CONFIG.baseTokenizer === 'ngram';

/**
 * Split free text into normalized alphanumeric words. A pasted URL/path like
 * `file:///docs/report.pdf` becomes [file, docs, report, pdf]. On the ngram
 * index a word shorter than the smallest gram cannot match anything, so it is
 * dropped here rather than poisoning an all-words query.
 */
function tokenizeWords(text) {
    if (typeof text !== 'string') { return []; }
    const min = IS_NGRAM ? FTS_INDEX_CONFIG.ngramMinLength : 1;
    return text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(t => t.length >= min && t.length <= FTS_INDEX_CONFIG.maxTokenLength);
}

/**
 * The search-text grammar every caller shares (UI, REST, MCP, CLI): a
 * double-quoted segment is a phrase that must occur verbatim (a case- and
 * accent-insensitive substring; an unclosed quote runs to the end), everything
 * else is a bare word. `match: 'exact'` makes the whole string one phrase.
 * @returns {{ phrases: string[], words: string[] }}
 */
export function parseSearchText(queryString, { match } = {}) {
    const text = typeof queryString === 'string' ? queryString.trim() : '';
    if (!text) { return { phrases: [], words: [] }; }
    if (match === 'exact') {
        const phrase = text.replace(/^"+|"+$/g, '').trim();
        return { phrases: phrase ? [phrase] : [], words: [] };
    }
    const phrases = [];
    const rest = text.replace(/"([^"]*)(?:"|$)/g, (_, inner) => {
        const phrase = inner.trim();
        if (phrase) { phrases.push(phrase); }
        return ' ';
    });
    return { phrases, words: tokenizeWords(rest) };
}

/** True when the query asks for verbatim matching (quoted text or match: 'exact'). */
export function isExactQuery(queryString, options = {}) {
    return parseSearchText(queryString, options).phrases.length > 0;
}

// Case + accent folding for the phrase verification, mirroring the index's
// lowercase + asciiFolding so "café" and "cafe" meet on both sides.
function foldText(text) {
    return String(text).normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}
// Ranked hits are verified in id-batches of this size until the page is full.
const PHRASE_VERIFY_CHUNK = 200;

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
    #readBarrier = null;

    constructor(options = {}) {
        this.#rootPath = options.rootPath;
        this.#tableName = options.tableName || 'documents';
        this.#ftsBitmapKey = options.ftsBitmapKey || 'internal/lance/fts';
        this.#bitmapIndex = options.bitmapIndex || null;
    }

    get isReady() { return !!this.#table; }

    /** Presence bitmap key: ids that have an FTS row. */
    get presenceKey() { return this.#ftsBitmapKey; }

    /**
     * Awaited before every read, so a query sees writes still sitting in the
     * search write queue (read-your-writes without making writers wait).
     */
    setReadBarrier(fn) { this.#readBarrier = typeof fn === 'function' ? fn : null; }

    #row(doc) {
        const ftsArray = typeof doc.generateFtsData === 'function' ? doc.generateFtsData() : null;
        return {
            id: doc.id,
            schema: doc.schema,
            updatedAt: doc.updatedAt,
            fts_text: Array.isArray(ftsArray) ? ftsArray.join('\n') : '',
        };
    }

    /**
     * One Lance round trip for a queued batch: a single predicate delete (only
     * for ids that may have a row) and a single append — one fragment instead of
     * one per document. Bitmap bookkeeping is RETURNED, not applied: the caller
     * applies it under the database write lock.
     * @returns {{ ok: boolean, tick: number[], untick: number[] }}
     */
    async writeBatch({ upserts = [], deletes = [] } = {}) {
        if (!this.#table) { return { ok: true, tick: [], untick: [] }; }
        const rows = new Map();
        for (const doc of upserts) { if (doc?.id) { rows.set(Number(doc.id), this.#row(doc)); } }
        const removed = deletes.map(Number).filter((id) => id && !rows.has(id));
        const stale = await this.#idsWithRows([...rows.keys(), ...removed]);
        try {
            if (stale.length) { await this.#table.delete(`id IN (${stale.join(',')})`); }
            if (rows.size) { await this.#table.add([...rows.values()]); }
        } catch (e) {
            debug(`LanceIndex writeBatch failed: ${e.message}`);
            return { ok: false, tick: [], untick: [] };
        }
        return { ok: true, tick: [...rows.keys()], untick: removed };
    }

    /**
     * The ids among `ids` that may already have a row. A predicate delete has no
     * index on `id` to use — it scans every fragment, and each single-row add
     * makes another, so put latency grew with the table (26 ms → 285 ms over
     * 1500 puts; 16 s on a busy workspace, all under the global write lock).
     * New documents never have a row, so the FTS presence bitmap lets their
     * insert skip the delete. Without a bitmap, assume every id may have one.
     */
    async #idsWithRows(ids) {
        if (!this.#bitmapIndex) { return ids; }
        try {
            const present = await this.#bitmapIndex.getBitmap(this.#ftsBitmapKey, false);
            if (!present) { return ids; }
            return ids.filter((id) => present.has(Number(id)));
        } catch (_) {
            return ids;
        }
    }

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
            const stale = await this.#idsWithRows(ids);
            if (stale.length) { await this.#table.delete?.(`id IN (${stale.join(',')})`); }
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

        if ((await this.#idsWithRows([doc.id])).length) {
            try { await this.#table.delete?.(`id = ${doc.id}`); } catch (_) { }
        }
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
        await this.#readBarrier?.();
        if (!this.#table) {
            return { pageIds: [], totalCount: 0, error: 'LanceDB not ready' };
        }

        const limit = Math.max(1, Number(opts.limit ?? 50));
        const offset = Math.max(0, Number(opts.offset ?? 0));
        const candidateSet = candidateIds.length > 0 ? new Set(candidateIds) : null;

        const parsed = parseSearchText(queryString, { match: opts.match });
        if (parsed.phrases.length === 0 && parsed.words.length === 0) {
            // Nothing searchable (e.g. all punctuation) — empty, not error.
            return { pageIds: [], totalCount: 0, error: null };
        }

        // Overfetch so post-filtering + pagination still yields enough results,
        // AND so totalCount reflects the real match count (not just the page). The
        // unscoped branch previously fetched only limit+offset rows, which capped
        // totalCount at the page size and broke deep pagination on whole-workspace
        // search (every query looked like the same fixed candidate set).
        // The candidate set does NOT bound this. Filtering happens AFTER the BM25
        // search (Lance ranks the whole table, we keep the survivors), so fetching
        // only candidateSet.size rows asked for the globally top-N and then kept
        // whichever of those happened to be candidates — with a narrow scope
        // (`?ids=…`, one tree path, a camera frame's kNN survivors) the answer was
        // usually EMPTY, and the tighter you scoped the more likely it vanished.
        // Exactly backwards: narrowing must sharpen a search, not silence it.
        const fetchLimit = (limit + offset) * 10 + 1000;

        const run = async (requireAllWords) => {
            const ftsQueryObj = await this.#buildFtsQuery(parsed, { requireAllWords });
            const rows = await this.#table
                .search(ftsQueryObj)
                // _score is BM25-ordered; selecting it explicitly silences Lance's
                // scoring-autoprojection deprecation warning. Rows come back ranked.
                .select(['id', '_score'])
                .limit(fetchLimit)
                .toArray();
            let ranked = Array.from(new Set(rows.map(r => Number(r.id))));
            if (candidateSet) { ranked = ranked.filter(id => candidateSet.has(id)); }
            return ranked;
        };

        let rankedIds;
        try {
            // Several clauses: every word must match. Only when that finds
            // nothing (one word typo'd or absent) widen to any word, so the
            // search narrows by default but never blanks. Phrases stay required.
            const strict = parsed.words.length + parsed.phrases.length > 1;
            rankedIds = await run(strict);
            if (rankedIds.length === 0 && strict && parsed.words.length > 0) { rankedIds = await run(false); }
        } catch (e) {
            debug(`ftsQuery: BM25 search failed: ${e.message}`);
            return { pageIds: [], totalCount: 0, error: e.message };
        }
        if (parsed.phrases.length && rankedIds.length) {
            rankedIds = await this.#verifyPhrases(rankedIds, parsed.phrases, offset + limit);
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

    /**
     * Wipe the FTS table and reset the coverage bitmap. Used to recover from a
     * drift where the LMDB coverage bitmap claims docs are indexed but the Lance
     * table is missing their rows (e.g. the table dir was rebuilt/lost while the
     * bitmap persisted). After this, a full backfill re-adds every document with
     * no duplicate rows.
     */
    async clearFts() {
        if (!this.#table) { return; }
        try { await this.#table.delete('id >= 0'); } catch (e) { debug(`clearFts: table delete failed: ${e.message}`); }
        if (this.#bitmapIndex) {
            try { await this.#bitmapIndex.deleteBitmap(this.#ftsBitmapKey); } catch (_) { }
            try { await this.#bitmapIndex.createBitmap(this.#ftsBitmapKey); } catch (_) { }
        }
        debug('clearFts: table + coverage bitmap reset');
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

    // Compact fragments AND prune old dataset versions (default 1-day retention;
    // Lance's own default is 7 days). Pass a Date to override, or null to keep the
    // Lance default. Env-overridable via CANVAS_LANCE_RETENTION_HOURS.
    async optimize({ cleanupOlderThan = defaultCleanupCutoff() } = {}) {
        if (!this.#table) { return null; }
        try {
            const opts = cleanupOlderThan ? { cleanupOlderThan } : undefined;
            const stats = await this.#table.optimize(opts);
            debug(`optimize: compacted ${stats?.compaction?.fragmentsRemoved ?? '?'} fragments`);
            return stats;
        } catch (e) {
            debug(`optimize: ${e.message}`);
            return null;
        }
    }

    /**
     * Build the FTS query for a parsed search text.
     *
     * Naive BM25 (`table.search(rawString, 'fts')`) routed the string through
     * Lance's query parser, so `:` `/` `"` in URLs broke parsing and a single
     * typo returned nothing. Instead the text is parsed here (parseSearchText)
     * and assembled from MatchQuery clauses:
     *
     * - A phrase is one Must clause requiring every ngram Lance produces for
     *   the WHOLE phrase. The ngram tokenizer does not split on spaces or
     *   punctuation, so grams like `td s` and `s.r.` encode word adjacency and
     *   the clause is a near-exact substring match on the existing index — no
     *   positions needed (a PhraseQuery is meaningless on ngrams anyway). The
     *   rare gram collision is removed by #verifyPhrases.
     * - A word is one clause: Must when `requireAllWords`, else Should.
     *
     * Lance's `Operator.And` on an ngram MatchQuery does not require every
     * ngram (0.39: "winter" matched "summer window" via a shared "win"), so
     * every AND is spelled out as one Must clause per ngram. The ngrams come
     * from Lance's own tokenizer with the index config, so folding/lowercasing
     * match the index exactly and the answer is identical on indexed and
     * not-yet-indexed rows.
     *
     * @returns {Promise<FullTextQuery|null>} null when nothing is searchable
     */
    async #buildFtsQuery({ phrases, words }, { requireAllWords }) {
        const exact = (text) => new MatchQuery(text, this.#ftsColumn, { fuzziness: 0, operator: Operator.Or });
        const gramsOf = async (text) => [...new Set((await lancedb.tokenize(text, FTS_INDEX_CONFIG)).map((t) => t.text))];
        const allOf = (grams, fallback) => grams.length <= 1
            ? exact(grams[0] || fallback)
            : new BooleanQuery(grams.map((gram) => [Occur.Must, exact(gram)]));

        const toWord = async (word) => {
            if (IS_NGRAM) { return allOf(await gramsOf(word), word); }
            // Word tokenizers: each token is a whole word, so length-scaled
            // fuzziness gives typo tolerance (fuzzy on top of ngrams would
            // over-expand wildly).
            const fuzziness = word.length <= 3 ? 0 : word.length <= 6 ? 1 : 2;
            return new MatchQuery(word, this.#ftsColumn, { fuzziness, prefixLength: 1, maxExpansions: 50, operator: Operator.Or });
        };
        const toPhrase = async (phrase) => {
            if (IS_NGRAM) { return allOf(await gramsOf(phrase), phrase); }
            // Word tokenizers carry no positions here either: require every
            // word and let #verifyPhrases enforce adjacency.
            const parts = tokenizeWords(phrase);
            if (parts.length === 0) { return exact(phrase); }
            return new BooleanQuery(parts.map((w) => [Occur.Must, exact(w)]));
        };

        const clauses = [];
        for (const phrase of phrases) { clauses.push([Occur.Must, await toPhrase(phrase)]); }
        const wordOccur = requireAllWords ? Occur.Must : Occur.Should;
        for (const word of words) { clauses.push([wordOccur, await toWord(word)]); }

        if (clauses.length === 0) { return null; }
        if (clauses.length === 1) { return clauses[0][1]; }
        return new BooleanQuery(clauses);
    }

    /**
     * Drop gram-level phrase hits whose text does not actually contain every
     * phrase. Hits are checked best-first in batches until `need` survivors are
     * found; hits past that window keep the gram verdict (a full-gram match is
     * already a near-certain substring match), so a page costs a bounded
     * number of row reads however many hits there are. Order is preserved.
     */
    async #verifyPhrases(rankedIds, phrases, need) {
        const needles = phrases.map(foldText);
        const survivors = [];
        let i = 0;
        while (i < rankedIds.length && survivors.length < need) {
            const chunk = rankedIds.slice(i, i + PHRASE_VERIFY_CHUNK);
            i += chunk.length;
            let rows;
            try {
                rows = await this.#table.query().where(`id IN (${chunk.join(',')})`).select(['id', this.#ftsColumn]).toArray();
            } catch (e) {
                debug(`verifyPhrases: row read failed, keeping gram verdict: ${e.message}`);
                return survivors.concat(rankedIds.slice(i - chunk.length));
            }
            const texts = new Map(rows.map((r) => [Number(r.id), foldText(r[this.#ftsColumn] || '')]));
            for (const id of chunk) {
                const text = texts.get(id);
                if (text !== undefined && needles.every((n) => text.includes(n))) { survivors.push(id); }
            }
        }
        return survivors.concat(rankedIds.slice(i));
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
