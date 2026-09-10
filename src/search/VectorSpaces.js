'use strict';

import path from 'node:path';
import debugInstance from 'debug';
import * as lancedb from '@lancedb/lancedb';
import VectorIndex from '../indexes/lance/VectorIndex.js';
import { normalizeBitmapKeys } from '../indexes/bitmaps/lib/keys.js';
import { COMMENT_BITMAP_KEY } from '../documents/derivation.js';

const debug = debugInstance('canvas:synapsd');

// ── Embedding ledger keys ────────────────────────────────────────────────────
// Two per-space ledgers, both under `internal/embed/`:
//   internal/embed/vectors/<space>/<model-slug>  — presence ("this doc has vectors")
//   internal/embed/seen/<space>/<model-slug>     — processed (incl. deliberate skips)
//
// ALWAYS model-keyed, and the model segment is ALWAYS the leaf. A namespace must
// never also be a key: listBitmaps() range-scans `prefix + '/' .. prefix + '/￿'`,
// so a bare `internal/embed/vectors/text` sitting above
// `internal/embed/vectors/text/<slug>` would be invisible to a prefix query of its
// own namespace. That is exactly what the legacy `internal/lance/vectors` key did:
// it was the text presence bitmap AND the parent path of the image one, so
// listing `internal/lance/vectors` returned image and silently omitted text.
const VECTOR_PRESENCE_PREFIX = 'internal/embed/vectors';
const VECTOR_SEEN_PREFIX = 'internal/embed/seen';

function vectorModelSlug(model) {
    return String(model || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}
function vectorPresenceKey(space, model) { return `${VECTOR_PRESENCE_PREFIX}/${space}/${vectorModelSlug(model)}`; }
function vectorSeenKey(space, model) { return `${VECTOR_SEEN_PREFIX}/${space}/${vectorModelSlug(model)}`; }

// Baseline models — the ones every pre-config workspace is running.
const BASELINE_TEXT_MODEL = 'bge-small-en-v1.5';
const BASELINE_IMAGE_MODEL = 'Xenova/siglip-base-patch16-224';

/** Default vector spaces when no embedd service supplies them. */
function defaultVectorSpaces(dim = 384) {
    return {
        text: {
            table: 'vec_text', model: BASELINE_TEXT_MODEL, dim,
            bitmapKey: vectorPresenceKey('text', BASELINE_TEXT_MODEL),
            seenKey: vectorSeenKey('text', BASELINE_TEXT_MODEL),
        },
        // annIndex:false — image search is CROSS-MODAL (text query vector vs
        // photo vectors) with a tight distance floor. Lance's quantized ANN
        // indexes (SQ/PQ) train on the stored (image) distribution; a text query
        // lands far outside it and gets back wrong neighbours with wildly
        // inflated distances (measured: true 0.96 → ANN 1.49), which the
        // imageMaxDistance floor then rejects wholesale → zero results. Exact
        // scan is correct and fast at this scale once compacted.
        image: {
            table: 'vec_image', model: BASELINE_IMAGE_MODEL, dim: 768, annIndex: false,
            bitmapKey: vectorPresenceKey('image', BASELINE_IMAGE_MODEL),
            seenKey: vectorSeenKey('image', BASELINE_IMAGE_MODEL),
        },
    };
}

/**
 * Inverse of VectorSpaces#vectorTableName — recover (space, slug, dim) from a
 * model-keyed table name so a superseded model's leftovers can be identified
 * and its bitmap keys derived. Legacy `vec_text` / `vec_image` carry no model,
 * so only the space comes back.
 */
function parseVectorTableName(name) {
    const keyed = String(name).match(/^vec_([^_]+)__(.+)__(\d+)$/);
    if (keyed) { return { space: keyed[1], slug: keyed[2], model: keyed[2], dim: Number(keyed[3]) }; }
    const legacy = String(name).match(/^vec_(.+)$/);
    return legacy ? { space: legacy[1], slug: null, model: null, dim: null } : { space: null, slug: null, model: null, dim: null };
}

// Owns configured vector spaces, opened table handles, and embedding ledgers.
export default class VectorSpaces {
    #rootPath;
    #bitmapIndex;
    #config;
    #vectorIndex;
    #vectorSpaces = new Map();

    constructor({ rootPath, bitmapIndex, semantic = {} }) {
        this.#rootPath = rootPath;
        this.#bitmapIndex = bitmapIndex;
        // Semantic / dense-vector config. Disabled => fts-only (vector + hybrid
        // search degrade gracefully to lexical). synapsd owns no embedding model:
        // vectors arrive via storeDocumentEmbeddings (the embedd service / any app),
        // and query embedding is an injected `embedQuery(text, space)` callback.
        const sem = semantic || {};
        this.#config = {
            enabled: sem.enabled !== false,
            dim: sem.dim || 384,
            // Injected query-embedder (embedd service). Absent → vector/hybrid
            // search degrades to FTS (see rank()).
            embedQuery: typeof sem.embedQuery === 'function' ? sem.embedQuery : null,
            // Default candidate schemas for the unembedded-gap ledger when a caller
            // passes none. embedd normally supplies per-space candidate schemas.
            embeddableSchemas: new Set(sem.embeddableSchemas || ['data/schema/note']),
            // Vector "spaces": one LanceDB table per embedding model/dim. The
            // embedd service pushes vectors keyed by space and supplies these; the
            // defaults describe the baseline models so a workspace running without
            // embedd still reads and writes the same ledgers.
            spaces: sem.spaces || defaultVectorSpaces(sem.dim || 384),
            // Image search relevance floor (cosine distance, 0 = identical). CLIP
            // image kNN returns its top-K for ANY query, so without a cap every
            // search folds in unrelated photos. 0.945 calibrated against SigLIP
            // base fp32 (embedd's default dtype): true matches measured at
            // 0.90–0.94 across car/wine/table/audi known-item queries, noise
            // floor starts ~0.95. (The old 0.97 default was calibrated on q8
            // vectors.) Live-tunable per workspace (setSearchTuning) and
            // env-overridable (CANVAS_IMAGE_MAX_DISTANCE). null/0 = no floor.
            imageMaxDistance: typeof sem.imageMaxDistance === 'number' ? sem.imageMaxDistance : 0.945,
            // How the image floor is applied — see QueryEngine#imageVectorSearch.
            // 'relative' (default): keep hits within imageRelativeMargin of the
            // query's OWN best hit, capped by imageMaxDistance. Adapts to the
            // per-query, per-model scale shift that makes a single global cutoff
            // unusable (CLIP ViT-B/32 ~0.73 vs SigLIP ~0.92 for the same match).
            // 'absolute': imageMaxDistance alone (pre-2026-08 behaviour).
            imageFloorMode: sem.imageFloorMode === 'absolute' ? 'absolute' : 'relative',
            // Width of the relative window, in cosine distance from the best hit.
            imageRelativeMargin: Number.isFinite(sem.imageRelativeMargin) && sem.imageRelativeMargin > 0
                ? sem.imageRelativeMargin
                : 0.035,
            // Hybrid RRF fusion weights. fts > dense: text kNN has no relevance
            // floor, so its rank-0 hit on an irrelevant corpus would otherwise tie
            // a rank-0 EXACT lexical match. image == fts: image kNN IS floored
            // (imageMaxDistance), so a photo that clears the floor is as much a
            // "real match" as a filename hit — "red car" should surface the red
            // car photo alongside red-car.pdf, not below every ngram coincidence.
            searchWeights: {
                fts: sem.searchWeights?.fts ?? 2,
                dense: sem.searchWeights?.dense ?? 1,
                image: sem.searchWeights?.image ?? 2,
            },
        };

    }

    get config() { return this.#config; }
    get primary() { return this.#vectorIndex; }
    get openedCount() { return this.#vectorSpaces.size; }
    openedIndexes() { return this.#vectorSpaces.values(); }
    openedNames() { return this.#vectorSpaces.keys(); }

    async initialize() {
        // Dense-vector stack (best-effort: failure leaves fts-only search intact).
        // The ledger-key migration runs FIRST: VectorIndex latches its presence
        // bitmap key at construction, so migrating afterwards would leave it
        // writing to the canonical key while the legacy one still held the data.
        if (this.#config.enabled) {
            try {
                const textSpace = this.#config.spaces.text || defaultVectorSpaces(this.#config.dim).text;
                this.#vectorIndex = new VectorIndex({
                    rootPath: path.join(this.#rootPath, 'lance'),
                    tableName: this.#vectorTableName('text', textSpace),
                    dim: textSpace.dim,
                    model: textSpace.model,
                    vectorBitmapKey: textSpace.bitmapKey,
                    bitmapIndex: this.#bitmapIndex,
                });
                await this.#vectorIndex.initialize();
                this.#vectorSpaces.set('text', this.#vectorIndex);
                // No embedder/queue here anymore — embedding is owned by the
                // external embedd service, which drives ingestion off-thread and
                // pushes vectors back via storeDocumentEmbeddings. synapsd only
                // stores + searches, and reads the unembedded gap on request.
            } catch (e) {
                debug(`Semantic vector stack init failed (continuing fts-only): ${e.message}`);
                this.#vectorIndex = null;
            }
        }

    }

    async getStats() {
        if (!this.#config?.enabled) {
            return { enabled: false };
        }

        // Per-space stats for every CONFIGURED vector space (text + image), not
        // just the ones lazily initialized so far — otherwise the image space
        // disappears from the summary until something embeds/queries it. Lazily
        // opens each (embeddedDocs comes from the persistent presence bitmap, so
        // the count is right even for a freshly-opened table).
        const vectorSpaces = {};
        for (const name of Object.keys(this.#config.spaces || {})) {
            try {
                const vi = await this.get(name);
                vectorSpaces[name] = vi ? await vi.stats() : { ready: false };
            } catch (e) { vectorSpaces[name] = { ready: false, error: e.message }; }
        }

        return {
            enabled: true,
            dim: this.#config.dim,
            // Embedding is external (embedd service); synapsd owns no model.
            embedder: 'external',
            embedQuery: !!this.#config.embedQuery,
            embeddableSchemas: [...this.#config.embeddableSchemas],
            spaces: Object.keys(this.#config.spaces || {}),
            // Tunable search knobs (surfaced so the UI can show/edit current values).
            imageMaxDistance: this.#config.imageMaxDistance,
            imageFloorMode: this.#config.imageFloorMode,
            imageRelativeMargin: this.#config.imageRelativeMargin,
            searchWeights: { ...this.#config.searchWeights },
            // Back-compat: `vector` stays the text space; `vectorSpaces` breaks it
            // out per space (text, image, …) so image embedding is observable.
            vector: vectorSpaces.text || (this.#vectorIndex ? await this.#vectorIndex.stats().catch(e => ({ ready: false, error: e.message })) : { ready: false }),
            vectorSpaces,
        };
    }

    /**
     * Live-tunable search knobs (no restart): the image relevance floor and the
     * hybrid RRF fusion weights.
     * @param {{imageMaxDistance?: number|null, searchWeights?: {fts?:number, dense?:number, image?:number}}} tuning
     */
    setSearchTuning(tuning = {}) {
        if (Object.prototype.hasOwnProperty.call(tuning, 'imageMaxDistance')) {
            const v = tuning.imageMaxDistance;
            this.#config.imageMaxDistance = (v === null || Number.isFinite(v)) ? v : this.#config.imageMaxDistance;
        }
        if (tuning.imageFloorMode === 'absolute' || tuning.imageFloorMode === 'relative') {
            this.#config.imageFloorMode = tuning.imageFloorMode;
        }
        if (Number.isFinite(tuning.imageRelativeMargin) && tuning.imageRelativeMargin > 0) {
            this.#config.imageRelativeMargin = tuning.imageRelativeMargin;
        }
        if (tuning.searchWeights && typeof tuning.searchWeights === 'object') {
            const w = this.#config.searchWeights;
            for (const k of ['fts', 'dense', 'image']) {
                const v = tuning.searchWeights[k];
                if (Number.isFinite(v) && v >= 0) { w[k] = v; }
            }
        }
        return {
            imageMaxDistance: this.#config.imageMaxDistance,
            imageFloorMode: this.#config.imageFloorMode,
            imageRelativeMargin: this.#config.imageRelativeMargin,
            searchWeights: { ...this.#config.searchWeights },
        };
    }

    /**
     * Optimize dense-vector spaces: compact fragments, prune old versions, and
     * (re)build the ANN index. Pass a space name ('text'|'image') to optimize just
     * that Lance table; omit to optimize every configured space. Best-effort per
     * space — safe to call after a bulk import/re-embed. Returns { <space>: stats }.
     */
    async optimizeVectors(space = null) {
        const names = space ? [space] : Object.keys(this.#config.spaces || {});
        const out = {};
        for (const name of names) {
            const vi = await this.get(name);
            if (!vi) { out[name] = { ready: false }; continue; }
            try {
                await vi.optimize();
                out[name] = await vi.ensureVectorIndex();
            } catch (e) {
                out[name] = { error: e.message };
            }
        }
        return out;
    }


    /**
     * Every dense-vector table in this workspace's Lance store, with the spaces
     * currently bound to them. Model-keyed tables (`vec_<space>__<slug>__<dim>`)
     * left behind by a model swap show up here as `active: false` — they still
     * hold their vectors (that is the point: switching back is free), and this is
     * how an operator finds the ones worth reclaiming.
     */
    async listVectorTables() {
        const spaces = this.#config.spaces || {};
        const activeByTable = new Map();
        for (const [space, cfg] of Object.entries(spaces)) {
            activeByTable.set(this.#vectorTableName(space, cfg), { space, model: cfg.model || null, dim: cfg.dim });
        }

        let names = [];
        try {
            const db = await lancedb.connect(path.join(this.#rootPath, 'lance'));
            names = (await db.tableNames()).filter((n) => n.startsWith('vec_'));
        } catch (e) {
            debug(`listVectorTables failed: ${e.message}`);
            return { tables: [], error: e.message };
        }

        const tables = names.map((name) => {
            const active = activeByTable.get(name) || null;
            return { name, active: !!active, ...(active || parseVectorTableName(name)) };
        });
        return { tables };
    }

    /**
     * Drop a superseded model's vectors: the Lance table plus the presence/seen
     * bitmaps derived from its name. Refuses a table that a space is currently
     * bound to — dropping the live one is what `clearSpace` is for, and doing it
     * here would silently wipe the vectors search is using.
     * @param {string} name  table name from listVectorTables()
     */
    async dropVectorTable(name) {
        const { tables, error } = await this.listVectorTables();
        if (error) { return { dropped: false, error }; }
        const entry = tables.find((t) => t.name === name);
        if (!entry) { return { dropped: false, error: `unknown vector table '${name}'` }; }
        if (entry.active) {
            return { dropped: false, error: `'${name}' is the live table for space '${entry.space}' — switch the model first, or use clearSpace to re-embed it` };
        }

        const db = await lancedb.connect(path.join(this.#rootPath, 'lance'));
        await db.dropTable(name);

        // Ledger keys for a model-keyed table are derivable from its name (the
        // slug is the same one #vectorTableName wrote), so both go with it.
        const cleared = [];
        if (entry.space && entry.slug) {
            for (const key of [`${VECTOR_PRESENCE_PREFIX}/${entry.space}/${entry.slug}`, `${VECTOR_SEEN_PREFIX}/${entry.space}/${entry.slug}`]) {
                try { await this.#bitmapIndex.deleteBitmap(key); cleared.push(key); }
                catch (e) { debug(`dropVectorTable: could not clear bitmap ${key}: ${e.message}`); }
            }
        }
        debug(`dropped vector table '${name}' (${cleared.length} bitmap(s) cleared)`);
        return { dropped: true, name, bitmaps: cleared };
    }

    /**
     * The durable embedding work-ledger: docIds that match `schemas` but have not
     * been processed for `space` yet. gap = OR(schemas) AND-NOT seen(space).
     * Pure bitmap read (LMDB-backed, survives restart). The external embedd
     * service pulls this to reconcile after downtime / on demand.
     * @param {string} space
     * @param {string[]|null} schemas candidate schema keys (defaults to embeddableSchemas)
     * @returns {Promise<number[]>}
     */
    async getUnembeddedDocIds(space = 'text', schemas = null) {
        const cand = (Array.isArray(schemas) && schemas.length)
            ? schemas
            : Array.from(this.#config.embeddableSchemas);
        // The user-authored comment always embeds into the text space, so any doc
        // carrying one belongs in the text gap even when its schema is not otherwise
        // embeddable (photos, files, tabs). hasComment AND-NOT seen = lazy-embed queue.
        const keys = space === 'text' ? [...cand, COMMENT_BITMAP_KEY] : cand;
        if (keys.length === 0) { return []; }
        const set = await this.#bitmapIndex.OR(normalizeBitmapKeys(keys));
        if (!set || set.isEmpty) { return []; }
        const seen = await this.#bitmapIndex.getBitmap(this.seenKey(space), false);
        if (seen) { set.andNotInPlace(seen); }
        return set.toArray();
    }

    /**
     * Wipe an embedding space for a full re-embed: drop its vectors + presence
     * bitmap + seen ledger. After this, getUnembeddedDocIds returns everything.
     * @param {string} space
     */
    async clearSpace(space = 'text') {
        const vi = await this.get(space);
        if (!vi) { return false; }
        // Ids currently tracked in either bitmap.
        const seenKey = this.seenKey(space);
        const presenceKey = this.#config.spaces[space]?.bitmapKey;
        const ids = new Set();
        for (const key of [seenKey, presenceKey]) {
            if (!key) { continue; }
            const bm = await this.#bitmapIndex.getBitmap(key, false);
            if (bm) { for (const id of bm.toArray()) { ids.add(id); } }
        }
        const idArr = [...ids];
        if (idArr.length > 0) {
            await vi.deleteMany(idArr);                       // rows + presence untick
            try { await this.#bitmapIndex.untickMany([seenKey], idArr); } catch (_) { }
        }
        return true;
    }

    /**
     * Swap the vector spaces at runtime — what a model change needs.
     *
     * Nothing structural pins them: `get` builds a VectorIndex
     * lazily from `#config.spaces` and caches it, so replacing the
     * config and dropping the cache is enough. The old handles are plain
     * references to Lance tables that stay on disk (that is what makes a revert
     * free) and are simply released.
     *
     * The CALLER must quiesce writes first — pause the workspace's embedding
     * queue and let the in-flight batch finish — or a batch can straddle the
     * swap and scatter half its chunks into the outgoing table.
     */
    async setVectorSpaces(spaces = {}) {
        if (!this.#config.enabled) { return { applied: false, reason: 'semantic stack disabled' }; }
        if (!spaces || Object.keys(spaces).length === 0) { return { applied: false, reason: 'no spaces supplied' }; }

        this.#config.spaces = spaces;
        this.#vectorSpaces.clear();
        this.#vectorIndex = null;

        // Re-open the text space eagerly: it drives search, and rank() checks
        // #vectorIndex directly rather than going through get.
        this.#vectorIndex = await this.get('text');
        const applied = Object.fromEntries(
            Object.entries(spaces).map(([name, cfg]) => [name, this.#vectorTableName(name, cfg)]),
        );
        debug(`vector spaces swapped: ${JSON.stringify(applied)}`);
        return { applied: true, tables: applied, textReady: !!this.#vectorIndex };
    }

    /**
     * Store app-provided chunk vectors for a document (the non-JSON / media path —
     * server doesn't decode blobs, the embedd service computes and ships vectors).
     * Content chunks use ordinal chunkIds (0..N). Negative chunkIds are RESERVED
     * for auxiliary text chunks: -1 = user-authored comment (embedd's
     * COMMENT_CHUNK_ID), -2 = generated summary (SUMMARY_CHUNK_ID,
     * metadata.summary) — they never collide with content ordinals and keep
     * provenance at the vector layer.
     * @param {number} docId
     * @param {string} schema
     * @param {string} updatedAt
     * @param {{chunkId:number, text?:string, vector:number[]}[]} chunks
     * @param {{space?:string, model?:string}} [opts] target embedding space (default
     *   'text') + provenance model label stamped on the rows
     */
    async storeDocumentEmbeddings(docId, schema, updatedAt, chunks, opts = {}) {
        const space = opts.space || 'text';
        const vi = await this.get(space);
        if (!vi) { return false; }
        // upsertChunks ticks the presence bitmap when chunks>0 (unticks otherwise).
        await vi.upsertChunks(docId, schema, updatedAt, chunks, { model: opts.model });
        // Always mark the doc as processed in the ledger — even a deliberate skip
        // (0 chunks) must leave the unembedded gap, or reconcile re-fetches it forever.
        try { await this.#bitmapIndex.tick(this.seenKey(space), Number(docId)); } catch (_) { }
        return true;
    }

    /**
     * The stored embedding for a document in a named vector space (its first
     * chunk row), or null. Powers "more like this document" without any vector
     * crossing the API boundary — pair with searchByVector(excludeIds:[docId]).
     */
    async getDocumentVector(docId, space = 'image') {
        const vi = await this.get(space);
        if (!vi || !vi.isReady) { return null; }
        return await vi.getDocVector(docId);
    }

    /**
     * Per-space "seen" bitmap key — docs the embedder has processed (incl. skips).
     *
     * Scoped to the space's MODEL, which is what makes a model swap reversible:
     * the new model embeds into its own table with its own empty ledger, and
     * switching back finds the previous model's vectors AND its "already embedded"
     * bookkeeping intact, so nothing is re-embedded.
     */
    seenKey(space) {
        const cfg = this.#config.spaces?.[space];
        return cfg?.seenKey || vectorSeenKey(space, cfg?.model);
    }

    /**
     * Lazily create + initialize the VectorIndex for a named space. Returns null
     * if the semantic stack is disabled or the space is unknown.
     */
    // Lance table name for a vector space. An explicit `cfg.table` pins the space
    // to an existing table — baseline spaces keep vec_text/vec_image so making the
    // model configurable orphans nothing. Otherwise the table is keyed by
    // (space, model, dim) — `vec_text__qwen3-embedding-0.6b__1024` — so a model or
    // dim change lands in its OWN table instead of colliding with (and destroying)
    // another config's vectors; two models coexist and stay independently
    // queryable.
    #vectorTableName(space, cfg) {
        if (cfg?.table) { return cfg.table; }
        if (!cfg?.model) { return `vec_${space}`; }
        return `vec_${space}__${vectorModelSlug(cfg.model)}__${cfg.dim}`;
    }

    async get(space) {
        if (!this.#config.enabled) { return null; }
        if (this.#vectorSpaces.has(space)) { return this.#vectorSpaces.get(space); }
        const cfg = this.#config.spaces[space];
        if (!cfg) { debug(`unknown vector space '${space}'`); return null; }
        try {
            const vi = new VectorIndex({
                rootPath: path.join(this.#rootPath, 'lance'),
                tableName: this.#vectorTableName(space, cfg),
                dim: cfg.dim,
                model: cfg.model,
                vectorBitmapKey: cfg.bitmapKey,
                bitmapIndex: this.#bitmapIndex,
                annIndex: cfg.annIndex,
            });
            await vi.initialize();
            this.#vectorSpaces.set(space, vi);
            return vi;
        } catch (e) {
            debug(`failed to init vector space '${space}': ${e.message}`);
            return null;
        }
    }
}
