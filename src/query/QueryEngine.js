'use strict';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { RoaringBitmap32 } = require('roaring');

import debugInstance from 'debug';
import { ArgumentError } from '../utils/errors.js';
import { parseSpec } from '../utils/spec.js';
import { safeParseDocuments } from '../utils/document.js';

const debug = debugInstance('canvas:synapsd');
// Unbounded materialization remains an explicit limit:0 opt-in.
const DEFAULT_LIST_LIMIT = 100;

// Ranks resolved candidates and materializes pages; does not initialize storage.
export default class QueryEngine {
    #documents;
    #bitmapIndex;
    #candidates;
    #vectors;
    #getTimelineIndex;
    #getLanceIndex;

    constructor({ documents, bitmapIndex, candidates, vectors, getTimelineIndex, getLanceIndex }) {
        this.#documents = documents;
        this.#bitmapIndex = bitmapIndex;
        this.#candidates = candidates;
        this.#vectors = vectors;
        this.#getTimelineIndex = getTimelineIndex;
        this.#getLanceIndex = getLanceIndex;
    }


    // bitmap===null => unconstrained (all docs / search-all); empty => no survivors.
    async rank(bitmap, match = null, options = {}) {
        const parseDocuments = options.parse !== false;
        // idsOnly short-circuits the LMDB fetch: the result array holds document
        // ids instead of documents, with the same count/totalCount/error shape.
        const idsOnly = options.idsOnly === true;
        const idResult = (ids, totalCount, error = null) => {
            const result = [...ids];
            result.count = result.length;
            result.totalCount = totalCount;
            result.error = error;
            return result;
        };

        if (match == null) {
            const providedLimit = Number.isFinite(options.limit) ? Number(options.limit) : undefined;
            const providedOffset = Number.isFinite(options.offset) ? Number(options.offset) : undefined;
            const providedPage = Number.isFinite(options.page) ? Number(options.page) : undefined;
            // Bounded by default; limit:0 is the explicit "all documents" opt-in.
            const limit = providedLimit !== undefined ? Math.max(0, providedLimit) : DEFAULT_LIST_LIMIT;
            const offset = Math.max(0, providedOffset !== undefined ? providedOffset : (providedPage && providedPage > 0 ? (providedPage - 1) * (limit || 100) : 0));
            // 'desc' = newest ids first (ids are allocated in insertion order;
            // GC id-reuse makes this approximate for reused ids).
            const descending = options.order === 'desc';

            // Timeline sort: order the candidate set by its values on a named
            // timeline (BSI value extraction), THEN paginate — the whole point is
            // that page 1 of a 1300-photo gallery is already in capture order.
            const sortTimeline = this.#normalizeSortBy(options.sortBy);
            if (sortTimeline && this.#getTimelineIndex()) {
                const base = bitmap === null ? await this.#candidates.allDocumentsBitmap() : bitmap;
                if (base.isEmpty) { return this.#emptyResult(); }
                const keyMap = await this.#getTimelineIndex().getSortKeys(sortTimeline, base);
                const keyed = [];
                const missing = [];
                for (const id of base) { (keyMap.has(id) ? keyed : missing).push(id); }
                keyed.sort((a, b) => {
                    const d = keyMap.get(a) - keyMap.get(b);
                    return d < 0n ? -1 : d > 0n ? 1 : a - b;
                });
                if (descending) { keyed.reverse(); missing.reverse(); }
                // Docs without a value on the timeline are unsortable — they
                // always trail (in id order) rather than polluting the sequence.
                const ids = keyed.concat(missing);
                const totalCount = ids.length;
                const slicedIds = limit === 0 ? ids : ids.slice(offset, offset + limit);
                if (idsOnly) { return idResult(slicedIds, totalCount); }
                const docs = await this.#documents.getMany(slicedIds);
                const resultArray = parseDocuments ? safeParseDocuments(docs) : docs;
                resultArray.count = resultArray.length;
                resultArray.totalCount = totalCount;
                resultArray.error = null;
                return resultArray;
            }

            if (bitmap === null) {
                const totalCount = await this.#documents.getCount();
                const pagedDocs = [];
                const pagedIds = [];
                let seen = 0;
                for await (const { key, value } of this.#documents.getRange({ reverse: descending })) {
                    if (seen++ < offset) { continue; }
                    if (idsOnly) { pagedIds.push(key); } else { pagedDocs.push(value); }
                    if (limit > 0 && (idsOnly ? pagedIds.length : pagedDocs.length) >= limit) { break; }
                }
                if (idsOnly) { return idResult(pagedIds, totalCount); }
                const resultArray = parseDocuments ? safeParseDocuments(pagedDocs) : pagedDocs;
                resultArray.count = resultArray.length;
                resultArray.totalCount = totalCount;
                resultArray.error = null;
                return resultArray;
            }

            const ids = bitmap.toArray();
            if (ids.length === 0) { return this.#emptyResult(); }
            if (descending) { ids.reverse(); }
            const totalCount = ids.length;
            const slicedIds = limit === 0 ? ids : ids.slice(offset, offset + limit);
            if (idsOnly) { return idResult(slicedIds, totalCount); }
            const docs = await this.#documents.getMany(slicedIds);
            const resultArray = parseDocuments ? safeParseDocuments(docs) : docs;
            resultArray.count = resultArray.length;
            resultArray.totalCount = totalCount;
            resultArray.error = null;
            return resultArray;
        }

        // Typed match: a plain string is the classic text query; an object is a
        // descriptor { text?, vectors?: [{space, vector, weight?, minDistance?,
        // maxDistance?}] }. Extra vector legs are caller-supplied embeddings
        // (an image query via embedd, a camera frame, a stored doc vector) that
        // fuse into the same RRF ranking as the built-in fts/dense/image legs.
        const desc = this.#normalizeMatch(match);
        const queryString = desc.text;

        if (bitmap !== null && bitmap.isEmpty) { return this.#emptyResult(); }
        const scopedIds = bitmap ? bitmap.toArray() : [];
        const { pageIds, totalCount, error } = await this.#rankIds(scopedIds, desc, options);
        if (idsOnly) { return idResult(pageIds, totalCount, error); }

        const docs = pageIds.length > 0 ? await this.#documents.getMany(pageIds) : [];
        const result = safeParseDocuments(docs);
        result.count = result.length;
        result.totalCount = totalCount;
        result.error = error;
        // Calibration aid: when debug is requested, attach the raw (unfloored)
        // image kNN distances for this query so a caller can pick imageMaxDistance
        // from real numbers. Best-effort; never fails the search.
        if (options.debug && queryString) {
            // Depth matters for calibration: the top-25 neighbours of ANY query
            // are all near by construction, so a short window shows a tight
            // cluster with no boundary in it. The match/noise transition is
            // usually further down — ask for more when you are picking a floor.
            const debugLimit = Math.min(Math.max(Number(options.debugLimit) || 25, 1), 500);
            try { result.debug = { imageDistances: await this.#imageDistances(queryString, scopedIds, debugLimit) }; }
            catch (e) { result.debug = { imageDistances: [], error: e.message }; }
        }
        return result;
    }

    async query(match = null, spec = {}) {
        const parsed = parseSpec(spec);
        const { bitmap } = await this.#candidates.resolveParsed(parsed);
        return await this.rank(bitmap, match, parsed.options);
    }

    async list(spec = {}) {
        const parsed = parseSpec(spec);
        try {
            const { bitmap } = await this.#candidates.resolveParsed(parsed);
            return await this.rank(bitmap, null, parsed.options);
        } catch (error) {
            debug(`Error in list: ${error.message}`);
            const errorArray = [];
            errorArray.count = 0;
            errorArray.totalCount = 0;
            errorArray.error = error.message;
            return errorArray;
        }
    }

    async search(spec = {}) {
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
            throw new Error('search() expects a query spec object');
        }
        // A string is the classic text query; an object is a typed multimodal
        // match descriptor { text?, vectors?: [{space, vector, ...}] } — see
        // rank(). Validation lives in #normalizeMatch, shared by both entries.
        const match = spec.query ?? spec.search ?? spec.q ?? null;
        if (typeof match !== 'string' && (match === null || typeof match !== 'object' || Array.isArray(match))) {
            throw new ArgumentError('Query must be a string or a { text?, vectors? } descriptor', 'query');
        }
        return await this.query(match, spec);
    }

    /**
     * Dense kNN with a CALLER-SUPPLIED query vector — the vector-in twin of the
     * text search path. synapsd stays byte- and model-free: whoever computed the
     * vector (embedd for an uploaded image, a sensor pipeline for a camera
     * frame, getDocumentVector for "more like this") hands it over and this
     * method only scopes + scans + materializes.
     *
     * `spec` is the usual structured scope (paths/features/filters/ids) resolved
     * via resolveCandidates and pushed down into the Lance scan, so a camera
     * frame arrives pre-filtered by the active context. Results are best-first
     * in kNN order.
     *
     * @param {number[]} queryVector  query embedding (must match the space dim)
     * @param {object}   spec         structured scope; {} = whole workspace
     * @param {object}   options      { space='image', limit=25, offset=0,
     *                                  minDistance, maxDistance, idsOnly,
     *                                  excludeIds, withDistances }
     * @returns docs[] (or ids[] with idsOnly) with .count/.totalCount/.error,
     *          plus .debug.distances when withDistances is set
     */
    async searchByVector(queryVector, spec = {}, options = {}) {
        if (!Array.isArray(queryVector) || queryVector.length === 0 || !queryVector.every(Number.isFinite)) {
            throw new ArgumentError('searchByVector() expects a non-empty numeric query vector', 'queryVector');
        }
        const space = options.space || 'image';
        const vi = await this.#vectors.get(space);
        if (!vi || !vi.isReady) {
            const empty = this.#emptyResult();
            empty.error = `vector space '${space}' not available`;
            return empty;
        }
        if (queryVector.length !== vi.dim) {
            throw new ArgumentError(`query vector dim ${queryVector.length} != space '${space}' dim ${vi.dim}`, 'queryVector');
        }

        // Structured scope → candidate ids pushed down into the Lance scan.
        const scope = (spec && Object.keys(spec).length > 0)
            ? (await this.#candidates.resolveParsed(parseSpec(spec))).bitmap
            : null;
        if (scope && scope.isEmpty) { return this.#emptyResult(); }
        const scopedIds = scope ? scope.toArray() : [];

        const limit = Math.max(1, Number(options.limit ?? 25));
        const offset = Math.max(0, Number(options.offset ?? 0));
        const excludeIds = new Set((options.excludeIds || []).map(Number));
        // Non-positive maxDistance disables the floor (explicit top-K opt-in),
        // mirroring the text path's imageMaxDistance semantics.
        const maxDistance = Number.isFinite(options.maxDistance) && options.maxDistance > 0 ? options.maxDistance : undefined;
        const minDistance = Number.isFinite(options.minDistance) ? options.minDistance : undefined;

        // Overfetch by the exclusion count so a filtered self-match (similarTo)
        // still fills the page.
        const res = await vi.vectorSearch(queryVector, scopedIds, {
            limit: limit + excludeIds.size,
            offset,
            minDistance,
            maxDistance,
            withDistances: !!options.withDistances,
        });
        if (res.error) {
            const empty = this.#emptyResult();
            empty.error = res.error;
            return empty;
        }
        const pageIds = (res.pageIds || []).filter((id) => !excludeIds.has(id)).slice(0, limit);
        const totalCount = Math.max(0, (res.totalCount || 0) - excludeIds.size);

        let result;
        if (options.idsOnly === true) {
            result = [...pageIds];
        } else {
            // getMany preserves input order → the page stays in kNN (best-first) order.
            const docs = await this.#documents.getMany(pageIds);
            result = options.parse !== false ? safeParseDocuments(docs) : docs;
        }
        result.count = result.length;
        result.totalCount = totalCount;
        result.error = null;
        if (options.withDistances && res.distances) {
            result.debug = { distances: pageIds.map((id) => ({ id, distance: res.distances[id] })) };
        }
        return result;
    }

    /**
     * Stateless multi-query refinement: AND a stack of full-text queries by
     * fts-scoping (each query narrows the previous result set), over an optional
     * structured base scope (paths/features/filters). The last query ranks the
     * final page; earlier queries act as lexical filters. No session/persistence —
     * this is the ad-hoc sibling of QuerySession.materialize.
     *
     *   searchRefined(['car','red','market'], { context:{path:'/Inbox'} }, { limit })
     *
     * @param {string[]} queries     ordered query strings; last one ranks
     * @param {object|null} baseSpec structured scope ({context,features,filters,...})
     * @param {object} options       { limit, offset, mode }
     * @returns docs[] with .count/.totalCount/.error (same shape as rank())
     */
    async searchRefined(queries = [], baseSpec = null, options = {}) {
        const texts = (Array.isArray(queries) ? queries : [queries])
            .filter((q) => typeof q === 'string' && q.trim().length > 0);

        // Structured base scope (null = unconstrained / all docs).
        const base = baseSpec ? (await this.#candidates.resolveParsed(parseSpec(baseSpec))).bitmap : null;

        // No text → plain structured listing (slice path, no Lance needed).
        if (texts.length === 0) {
            return await this.rank(base, null, options);
        }
        // Single text → one scoped ranked search (existing behavior).
        if (texts.length === 1) {
            return await this.rank(base, texts[0], options);
        }

        if (!this.#getLanceIndex() || !this.#getLanceIndex().isReady) {
            const empty = this.#emptyResult();
            empty.error = 'FTS not initialized';
            return empty;
        }

        // Fold all but the last query into a scope bitmap. Intermediate steps need
        // the FULL matching id set (not a page), so request a large internal limit;
        // scoped fts fetches every candidate, so the AND is exact for query 2+.
        const scope = await this.#foldQueryScope(texts.slice(0, -1), base, options);
        if (scope && scope.isEmpty) { return this.#emptyResult(); }

        // Final query ranks + paginates within the folded scope. The scope came
        // from a text stage, so the image leg switches to the scope-adaptive
        // cutoff — the absolute floor already did its job in stage one.
        return await this.rank(scope, texts[texts.length - 1], { ...options, imageRelativeFloor: true });
    }

    /**
     * Compound query: OR/AND of independent refinement chains ("lines"). Each
     * line is an ordered query chain over an optional per-line structured spec
     * (merged over the shared base spec); lines combine by set semantics —
     * 'or' = union, 'and' = intersection. Ranking: per-line ranked lists (the
     * line's last query ranks within its folded scope) fused via RRF, so a doc
     * matching several lines floats up; members beyond any line's ranking depth
     * trail in id order rather than being dropped. Max two levels by design —
     * lines of chains, no nesting.
     *
     *   searchCompound([
     *     { queries: ['car', 'red', 'volvo'] },
     *     { queries: ['boat', 'blue'], filters: ['t:thisYear'] },
     *   ], { op: 'or', baseSpec: { context: { path: '/Inbox' } }, limit: 50 })
     *
     * @param {{queries?: string[], filters?: string[], context?: object, features?: string[]}[]} lines
     * @param {{op?: 'or'|'and', baseSpec?: object|null, limit?, offset?, mode?}} options
     * @returns docs[] with .count/.totalCount/.error/.lines (per-line totals)
     */
    async searchCompound(lines = [], options = {}) {
        const op = (options.op || 'or').toLowerCase() === 'and' ? 'and' : 'or';
        const baseSpec = options.baseSpec || null;
        const list = (Array.isArray(lines) ? lines : [lines]).filter((l) => l && typeof l === 'object');
        if (list.length === 0) { return this.#emptyResult(); }

        // Ranked lists are capped: fusion only needs the head, membership (counts,
        // set ops) uses the full bitmaps.
        const FUSE_DEPTH = 500;

        const evaluated = await Promise.all(list.map(async (line) => {
            const texts = (Array.isArray(line.queries) ? line.queries : [])
                .filter((q) => typeof q === 'string' && q.trim().length > 0);
            // Per-line structured pieces AND-compose over the shared base spec.
            const spec = { ...(baseSpec || {}) };
            for (const key of ['filters', 'features', 'context', 'directory', 'attributes']) {
                if (line[key] !== undefined) {
                    spec[key] = Array.isArray(spec[key]) && Array.isArray(line[key])
                        ? [...spec[key], ...line[key]]
                        : line[key];
                }
            }
            const hasSpec = Object.keys(spec).length > 0;
            const base = hasSpec ? (await this.#candidates.resolveParsed(parseSpec(spec))).bitmap : null;

            if (texts.length === 0) {
                // Filters-only line: membership is the structured scope itself.
                const bitmap = base ?? await this.#candidates.allDocumentsBitmap();
                return { bitmap, rankedIds: [], error: null };
            }
            const scope = await this.#foldQueryScope(texts.slice(0, -1), base, options);
            if (scope && scope.isEmpty) { return { bitmap: scope, rankedIds: [], error: null }; }

            const last = texts[texts.length - 1];
            const scopeIds = scope ? scope.toArray() : [];
            const relative = texts.length > 1;
            // Membership (full match set of the last stage) and ranking (its head)
            // in parallel — same stage, two views.
            const [memberIds, ranked] = await Promise.all([
                // Same rule as the fold: FTS may return everything it matches, the
                // kNN side must stay bounded or a line's membership becomes the
                // whole photo library.
                this.#queryMatchSet(last, scopeIds, 1_000_000, { relativeImageFloor: relative, imageDepth: FUSE_DEPTH }),
                this.#rankIds(scopeIds, last, { mode: options.mode, minDistance: options.minDistance, maxDistance: options.maxDistance, limit: FUSE_DEPTH, offset: 0, imageRelativeFloor: relative }),
            ]);
            const bitmap = new RoaringBitmap32(memberIds);
            return { bitmap, rankedIds: (ranked.pageIds || []).filter((id) => bitmap.has(id)), error: ranked.error };
        }));

        // Set semantics across lines.
        let members = null;
        for (const line of evaluated) {
            members = members === null
                ? line.bitmap.clone()
                : (op === 'and' ? RoaringBitmap32.and(members, line.bitmap) : RoaringBitmap32.or(members, line.bitmap));
        }
        const lineCounts = evaluated.map((l) => ({ count: l.bitmap.size }));

        if (!members || members.isEmpty) {
            const empty = this.#emptyResult();
            empty.lines = lineCounts;
            return empty;
        }

        // Ranking: RRF across the per-line ranked heads (agreement floats up),
        // restricted to the combined member set; members past every line's
        // ranking depth trail in id order (still reachable by paging).
        const fused = this.#rrfMerge(evaluated.map((l) => l.rankedIds)).filter((id) => members.has(id));
        const inFused = new Set(fused);
        const orderedIds = fused.concat(members.toArray().filter((id) => !inFused.has(id)));

        const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : 50;
        const offset = Math.max(0, Number.isFinite(options.offset) ? Number(options.offset) : 0);
        const pageIds = limit === 0 ? orderedIds : orderedIds.slice(offset, offset + limit);

        const docs = pageIds.length > 0 ? await this.#documents.getMany(pageIds) : [];
        const result = safeParseDocuments(docs);
        result.count = result.length;
        result.totalCount = orderedIds.length;
        result.error = evaluated.every((l) => l.error) ? evaluated.map((l) => l.error).join('; ') : null;
        result.lines = lineCounts;
        return result;
    }

    // Match → { text: string|null, vectors: [{space, vector, weight?, minDistance?, maxDistance?}] }.
    // Throws unless at least one leg (text or vector) is present and well-formed.
    #normalizeMatch(match) {
        if (typeof match === 'string') { return { text: match, vectors: [] }; }
        if (!match || typeof match !== 'object' || Array.isArray(match)) {
            throw new ArgumentError('match must be a query string or a { text?, vectors? } descriptor', 'match');
        }
        const text = match.text ?? match.query ?? null;
        if (text !== null && typeof text !== 'string') {
            throw new ArgumentError('match.text must be a string', 'match');
        }
        const vectors = match.vectors ?? [];
        if (!Array.isArray(vectors)) {
            throw new ArgumentError('match.vectors must be an array of { space, vector } legs', 'match');
        }
        for (const leg of vectors) {
            if (!leg || typeof leg.space !== 'string' || !leg.space) {
                throw new ArgumentError('each vector leg requires a space name', 'match');
            }
            if (!Array.isArray(leg.vector) || leg.vector.length === 0 || !leg.vector.every(Number.isFinite)) {
                throw new ArgumentError(`vector leg for space '${leg.space}' requires a non-empty numeric vector`, 'match');
            }
        }
        if ((text === null || text === '') && vectors.length === 0) {
            throw new ArgumentError('match needs text and/or at least one vector leg', 'match');
        }
        return { text: typeof text === 'string' && text.length > 0 ? text : null, vectors };
    }

    /**
     * The id-producing core of rank(): FTS/vector/hybrid ranking within a scope,
     * returning ranked doc ids without fetching documents — reused by rank()
     * (which hydrates a page) and searchCompound() (which fuses per-line
     * rankings before hydrating anything).
     * `options.imageRelativeFloor` switches the image kNN leg to the
     * scope-adaptive cutoff (refinement chains — see #imageVectorSearch).
     * @param {number[]} scopedIds  candidate ids ([] = unscoped)
     * @returns {Promise<{pageIds:number[], totalCount:number, error:string|null}>}
     */
    async #rankIds(scopedIds, match, options = {}) {
        // Accept the classic string or a normalized { text, vectors } descriptor
        // (rank() normalizes; internal callers still pass plain strings).
        const desc = typeof match === 'string' ? { text: match, vectors: [] } : match;
        const queryString = desc.text;
        const legs = desc.vectors || [];

        // fts (BM25) | vector (kNN) | hybrid (RRF); vector/hybrid degrade to fts
        // when the dense stack is unavailable.
        let mode = (options.mode || 'hybrid').toLowerCase();
        if ((mode === 'vector' || mode === 'hybrid') && (!this.#vectors.primary || !this.#vectors.primary.isReady)) {
            debug(`rank: mode '${mode}' requested but vector index not ready; falling back to fts`);
            mode = 'fts';
        }
        if (mode === 'fts' && legs.length === 0 && (!this.#getLanceIndex() || !this.#getLanceIndex().isReady)) {
            return { pageIds: [], totalCount: 0, error: 'FTS not initialized' };
        }

        const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : 50;
        const offset = Math.max(0, Number.isFinite(options.offset) ? Number(options.offset) : 0);
        const depth = Math.max((limit + offset) * 5, 100);

        // Caller-supplied vector legs rank in their own spaces and fuse into
        // whatever the text side produces. A leg whose space is offline degrades
        // to an empty contribution (same philosophy as the hybrid text path:
        // one failed leg must not blank a search another leg answered).
        const legOperands = legs.length > 0
            ? await Promise.all(legs.map((leg) => this.#vectorLegSearch(leg, scopedIds, depth)))
            : [];
        const legErrors = legOperands.filter((o) => o.error).map((o) => o.error);

        // Legs-only match (no text): pure dense ranking. A single leg keeps its
        // exact kNN order (no RRF noise); multiple legs fuse weighted.
        if (!queryString) {
            let ids;
            if (legOperands.length === 1) {
                ids = legOperands[0].ids;
            } else {
                ids = this.#rrfMerge(legOperands.map((o) => ({ ids: o.ids, weight: o.weight })));
            }
            const allFailed = legErrors.length === legOperands.length && legErrors.length > 0;
            return {
                pageIds: ids.slice(offset, offset + limit),
                totalCount: ids.length,
                error: allFailed ? legErrors.join('; ') : null,
            };
        }

        let pageIds, totalCount, error;
        if (mode === 'vector' || mode === 'hybrid') {
            let queryVector = null;
            try {
                // Query embedding is injected (embedd service); absent → FTS fallback.
                const embedQuery = this.#vectors.config.embedQuery;
                queryVector = embedQuery ? await embedQuery(queryString, 'text') : null;
            } catch (e) {
                console.warn(`synapsd: rank query embedding failed, falling back to fts: ${e.message}`);
            }
            // CLIP/SigLIP image fan-out: embed the query with the image space's
            // text encoder and kNN the photo vectors (shared space), so "red car"
            // matches pictures. No-op (and no model load) unless photos are embedded.
            let imgIds = [];
            try {
                imgIds = await this.#imageVectorSearch(queryString, scopedIds, depth, { relativeFloor: !!options.imageRelativeFloor });
            } catch (e) {
                console.warn(`synapsd: rank image kNN failed, continuing without image results: ${e.message}`);
            }
            if (!queryVector && imgIds.length === 0 && legOperands.length === 0) {
                ({ pageIds, totalCount, error } = await this.#getLanceIndex().ftsQuery(queryString, scopedIds, { limit, offset }));
            } else if (mode === 'hybrid') {
                // Fuse DOCUMENT-level FTS (every doc — tabs included) with dense
                // kNN (embedded docs only) and image kNN via RRF. The VectorIndex's
                // own hybridSearch only fuses chunk-text BM25 over the vector table,
                // so it can't see un-embedded docs (e.g. tabs); doc-level FTS can.
                const [vec, fts] = await Promise.all([
                    queryVector
                        ? this.#vectors.primary.vectorSearch(queryVector, scopedIds, { limit: depth, offset: 0, minDistance: options.minDistance, maxDistance: options.maxDistance })
                        : Promise.resolve({ pageIds: [], error: null }),
                    this.#getLanceIndex().ftsQuery(queryString, scopedIds, { limit: depth, offset: 0 }),
                ]);
                // Weights: see semanticConfig.searchWeights — fts outranks the
                // floor-less text kNN, while floored image kNN fuses at parity
                // with lexical (a photo that clears imageMaxDistance is as real
                // a match as a filename hit).
                const w = this.#vectors.config.searchWeights;
                const operands = [
                    { ids: fts.pageIds || [], weight: w.fts },
                    { ids: vec.pageIds || [], weight: w.dense },
                ];
                if (imgIds.length) { operands.push({ ids: imgIds, weight: w.image }); }
                for (const o of legOperands) { operands.push({ ids: o.ids, weight: o.weight }); }
                const fused = this.#rrfMerge(operands);
                totalCount = fused.length;
                pageIds = fused.slice(offset, offset + limit);
                // Hybrid degrades, it doesn't fail: a transient dense-side error
                // (e.g. Lance mid-compaction during ingest) must not blank a
                // search the lexical side answered. Only surface an error when
                // BOTH legs failed.
                if (vec.error || fts.error) {
                    console.warn(`synapsd: hybrid search leg failed (fts: ${fts.error || 'ok'}, vector: ${vec.error || 'ok'})`);
                }
                error = (vec.error && fts.error) ? `${fts.error}; ${vec.error}` : null;
            } else {
                // Pure vector mode: fuse text + image kNN (both dense, equal weight).
                const vec = queryVector
                    ? await this.#vectors.primary.vectorSearch(queryVector, scopedIds, { limit: depth, offset: 0, minDistance: options.minDistance, maxDistance: options.maxDistance })
                    : { pageIds: [], error: null };
                if (imgIds.length || legOperands.length) {
                    const wv = this.#vectors.config.searchWeights;
                    const operands = [{ ids: vec.pageIds || [], weight: wv.dense }];
                    if (imgIds.length) { operands.push({ ids: imgIds, weight: wv.image }); }
                    for (const o of legOperands) { operands.push({ ids: o.ids, weight: o.weight }); }
                    const fused = this.#rrfMerge(operands);
                    totalCount = fused.length;
                    pageIds = fused.slice(offset, offset + limit);
                    error = vec.error || null;
                } else {
                    totalCount = (vec.pageIds || []).length;
                    pageIds = (vec.pageIds || []).slice(offset, offset + limit);
                    error = vec.error || null;
                }
            }
        } else if (legOperands.length > 0) {
            // fts mode + explicit vector legs: lexical ranks, legs still fuse —
            // the caller supplied them on purpose.
            const fts = (this.#getLanceIndex() && this.#getLanceIndex().isReady)
                ? await this.#getLanceIndex().ftsQuery(queryString, scopedIds, { limit: depth, offset: 0 })
                : { pageIds: [], error: 'FTS not initialized' };
            const w = this.#vectors.config.searchWeights;
            const operands = [{ ids: fts.pageIds || [], weight: w.fts }];
            for (const o of legOperands) { operands.push({ ids: o.ids, weight: o.weight }); }
            const fused = this.#rrfMerge(operands);
            totalCount = fused.length;
            pageIds = fused.slice(offset, offset + limit);
            error = null;
        } else {
            ({ pageIds, totalCount, error } = await this.#getLanceIndex().ftsQuery(queryString, scopedIds, { limit, offset }));
        }

        return { pageIds: pageIds || [], totalCount: totalCount ?? 0, error: error ?? null };
    }

    // One caller-supplied vector leg → a ranked-id RRF operand. Space offline or
    // scan failure degrades to an empty contribution carrying its error; a dim
    // mismatch is a caller bug and throws.
    async #vectorLegSearch(leg, scopedIds, depth) {
        const vi = await this.#vectors.get(leg.space);
        if (!vi || !vi.isReady) {
            return { ids: [], weight: 0, error: `vector space '${leg.space}' not available` };
        }
        if (leg.vector.length !== vi.dim) {
            throw new ArgumentError(`vector leg dim ${leg.vector.length} != space '${leg.space}' dim ${vi.dim}`, 'match');
        }
        const w = this.#vectors.config.searchWeights;
        const weight = Number.isFinite(leg.weight) && leg.weight > 0 ? leg.weight : (w[leg.space] ?? 1);
        const maxDistance = Number.isFinite(leg.maxDistance) && leg.maxDistance > 0 ? leg.maxDistance : undefined;
        const minDistance = Number.isFinite(leg.minDistance) ? leg.minDistance : undefined;
        const res = await vi.vectorSearch(leg.vector, scopedIds, { limit: depth, offset: 0, minDistance, maxDistance });
        return { ids: res.pageIds || [], weight, error: res.error || null };
    }

    // Weighted Reciprocal Rank Fusion of ranked id lists → one ranking. A doc's
    // score is Σ weight/(k + rank) across the lists it appears in (k=60 standard),
    // so agreement across signals floats to the top and either signal alone still
    // contributes. Accepts plain id arrays (weight 1) or { ids, weight } entries.
    // Returns doc ids, best first.
    #rrfMerge(lists, k = 60) {
        const score = new Map();
        for (const entry of lists) {
            const ids = Array.isArray(entry) ? entry : entry.ids;
            const weight = Array.isArray(entry) ? 1 : (entry.weight ?? 1);
            for (let rank = 0; rank < ids.length; rank++) {
                const id = ids[rank];
                score.set(id, (score.get(id) || 0) + weight / (k + rank + 1));
            }
        }
        return [...score.keys()].sort((a, b) => score.get(b) - score.get(a));
    }

    #emptyResult() {
        const empty = [];
        empty.count = 0;
        empty.totalCount = 0;
        empty.error = null;
        return empty;
    }

    // sortBy accepts 'content', 't:content', 'crud:created', or { timeline }.
    #normalizeSortBy(sortBy) {
        const raw = typeof sortBy === 'string'
            ? sortBy
            : (sortBy && typeof sortBy === 'object' ? sortBy.timeline : null);
        if (typeof raw !== 'string') { return null; }
        const name = raw.trim().replace(/^t:/, '');
        return name.length > 0 ? name : null;
    }

    /**
     * Fold an ordered list of text queries into a scope bitmap by CHAINING: stage
     * i's match set is computed within stage i-1's ids (Lance candidateIds
     * pushdown), so each query narrows the previous survivors. Match across FTS
     * ∪ image kNN (not FTS-only) so refinement narrows by photos too — otherwise
     * "library" folds to text docs and image refine is impossible. Stage one uses
     * the absolute image floor (global query — floor separates match from noise);
     * later stages use the scope-adaptive cutoff (see #imageVectorSearch).
     * Returns null only when texts is empty and base is null (unconstrained).
     * @param {string[]} texts
     * @param {RoaringBitmap32|null} base  structured scope (null = all docs)
     * @returns {Promise<RoaringBitmap32|null>}
     */
    async #foldQueryScope(texts, base, options = {}) {
        const FOLD_LIMIT = 1_000_000;
        // FOLD_LIMIT is right for FTS — "every lexical match" is a well-defined,
        // finite set. It is meaningless for the image leg: a kNN ALWAYS returns
        // its top-K, so asking for a million nearest photos folds the entire
        // library into the scope and the refine AND stops constraining
        // ("winter" then "window" returned summer windows). Bound the image side
        // to the same depth a single-query search of this stage would have used,
        // so refining narrows within what the user just saw.
        const imageDepth = Math.max(
            ((Number(options.limit) || 50) + (Number(options.offset) || 0)) * 5,
            100,
        );
        let scope = base; // RoaringBitmap32 | null (null = all docs)
        for (let i = 0; i < texts.length; i++) {
            if (scope && scope.isEmpty) { return scope; }
            const scopeIds = scope ? scope.toArray() : [];
            const matchedIds = await this.#queryMatchSet(texts[i], scopeIds, FOLD_LIMIT, { relativeImageFloor: i > 0, imageDepth });
            const matched = new RoaringBitmap32(matchedIds);
            scope = scope ? RoaringBitmap32.and(scope, matched) : matched;
        }
        return scope;
    }

    /**
     * kNN the image (CLIP/SigLIP) space with a text query embedded by that space's
     * text encoder — the joint space means "red car" lands near matching photos.
     * Returns [] (and loads no model) unless photos are actually embedded, so
     * text-only searches never pay for the image model.
     *
     * Floor modes (imageFloorMode, or forced per call by `opts.relativeFloor`):
     *
     * - relative (default): keep everything within `imageRelativeMargin` of the
     *   BEST hit for this query, then apply imageMaxDistance as a ceiling.
     *   Text→image distances are not comparable across queries — the modality
     *   gap shifts and compresses the whole distribution per query and per model
     *   (CLIP ViT-B/32 lands ~0.73 where SigLIP lands ~0.92), so one global
     *   cutoff either keeps everything or nothing. Anchoring on the query's own
     *   best hit adapts to that scale automatically, and re-embedding with a new
     *   model no longer invalidates the setting.
     * - absolute: drop hits beyond imageMaxDistance and nothing else. The
     *   pre-2026-08 behaviour; correct when a corpus IS calibrated and you want
     *   "no match" to mean no results.
     *
     * The ceiling is what keeps a relative floor honest: on its own it always
     * returns the nearest photo, so a camera pointed at a blank wall would still
     * surface something. imageMaxDistance caps that — set it loose (or off) and
     * the relative window governs; set it tight and an irrelevant query can
     * still come back empty. Refinement stages always force relative: the scope
     * already established relevance, so a global ceiling would empty them out.
     * @returns {Promise<number[]>} candidate docIds, best-first
     */
    async #imageVectorSearch(queryString, scopedIds, depth, opts = {}) {
        const cfg = this.#vectors.config.spaces?.image;
        const embedQuery = this.#vectors.config.embedQuery;
        if (!cfg || typeof embedQuery !== 'function') { return []; }
        const presence = await this.#bitmapIndex.getBitmap(cfg.bitmapKey, false);
        if (!presence || presence.isEmpty) { return []; }
        const vi = await this.#vectors.get('image');
        if (!vi || !vi.isReady) { return []; }
        const qv = await embedQuery(queryString, 'image');
        if (!qv) { return []; }
        // Absolute ceiling (cosine distance cap, 0 = identical; smaller =
        // stricter). Precedence: env override → workspace setting → default.
        // A non-positive value disables it (pure top-K / pure relative window).
        const envMax = process.env.CANVAS_IMAGE_MAX_DISTANCE;
        const cfgMax = (envMax != null && envMax !== '') ? Number(envMax) : this.#vectors.config.imageMaxDistance;
        const ceiling = Number.isFinite(cfgMax) && cfgMax > 0 ? cfgMax : undefined;

        // A refinement stage always uses the relative window (its scope already
        // established relevance); otherwise the configured mode decides.
        const relative = opts.relativeFloor || this.#vectors.config.imageFloorMode !== 'absolute';

        if (!relative) {
            const res = await vi.vectorSearch(qv, scopedIds, { limit: depth, offset: 0, maxDistance: ceiling });
            return res.pageIds || [];
        }

        // Refinement keeps its own margin knob for backwards compatibility; a
        // stage-one query uses the general one.
        const envMargin = Number(opts.relativeFloor
            ? (process.env.CANVAS_IMAGE_REFINE_MARGIN ?? process.env.CANVAS_IMAGE_RELATIVE_MARGIN)
            : (process.env.CANVAS_IMAGE_RELATIVE_MARGIN ?? process.env.CANVAS_IMAGE_REFINE_MARGIN));
        const margin = Number.isFinite(envMargin) && envMargin > 0
            ? envMargin
            : this.#vectors.config.imageRelativeMargin;

        // Fetch unfloored: the window is measured from THIS query's best hit, so
        // the ceiling must not prune before the anchor is known.
        const res = await vi.vectorSearch(qv, scopedIds, { limit: depth, offset: 0, minDistance: 0, maxDistance: 2, withDistances: true });
        const ids = res.pageIds || [];
        if (ids.length === 0) { return []; }
        const dist = res.distances || {};
        const best = dist[ids[0]];
        if (!Number.isFinite(best)) { return ids; }
        // Ceiling applies to a stage-one query only. On a refinement it would
        // undo the whole point — "red" over car photos legitimately peaks above
        // any global cutoff.
        const cap = (!opts.relativeFloor && ceiling !== undefined)
            ? Math.min(best + margin, ceiling)
            : best + margin;
        return ids.filter((id) => Number.isFinite(dist[id]) && dist[id] <= cap);
    }

    /**
     * The FULL set of docIds a single query matches, across modalities — doc-level
     * FTS (lexical, all schemas) UNION image kNN (photos, above the relevance
     * floor). Used by searchRefined's intermediate fold: FTS alone can never match
     * a photo (blobs have no text), so refining "library" then "table" over images
     * needs the image side here. Not a ranking — just membership, for AND-ing.
     * `opts.relativeImageFloor` switches the image side to the scope-adaptive
     * cutoff (see #imageVectorSearch) — used for refinement stages, where the
     * scope already established relevance and the absolute floor would empty out.
     * `opts.imageDepth` bounds the kNN side separately: `limit` means "all
     * matches" to FTS, but a kNN has no such notion and would happily return the
     * whole library (see #foldQueryScope).
     * @returns {Promise<number[]>}
     */
    async #queryMatchSet(queryString, scopeIds, limit, opts = {}) {
        const [fts, img] = await Promise.all([
            this.#getLanceIndex().ftsQuery(queryString, scopeIds, { limit, offset: 0 }).catch(() => ({ pageIds: [] })),
            this.#imageVectorSearch(queryString, scopeIds, opts.imageDepth ?? limit, { relativeFloor: !!opts.relativeImageFloor }).catch(() => []),
        ]);
        const ids = new Set(fts.pageIds || []);
        for (const id of img) { ids.add(id); }
        return [...ids];
    }

    /**
     * Debug/calibration: the top-N image kNN matches for a query WITH their cosine
     * distances (0 = identical … 1 = orthogonal … 2 = opposite; distance = 1 −
     * cosine similarity) and NO relevance floor — so you can see where matches
     * actually land and pick a sane `imageMaxDistance`. Best-first.
     * @returns {Promise<Array<{id:number, distance:number}>>}
     */
    async #imageDistances(queryString, scopedIds, n = 25) {
        const cfg = this.#vectors.config.spaces?.image;
        const embedQuery = this.#vectors.config.embedQuery;
        if (!cfg || typeof embedQuery !== 'function') { return []; }
        const presence = await this.#bitmapIndex.getBitmap(cfg.bitmapKey, false);
        if (!presence || presence.isEmpty) { return []; }
        const vi = await this.#vectors.get('image');
        if (!vi || !vi.isReady) { return []; }
        const qv = await embedQuery(queryString, 'image');
        if (!qv) { return []; }
        // min 0 / max 2 forces cosine and keeps the full range (no filtering), so
        // every returned neighbour comes back with an interpretable distance.
        const res = await vi.vectorSearch(qv, scopedIds, { limit: n, offset: 0, minDistance: 0, maxDistance: 2, withDistances: true });
        const dist = res.distances || {};
        return (res.pageIds || []).map((id) => ({ id, distance: dist[id] }));
    }
}
