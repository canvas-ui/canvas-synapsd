import debugInstance from 'debug';
import { parseInitializeDocument, safeParseDocuments } from '../utils/document.js';
import { normalizeBitmapKeys } from '../indexes/bitmaps/lib/keys.js';
import { facetBitmapKeys, derivedBitmapPrefixes, RETIRED_BITMAP_PREFIXES, MIME_BITMAP_PREFIX } from '../documents/derivation.js';
const debug = debugInstance('canvas:synapsd');

// Public repair jobs run under the document write queue. Internal composition
// calls these methods directly, so rebuilding several planes never re-enters it.
export default class Maintenance {
    #documents;
    #bitmapIndex;
    #derived;
    #writes;
    #vectors;
    #getAllBitmap;
    #getTimeline;
    #getEdges;
    #getLance;
    #getById;
    #assertRelation;
    #isRunning;
    constructor({ documents, bitmapIndex, derived, writes, vectors, getAllBitmap, getTimeline, getEdges, getLance, getById, assertRelation, isRunning }) {
        this.#documents = documents;
        this.#bitmapIndex = bitmapIndex;
        this.#derived = derived;
        this.#writes = writes;
        this.#vectors = vectors;
        this.#getAllBitmap = getAllBitmap;
        this.#getTimeline = getTimeline;
        this.#getEdges = getEdges;
        this.#getLance = getLance;
        this.#getById = getById;
        this.#assertRelation = assertRelation;
        this.#isRunning = isRunning;
    }

    /**
     * One-off repair: fold asserted edges that exist ONLY in the edge plane
     * back into their subject documents' `data.relations`. Heals data written
     * by the pre-write-through REST path (which linked edges directly, leaving
     * them invisible to the L3 rebuild). Idempotent — a healthy store is a
     * full scan and zero writes.
     *
     * @returns {Promise<{scanned:number, patched:number, orphaned:number}>}
     *          orphaned = asserted edges whose source document no longer exists
     */
    async backfillAssertedRelations() {
        // Materialize first: allEdges() pins a read txn, and assertRelation writes.
        const asserted = [];
        for (const edge of this.#getEdges().allEdges()) {
            if (edge.meta?.src === 'doc') { asserted.push(edge); }
        }

        let patched = 0;
        let orphaned = 0;
        for (const { from, p, to } of asserted) {
            const doc = await this.#getById(from);
            if (!doc) { orphaned++; continue; }
            if (await this.#assertRelation(from, p, to)) { patched++; }
        }

        debug(`backfillAssertedRelations: scanned ${asserted.length} asserted edges, patched ${patched}, orphaned ${orphaned}`);
        return { scanned: asserted.length, patched, orphaned };
    }

    /**
     * Rebuild the derived (L3) plane from rows.
     *
     * This is the rebuild invariant made executable: drop the derived structures,
     * recompute them from `documents` + extractors, and the index must come back
     * identical. If it does not, something is storing state that has no source.
     *
     * Composes the EXISTING reindexers rather than paralleling them — reindexMime,
     * reindexCrudTimelines, reindexSearchIndex and reindexEmbeddings already exist
     * and this is the umbrella that calls them plus the v3 derivations.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.edges=true]     drop + re-derive asserted edges
     * @param {boolean} [opts.bitmaps=true]   drop + re-derive mime/backend/facet keys
     * @param {boolean} [opts.timelines=false] re-derive crud:* timelines
     * @param {boolean} [opts.search=false]   rebuild the FTS index
     * @param {boolean} [opts.embeddings=false] recompute embeddings (expensive)
     * @param {string}  [opts.src]            only drop derived edges from this source
     */
    async rebuildL3(opts = {}) {
        const {
            edges = true, bitmaps = true, timelines = false,
            search = false, embeddings = false, src = null,
            onProgress = null,
        } = opts;

        const stats = { edges: 0, bitmapsDropped: 0, documents: 0 };

        if (edges) {
            if (src) {
                // Derived edges only — asserted ones have no meta row and are
                // reproduced from the rows below anyway.
                this.#getEdges().removeEdges({ src });
            } else {
                this.#getEdges().clear();
            }
        }

        if (bitmaps) {
            // device/os|type resolve through the #deviceFacets cache rather than off
            // the document being replayed, so the cache has to be row-fresh BEFORE
            // the drop. Otherwise those two keys are dropped and only partially put
            // back, which is the one way this rebuild could lose derived state.
            await this.#derived.loadDeviceFacets();

            for (const prefix of [...derivedBitmapPrefixes(), ...RETIRED_BITMAP_PREFIXES]) {
                for (const key of await this.#bitmapIndex.listBitmaps(prefix)) {
                    await this.#bitmapIndex.deleteBitmap(key);
                    stats.bitmapsDropped++;
                }
            }
        }

        if (edges || bitmaps) {
            const ids = await this.allDocumentIds();
            stats.documents = ids.length;
            stats.edges = await this.replayDerivedPlane(ids);
            if (onProgress) { onProgress({ ...stats }); }
        }

        if (timelines) { await this.reindexCrudTimelines({ onProgress }); }
        if (search) { await this.reindexSearchIndex({ rebuild: true, onProgress }); }
        if (embeddings) { await this.reindexEmbeddings({ onProgress }); }

        return stats;
    }

    async reindexCrudTimelines({ batchSize = 1000, onProgress = null } = {}) {
        this.#validateBatchSize(batchSize);
        if (!this.#isRunning()) { throw new Error('Database is not running'); }

        // 1. Drop stale crud timelines (clears BOTH old start/end and any ts bitmaps).
        const crudTimelines = ['crud:created', 'crud:updated', 'crud:deleted'];
        let removedTimelines = 0;
        for (const name of crudTimelines) {
            if (await this.#getTimeline().deleteTimeline(name)) { removedTimelines++; }
        }

        // 2. Collect every document id.
        const ids = [];
        for await (const { key } of this.#documents.getRange()) {
            const id = Number(key);
            if (Number.isInteger(id) && id > 0) { ids.push(id); }
        }

        // 3. Re-derive crud:created/updated in id batches, buffered per batch.
        const counts = { scanned: 0, created: 0, updated: 0, removedTimelines };
        for (let i = 0; i < ids.length; i += batchSize) {
            const slice = ids.slice(i, i + batchSize);
            const docs = safeParseDocuments(await this.#documents.getMany(slice));

            await this.#writes.withDeferredMembership(async () => {
                for (const doc of docs) {
                    counts.scanned++;
                    if (doc.createdAt) {
                        await this.#getTimeline().insert('crud:created', doc.id, new Date(doc.createdAt));
                        counts.created++;
                    }
                    if (doc.updatedAt) {
                        await this.#getTimeline().insert('crud:updated', doc.id, new Date(doc.updatedAt));
                        counts.updated++;
                    }
                }
            });

            if (onProgress) { onProgress({ ...counts, total: ids.length }); }
        }

        debug(`reindexCrudTimelines: scanned ${counts.scanned}, created ${counts.created}, updated ${counts.updated}`);
        return counts;
    }

    /**
     * Rebuild the per-MIME-type presence bitmaps (data/mime/*) from stored docs.
     * Like the comment bitmap these are derived-on-write with no synapse backing,
     * so this backfills them for a corpus indexed before mime bitmaps existed (e.g.
     * blobs). Drops every existing data/mime/* bitmap first (so ids from removed
     * docs don't linger), then re-ticks from each doc's metadata.contentType.
     * @returns {Promise<{scanned:number, ticked:number, keys:number}>}
     */
    async reindexMimeBitmaps({ batchSize = 1000, onProgress = null } = {}) {
        this.#validateBatchSize(batchSize);
        if (!this.#isRunning()) { throw new Error('Database is not running'); }

        // 1. Drop stale data/mime/* bitmaps for a clean rebuild.
        let dropped = 0;
        for (const key of await this.#bitmapIndex.listBitmaps(MIME_BITMAP_PREFIX)) {
            try { await this.#bitmapIndex.deleteBitmap(key); dropped++; } catch (_) { /* ignore */ }
        }

        // 2. Collect every document id.
        const ids = [];
        for await (const { key } of this.#documents.getRange()) {
            const id = Number(key);
            if (Number.isInteger(id) && id > 0) { ids.push(id); }
        }

        // 3. Re-tick mime keys in id batches, buffered per batch.
        const counts = { scanned: 0, ticked: 0, dropped, total: ids.length };
        const touchedKeys = new Set();
        for (let i = 0; i < ids.length; i += batchSize) {
            const slice = ids.slice(i, i + batchSize);
            const docs = safeParseDocuments(await this.#documents.getMany(slice));

            await this.#writes.withDeferredMembership(async () => {
                for (const doc of docs) {
                    counts.scanned++;
                    const keys = facetBitmapKeys(doc);
                    if (keys.length) {
                        await this.#writes.applyMembership('tick', doc.id, keys);
                        counts.ticked++;
                        for (const k of keys) { touchedKeys.add(k); }
                    }
                }
            });

            if (onProgress) { onProgress({ ...counts }); }
        }

        counts.keys = touchedKeys.size;
        debug(`reindexMimeBitmaps: scanned ${counts.scanned}, ticked ${counts.ticked} docs across ${counts.keys} mime bitmap(s) (dropped ${dropped})`);
        return counts;
    }

    /**
     * Backfill the Lance FTS index for every document not yet indexed. Needed for
     * databases populated before FTS existed (or only partially backfilled — start()
     * caps its backfill per run, so a large doc tail can stay unindexed across a few
     * restarts). Idempotent: addMany ticks the `internal/lance/fts` coverage bitmap,
     * so already-indexed docs are skipped. Runs in batches until no progress.
     *
     * Note: this populates BM25 full-text only. Dense vectors for old docs are a
     * separate (heavier) embedding backfill via the embedding queue.
     *
     * @returns {Promise<{ indexed, totalDocs, alreadyIndexed }>}
     */
    async reindexSearchIndex({ batchSize = 1000, rebuild = false, onProgress = null } = {}) {
        this.#validateBatchSize(batchSize);
        if (!this.#isRunning()) { throw new Error('Database is not running'); }
        if (!this.#getLance() || !this.#getLance().isReady) {
            throw new Error('FTS index not available (semantic disabled or Lance not ready)');
        }

        // rebuild: wipe the table + coverage bitmap first, so a drift where the
        // bitmap over-claims (rows lost but bitmap persisted) is fully repaired.
        if (rebuild) { await this.#getLance().clearFts(); }

        const totalDocs = await this.#documents.getCount();
        const startStats = await this.#getLance().stats().catch(() => ({ indexedDocs: 0 }));
        const alreadyIndexed = startStats.indexedDocs || 0;

        // Loop bounded batches until coverage stops growing (backfill skips indexed
        // docs and processes up to `batchSize` new ones per call).
        let prevIndexed = alreadyIndexed;
        for (;;) {
            await this.#getLance().backfill(this.#bitmapIndex, this.#documents, parseInitializeDocument, batchSize);
            const stats = await this.#getLance().stats().catch(() => ({ indexedDocs: prevIndexed }));
            const nowIndexed = stats.indexedDocs || 0;
            if (onProgress) { onProgress({ indexed: nowIndexed, totalDocs }); }
            if (nowIndexed <= prevIndexed) { break; } // no progress → done (or stuck)
            prevIndexed = nowIndexed;
        }

        try { await this.#getLance().optimize(); } catch (e) { debug(`reindexSearchIndex: optimize failed: ${e.message}`); }

        return { indexed: prevIndexed - alreadyIndexed, totalDocs, alreadyIndexed: prevIndexed };
    }

    /**
     * Report the embedding work-ledger for a space (docs missing embeddings).
     * synapsd no longer runs a model or a queue — the external embedd service
     * pulls this gap and drains it. Kept for the admin/reindex route, which now
     * hands the ids to embedd (or clears the space first for a full re-embed).
     *
     * @param {{space?:string, schemas?:string[]}} [opts]
     * @returns {Promise<{ space, unembedded:number[], totalEmbeddable, embeddableSchemas }>}
     */
    async reindexEmbeddings(opts = {}) {
        if (!this.#isRunning()) { throw new Error('Database is not running'); }
        if (!this.#vectors.primary) {
            throw new Error('Dense vector store not available (semantic disabled or not ready)');
        }
        const space = opts.space || 'text';
        const embeddableSchemas = (Array.isArray(opts.schemas) && opts.schemas.length)
            ? opts.schemas
            : Array.from(this.#vectors.config.embeddableSchemas);
        const all = await this.#bitmapIndex.OR(normalizeBitmapKeys(embeddableSchemas));
        const totalEmbeddable = all ? all.size : 0;
        const unembedded = await this.#vectors.getUnembeddedDocIds(space, embeddableSchemas);
        return { space, unembedded, totalEmbeddable, embeddableSchemas };
    }

    /**
     * One-time idempotent migration: lift legacy flat tree data into the new
     * per-tree PrefixedStore layout.
     *
     * Old format (single global ContextTree, data in raw #internalStore):
     *   layer/<ULID>          → layer records
     *   tree                  → serialised tree structure
     *   context/<layerName>   → context bitmaps (in bitmapIndex)
     *
     * New format (per-tree PrefixedStore keyed by treeId):
     *   tree/<treeId>/meta              → tree metadata
     *   tree/<treeId>/layer/<ULID>      → layer records
     *   tree/<treeId>/tree              → serialised tree structure
     *   context/<treeId>/<layerULID>    → context bitmaps
     *
     * The migration is skipped when the tree registry is already populated
     * (i.e. at least one tree/<id>/meta key exists) so it is safe to run on
     * every startup.
     */
    /**
     * One-time idempotent migration: rename legacy bitmap keys to new format.
     *
     * Context bitmaps: context/<name>  →  context/layer/<ulid>
     *   Old code keyed context bitmaps by layer name; new code keys by layer ULID.
     *
     * Feature bitmaps: feature/<prefix>/...  →  <prefix>/...
     *   Reverts the short-lived feature/ prefix; features are stored directly in bitmapIndex.
     */
    async documentStoreIsEmpty() {
        for await (const _ of this.#documents.getKeys({ limit: 1 })) { return false; }
        return true;
    }

    // One-time backfill for stores created before internal/docs/all existed:
    // an empty maintained bitmap alongside a non-empty document store means the
    // bitmap predates the feature — rebuild it from the store keys.
    async backfillAllDocumentsBitmap() {
        const bitmap = this.#getAllBitmap();
        if (!bitmap || !bitmap.isEmpty) { return; }
        const ids = [];
        for await (const { key } of this.#documents.getRange()) {
            const id = Number(key);
            if (Number.isInteger(id) && id > 0) { ids.push(id); }
        }
        if (ids.length > 0) {
            await this.#bitmapIndex.tick(bitmap.key, ids);
            debug(`Backfilled internal/docs/all with ${ids.length} live document id(s)`);
        }
    }

    /**
     * One-time rebuild of the crud:* lifecycle timelines from the document store.
     *
     * The crud timelines moved from interval/ms (dual-BSI) to point-event/second
     * (single-BSI ts) storage. Memberships written under the old scheme live in
     * tiers the new code never reads, so they're orphaned. This deletes the stale
     * crud bitmaps and re-derives crud:created (createdAt) + crud:updated
     * (updatedAt) for every stored document, writing them into the new tiers.
     *
     * Idempotent (delete + rebuild from the doc store). crud:deleted is NOT
     * rebuilt — those documents are gone — so past deletion history is dropped.
     *
     * @returns {Promise<{ scanned, created, updated, removedTimelines }>}
     */
    /**
     * Recompute the L3 structures derivable from rows: kind/mime/facet bitmaps,
     * location-derived device+backend features, asserted feature membership, and
     * asserted edges. Shared by the v3 migration and `rebuild --plane l3`, so the
     * rebuild invariant is exercised by the same code that migrates.
     */
    async replayDerivedPlane(ids = null) {
        const documentIds = ids ?? await this.allDocumentIds();
        let edges = 0;

        for (const id of documentIds) {
            const row = this.#documents.get(id);
            if (!row || typeof row !== 'object') { continue; }

            let doc;
            try { doc = parseInitializeDocument(row); } catch (error) {
                debug(`rebuild: skipping ${id} — ${error.message}`);
                continue;
            }
            doc.id = id;

            edges += await this.#derived.replayDocument(id, doc);
        }

        return edges;
    }

    async allDocumentIds() {
        const ids = [];
        for await (const { key } of this.#documents.getRange()) {
            const id = Number(key);
            if (Number.isInteger(id) && id > 0) { ids.push(id); }
        }
        return ids;
    }
    #validateBatchSize(batchSize) {
        if (!Number.isInteger(batchSize) || batchSize <= 0) { throw new Error('batchSize must be a positive integer'); }
    }

}
