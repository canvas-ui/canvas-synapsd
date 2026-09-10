'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd');
const require = createRequire(import.meta.url);
const { RoaringBitmap32 } = require('roaring');

// Events
import { EVENTS, createEvent, membershipDelta } from './utils/events.js';

// DB Backend
import LmdbBackend from './backends/lmdb/index.js';

// Schemas
import schemaRegistry from './schemas/SchemaRegistry.js';
import { predicateId } from './indexes/edges/predicates.js';
import { isDocumentData, isDocumentInstance } from './schemas/SchemaRegistry.js';

// Indexes
import BitmapIndex from './indexes/bitmaps/index.js';
import ChecksumIndex from './indexes/inverted/Checksum.js';
import TimelineIndex from './indexes/inverted/Timeline.js';
import GeoIndex from './indexes/inverted/GeoIndex.js';
import Synapses from './indexes/inverted/Synapses.js';
import EdgeIndex from './indexes/edges/index.js';
import LanceIndex from './indexes/lance/index.js';
import VectorSpaces from './search/VectorSpaces.js';
import { normalizeBitmapKeys, normalizeBitmapKey } from './indexes/bitmaps/lib/keys.js';
import SemanticEngine from './semantic/index.js';

// Views / Abstractions
import ContextTree from './views/ContextTree.js';
import DirectoryTree from './views/DirectoryTree.js';

// Extracted utilities
import { parseContextSpecForInsert, parseBitmapArray } from './utils/parsing.js';
import { parseDocumentData, parseInitializeDocument, safeParseDocuments } from './utils/document.js';
import QuerySession from './session/QuerySession.js';
import TreeRegistry from './trees/TreeRegistry.js';
import CandidateResolver from './query/CandidateResolver.js';
import QueryEngine from './query/QueryEngine.js';
import WriteCoordinator from './write/WriteCoordinator.js';
import DerivedIndexes from './write/DerivedIndexes.js';

import {
    COMMENT_BITMAP_KEY, MIME_BITMAP_PREFIX,
    RETIRED_BITMAP_PREFIXES, relationKey, documentFeatureKeys,
    validateDocumentRelations, documentRelations, facetBitmapKeys, schemaBitmapKeys,
    derivedBitmapPrefixes,
} from './documents/derivation.js';
import { mergeDedupePreservedFields, mergeDocumentLocations } from './documents/deduplication.js';
import { snapshotDocument, hasSearchContentChanged } from './documents/snapshot.js';

// Preserve the existing package entry-point exports.
export {
    derivedBitmapPrefixes,
    facetBitmapKeys as facetBitmapKeysForTest,
    schemaBitmapKeys as schemaBitmapKeysForTest,
} from './documents/derivation.js';

// Constants
const INTERNAL_BITMAP_ID_MAX = 100000;
// Row-format version of the database. Bump when a change makes rows written by
// this build unreadable by the previous one; a database below it is REFUSED at
// open (see start()) rather than migrated — there is no migration code here.
const SCHEMA_VERSION = 4;
const SCHEMA_VERSION_KEY = 'internal/schemaVersion';

/**
 * Public engine facade and composition root. Coordinates storage and writes;
 * delegates query resolution, ranking, vector spaces, and tree registration.
 */

class SynapsD extends EventEmitter {

    // Database Backend
    #dbBackend = 'lmdb';
    #rootPath;  // Root path of the database
    #db;        // Database backend instance

    // Internal KV store
    #internalStore;

    // Runtime
    #status;

    #trees;
    #candidates;
    #queries;
    #writes;
    #derived;

    // Bitmap Indexes
    #bitmapStore;   // Bitmap store
    #bitmapCache;   // In-memory cache for bitmap storage

    // Inverted Indexes
    #checksumIndex;
    #timelineIndex;
    #geoIndex;
    #synapses;
    #edges;

    // LanceDB
    #lanceIndex;

    // Semantic recall (dense + hybrid vector search)
    #semantic;
    #vectors;

    constructor(options = {
        backupOnOpen: false,
        backupOnClose: true,
        compression: true,
        eventEmitterOptions: {},
        // TODO: Add per dataset versioning support to the underlying db backend!
    }) {
        super({
            wildcard: true,
            delimiter: '.',
            newListener: false,
            maxListeners: 100,
            ...(options.eventEmitterOptions || {}),
        });
        debug('Initializing SynapsD');
        debug('DB Options:', options);

        // Runtime
        this.#status = 'initializing';

        // Initialize database backend
        this.#rootPath = options.rootPath ?? options.path;
        // Opt-in for the v3 row migration — see the gate in start(). Also readable
        // from the environment, because the constructor option is a whole-DB
        // switch and the DB is usually constructed deep inside a host process
        // (canvas-server opens one per workspace), where threading a flag down
        // means touching every call site.
        if (!this.#rootPath) { throw new Error('Database path required'); }

        if (options.backend && options.backend !== 'lmdb') {
            throw new Error(`Unsupported backend "${options.backend}". SynapsD only supports "lmdb" now.`);
        }

        debug('Database path:', this.#rootPath);
        debug('Backend type:', this.#dbBackend);

        this.#db = new LmdbBackend({
            ...options,
            path: this.#rootPath,
        });

        // Document datasets
        this.documents = this.#db.createDataset('documents');
        this.metadata = this.#db.createDataset('metadata');

        // Internal KV store
        this.#internalStore = this.#db.createDataset('internal');

        /**
         * Bitmap indexes
         */

        this.#bitmapCache = options.bitmapCache ?? new Map();
        this.#bitmapStore = options.bitmapStore ?? this.#db.createDataset('bitmaps');
        this.bitmapIndex = new BitmapIndex(
            this.#bitmapStore,
            this.#bitmapCache,
        );

        /**
         * Inverted indexes
         */

        this.#checksumIndex = new ChecksumIndex(this.#db.createDataset('checksums'));
        this.#timelineIndex = null;
        this.#geoIndex = null;
        this.#semantic = new SemanticEngine({ db: this });

        this.#vectors = new VectorSpaces({
            rootPath: this.#rootPath, bitmapIndex: this.bitmapIndex, semantic: options.semantic,
        });

        this.contextBitmapCollection = null;
        this.#trees = new TreeRegistry({
            internalStore: this.#internalStore,
            bitmapIndex: this.bitmapIndex,
            // Existing tree document APIs still call the facade for compatibility.
            createTreeInstance: (type, options) => type === 'directory'
                ? new DirectoryTree({ ...options, db: this })
                : new ContextTree({ ...options, db: this }),
            publish: (...args) => this.#emitEvent(...args),
            onContextCollection: collection => { this.contextBitmapCollection = collection; },
        });
        this.#candidates = new CandidateResolver({
            bitmapIndex: this.bitmapIndex,
            documents: this.documents,
            trees: this.#trees,
            getLiveDocumentsBitmap: () => this.allDocumentsBitmap,
            getTimelineIndex: () => this.#timelineIndex,
            getGeoIndex: () => this.#geoIndex,
            getEdges: () => this.#edges,
        });
        this.#queries = new QueryEngine({
            documents: this.documents,
            bitmapIndex: this.bitmapIndex,
            candidates: this.#candidates,
            vectors: this.#vectors,
            getTimelineIndex: () => this.#timelineIndex,
            getLanceIndex: () => this.#lanceIndex,
        });
        this.#writes = new WriteCoordinator({
            backend: this.#db, bitmapIndex: this.bitmapIndex,
            getSynapses: () => this.#synapses,
            restoreTrees: () => this.#trees.reloadCached(),
            restoreDevices: () => this.#derived.loadDeviceFacets(),
            publish: (...args) => super.emit(...args),
        });
        this.#derived = new DerivedIndexes({
            documents: this.documents, bitmapIndex: this.bitmapIndex,
            trees: this.#trees, writes: this.#writes,
            getTimeline: () => this.#timelineIndex, getGeo: () => this.#geoIndex,
            getEdges: () => this.#edges, list: spec => this.list(spec),
        });

    }

    /**
     * Getters
     */

    get rootPath() { return this.#rootPath; }
    get status() { return this.#status; }
    get stats() {
        return {
            dbBackend: this.#dbBackend,
            dbPath: this.#rootPath,
            status: this.#status,
            documentCount: this.documents.getCount(),
            metadataCount: this.metadata.getCount(),
            bitmapCacheSize: this.#bitmapCache.size,
            bitmapStoreSize: this.#bitmapStore.getCount(),
            checksumIndexSize: this.#checksumIndex.getCount(),
            timelineIndexSize: 'async',
            // TODO: Refactor this away
            deletedDocumentsCount: this.deletedDocumentsBitmap ? this.deletedDocumentsBitmap.size : 0,
        };
    }

    /**
     * Async stats including LanceDB FTS + dense-vector internals. Surfaced to
     * the Workspace Settings UI (the sync `stats` getter can't await Lance row
     * counts). Safe to call any time; degrades gracefully when sub-systems are
     * absent or not yet initialized.
     */
    async getStats() {
        const out = { ...this.stats };

        if (this.#lanceIndex) {
            try { out.fts = await this.#lanceIndex.stats(); } catch (e) { out.fts = { ready: false, error: e.message }; }
        }

        out.semantic = await this.#vectors.getStats();
        return out;
    }

    /**
     * Live-tunable search knobs (no restart): the image relevance floor and the
     * hybrid RRF fusion weights.
     * @param {{imageMaxDistance?: number|null, searchWeights?: {fts?:number, dense?:number, image?:number}}} tuning
     */
    setSearchTuning(tuning = {}) {
        return this.#vectors.setSearchTuning(tuning);
    }

    get db() { return this.#db; } // For testing only

    // Inverted indexes
    get checksumIndex() { return this.#checksumIndex; }
    get timeline() { return this.#timelineIndex; }
    get geo() { return this.#geoIndex; }
    get synapses() { return this.#synapses; }
    get edges() { return this.#edges; }
    /** The `internal` dataset (schema version marker, id counter). Exposed for
     *  migration tooling and tests — not part of the document API. */
    get internalStore() { return this.#internalStore; }
    /** Stats from the v3 migration if it ran during start(), else null. */
    get semantic() { return this.#semantic; }

    /**
     * Service methods
     */

    async start() {
        debug('Starting SynapsD');
        try {
            // Schema-version GATE. There is no migration code in this engine any
            // more (2026-08-04) — migrations are one-time operator actions and were
            // living on a hot startup path. What stays is the refusal, because
            // deleting the check would not make a stale database someone else's
            // problem, it would make it silent data loss: current code reading a
            // pre-v2 row never promotes `metadata.features`, so asserted tags that
            // exist ONLY in bitmaps — the one class of state with no rebuild source,
            // which is why features[] moved onto the row — would be dropped on the
            // next write with no error anywhere.
            //
            // A brand-new or empty database is simply stamped: there is nothing to
            // be stale about, and a fresh install must not hit the refusal.
            const appliedVersion = Number(this.#internalStore.get(SCHEMA_VERSION_KEY)) || 0;
            if (appliedVersion < SCHEMA_VERSION) {
                if (await this.#documentStoreIsEmpty()) {
                    await this.#internalStore.put(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
                } else {
                    throw new Error(
                        `synapsd: database is at schema v${appliedVersion}, this build needs ` +
                        `v${SCHEMA_VERSION}. Migration code was removed from the engine; migrate ` +
                        'the database with a one-off script against a backup, then stamp ' +
                        `${SCHEMA_VERSION_KEY} to ${SCHEMA_VERSION}.`,
                    );
                }
            }

            // Initialize deletedDocumentsBitmap here
            this.deletedDocumentsBitmap = await this.bitmapIndex.createBitmap('internal/gc/deleted');

            // Live-document membership: ticked on every put, unticked on delete
            // (regardless of free-pool admission, so failed lance cleanup can't
            // leave phantoms). Makes #buildAllDocumentsBitmap O(1) — the base for
            // unconstrained noneOf-only queries and the virtual 'default' dataset.
            this.allDocumentsBitmap = await this.bitmapIndex.createBitmap('internal/docs/all');
            await this.#backfillAllDocumentsBitmap();

            // 'tasks' (Task due dates) is a point-event axis — instants, not
            // intervals — so it gets the cheaper single-BSI storage.
            // DECIDED 2026-08-05: this hardcode is legitimate and Task stays a
            // core schema BECAUSE of it — the engine registering one point axis
            // for its own primitive is cheaper than a schema-declared timeline
            // registration mechanism nothing else needs yet. Revisit only if a
            // second schema wants its own point timeline.
            // Membership tiling is ADAPTIVE (per-entry notation-derived floor,
            // day-clamped) — no per-timeline quantum config exists anymore.
            this.#timelineIndex = new TimelineIndex(this.bitmapIndex, {
                pointTimelines: ['tasks'],
            });
            this.#geoIndex = new GeoIndex(this.bitmapIndex);

            // Initialize Synapses inverted index
            this.#synapses = new Synapses(
                this.#db.createDataset('synapses'),
                this.bitmapIndex,
            );

            // Device facets (os/type) are derived onto every document present on a
            // device, so the registry has to be warm before any write happens.
            await this.#derived.loadDeviceFacets();

            // Typed doc<->doc edges. dupSort adjacency on the shared root env —
            // sorted, deduped, O(1)-ish degree. Document-unaware by design: it
            // speaks node ids and predicates only, so membership inheritance
            // lives on the SynapsD facade (relate/unrelate) rather than here.
            this.#edges = new EdgeIndex(
                this.#db.createDataset('edges_fwd', { dupSort: true, encoding: 'ordered-binary' }),
                this.#db.createDataset('edges_inv', { dupSort: true, encoding: 'ordered-binary' }),
                this.#db.createDataset('edge_meta'),
            );

            // Initialize LanceDB under workspace root (rootPath/lance)
            this.#lanceIndex = new LanceIndex({
                rootPath: path.join(this.#rootPath, 'lance'),
                bitmapIndex: this.bitmapIndex,
            });
            await this.#lanceIndex.initialize();
            await this.#lanceIndex.backfill(this.bitmapIndex, this.documents, parseInitializeDocument, 1000);

            await this.#vectors.initialize();

            await this.#semantic.initialize();

            await this.#trees.initialize();

            // One-time heal (not a schema migration — rows are untouched): the
            // pre-write-through REST path (server ≤2.5.51) linked asserted edges
            // directly into the edge plane, leaving them out of their subject
            // rows' data.relations — invisible to rebuildL3 and unretractable
            // by the row-owned delete path. Fold them back in once, then stamp.
            const RELATIONS_BACKFILL_KEY = 'backfill/asserted-relations/v1';
            if (!this.#internalStore.get(RELATIONS_BACKFILL_KEY)) {
                const healed = await this.backfillAssertedRelations();
                if (healed.patched || healed.orphaned) {
                    debug(`start: asserted-relations backfill patched ${healed.patched}, orphaned ${healed.orphaned}`);
                }
                await this.#internalStore.put(RELATIONS_BACKFILL_KEY, new Date().toISOString());
            }

            // Set status
            this.#status = 'running';

            this.#emitEvent(EVENTS.STARTED, createEvent(EVENTS.STARTED));
            debug('SynapsD started');
        } catch (error) {
            this.#status = 'error';
            debug('SynapsD database error during startup: ', error);
            throw error;
        }
    }

    async listTrees(type = null) {
        return this.#trees.listTrees(type);
    }

    getTree(nameOrId) {
        return this.#trees.getTree(nameOrId);
    }

    getDefaultContextTree() {
        return this.#trees.getDefaultContextTree();
    }

    getDefaultDirectoryTree() {
        return this.#trees.getDefaultDirectoryTree();
    }

    async createTree(name, type = 'context', options = {}) {
        return this.#trees.createTree(name, type, options);
    }

    async deleteTree(nameOrId) {
        return this.#trees.deleteTree(nameOrId);
    }

    async renameTree(nameOrId, newName) {
        return this.#trees.renameTree(nameOrId, newName);
    }

    getTreePaths(nameOrId) {
        return this.#trees.getTreePaths(nameOrId);
    }

    getTreeJson(nameOrId) {
        return this.#trees.getTreeJson(nameOrId);
    }

    async stop() { return this.shutdown(); }

    async shutdown() {
        debug('Shutting down SynapsD');
        try {
            this.#status = 'shutting down';
            this.#emitEvent(EVENTS.BEFORE_SHUTDOWN, createEvent(EVENTS.BEFORE_SHUTDOWN));
            // Close index backends
            // LanceDB uses filesystem-based storage; no explicit close needed.
            // No embedding worker to tear down — embedding lives in the external
            // embedd service, which the server stops separately.
            // Close database backend
            await this.#db.close();

            this.#status = 'shutdown';
            this.#emitEvent(EVENTS.SHUTDOWN, createEvent(EVENTS.SHUTDOWN));

            debug('SynapsD database closed');
        } catch (error) {
            this.#status = 'error';
            debug('SynapsD database error during shutdown: ', error);
            throw error;
        }
    }

    async restart() {
        await this.stop();
        await this.start();
    }

    isRunning() { return this.#status === 'running'; }

    /**
     * Schema methods
     */

    getSchema(schemaId) { return schemaRegistry.getSchema(schemaId); }
    getDataSchema(schemaId) { return schemaRegistry.getDataSchema(schemaId); }
    getJsonSchema(schemaId) { return schemaRegistry.getJsonSchema(schemaId); }
    hasSchema(schemaId) { return schemaRegistry.hasSchema(schemaId); }
    listSchemas(prefix = null) { return schemaRegistry.listSchemas(prefix); }

    /**
     * Validation methods
     */

    // TODO: Remove, we either should initialize the doc here or just dont use it
    // as we already have 2 other methods for validation that are more specific
    validateDocument(document) {
        if (isDocumentInstance(document)) {
            return this.validateDocumentInstance(document);
        } else if (isDocumentData(document)) {
            return this.validateDocumentData(document);
        } else {
            throw new Error('Invalid document: must be a document instance or valid document data');
        }
    }

    validateDocumentInstance(document) {
        return document.validate();
    }

    validateDocumentData(document) {
        if (!document || typeof document !== 'object') {
            debug('Document is not an object');
            return false;
        }

        if (!document.schema) {
            debug('Document does not have a schema property');
            return false;
        }

        if (!document.data) {
            debug('Document does not have a data property');
            return false;
        }

        if (!this.hasSchema(document.schema)) {
            debug(`Schema ${document.schema} not found`);
            return false;
        }

        const SchemaClass = this.getSchema(document.schema);
        return SchemaClass.validateData(document);
    }

    /**
     * CRUD methods
     */

    async get(id, options = { parse: true }) {
        if (!id) { throw new Error('Document id required'); }
        return await this.#getById(id, options);
    }

    /** Typed "you named an id that is not here" error — transports map the
     *  code to 404 rather than a generic 500. */
    static #documentNotFound(id) {
        const error = new Error(`Document with ID "${id}" not found`);
        error.code = 'ENODOCUMENT';
        return error;
    }

    async put(document, spec = {}) {
        return this.#writes.withWriteLock(() => this.#put(document, spec));
    }

    async #put(document, spec = {}) {
        const normSpec = this.#normalizeDocumentOperationSpec(spec);

        if (!document || typeof document !== 'object' || Array.isArray(document)) {
            throw new Error('Document object is required');
        }

        // A supplied id names the document the caller means to write. If it is
        // gone, falling through to insert would mint a DIFFERENT id and answer
        // as though the update succeeded — "update 42" silently becomes
        // "created 137", and the caller has no way to tell. Content-addressed
        // dedup remains the path for id-less writes (that is what makes a
        // re-import of the same bytes resolve to one document); naming an id
        // that does not exist is an error.
        if (document.id !== undefined && document.id !== null) {
            const existing = await this.#getById(document.id).catch(() => null);
            if (existing) {
                return await this.#updateOne(document.id, document, normSpec);
            }
            throw SynapsD.#documentNotFound(document.id);
        }

        return await this.#putOne(document, normSpec);
    }

    async link(idOrIds, spec = {}) {
        return this.#writes.withWriteLock(() => this.#link(idOrIds, spec));
    }

    async #link(idOrIds, spec = {}) {
        if (Array.isArray(idOrIds)) {
            return await this.#linkMany(idOrIds, spec);
        }
        if (!idOrIds) { throw new Error('Document id required'); }
        return await this.#linkOne(idOrIds, this.#normalizeDocumentOperationSpec(spec));
    }

    async has(id, spec = {}) {
        if (!id) { throw new Error('Document id required'); }
        return await this.#hasOne(id, this.#normalizeDocumentOperationSpec(spec));
    }

    /**
     * Create a DERIVED typed edge between two documents (extractor/agent
     * output). `meta.src` is REQUIRED: the only writer of asserted edges is
     * `#syncDocumentRelations`, deriving them from a row's `data.relations` —
     * so the L3 rebuild invariant (replay rows + re-run extractors == complete
     * edge plane) holds by construction. Asserted relations go through
     * `assertRelation()` instead.
     *
     * This is the DOCUMENT-AWARE facade over `this.edges` (EdgeIndex), which is
     * deliberately document-unaware. Membership inheritance is exactly the kind
     * of row-shaped concern that must not leak into the graph layer, so it
     * lives here.
     *
     * @param {number} fromId
     * @param {string} predicate see indexes/edges/predicates.js
     * @param {number} toId
     * @param {{inheritMemberships?: boolean, meta: {src:string, conf?:number}}} options
     */
    async relate(fromId, predicate, toId, options = {}) {
        return this.#writes.withWriteLock(() => this.#relate(fromId, predicate, toId, options));
    }

    async #relate(fromId, predicate, toId, options = {}) {
        if (!options.meta?.src) {
            throw new Error(
                'relate() writes DERIVED edges and requires meta.src (e.g. "extractor:foo"); ' +
                'asserted relations are document-owned — use assertRelation()',
            );
        }
        this.#edges.link(fromId, predicate, toId, options.meta);

        if (options.inheritMemberships) {
            await this.#synapses.createSynapsesFromDocs(Number(toId), [Number(fromId)]);
        }
        return true;
    }

    /**
     * Remove a DERIVED typed edge (both mirrors + meta). Refuses asserted
     * edges: those are owned by the subject row's `data.relations`, and
     * removing the edge alone would leave the row claiming a relationship the
     * graph no longer has — drift that only a rebuild would surface.
     */
    async unrelate(fromId, predicate, toId) {
        return this.#writes.withWriteLock(() => this.#unrelate(fromId, predicate, toId));
    }

    async #unrelate(fromId, predicate, toId) {
        const existing = this.#edges.edge(fromId, predicate, toId);
        if (existing && existing.meta?.src === 'doc') {
            throw new Error(
                `Edge ${fromId} --${predicate}--> ${toId} is asserted (owned by the document's ` +
                'data.relations) — use retractRelation() instead of unrelate()',
            );
        }
        return this.#edges.unlink(fromId, predicate, toId);
    }

    /**
     * Assert a relation by writing it through the SUBJECT document's own
     * `data.relations`, then deriving the edge — the row stays the source of
     * truth and `rebuildL3()` can always reconstruct the edge plane. This is
     * the write path for user/API-drawn relations (the REST relations
     * endpoint).
     *
     * The target may not exist yet (dangling `to` ids are allowed by design —
     * query-time candidate intersection filters them); callers that want a
     * hard existence guarantee check before calling.
     *
     * @param {number} docId subject document (edge source)
     * @param {string} predicate see indexes/edges/predicates.js
     * @param {number} toId edge target
     * @returns {boolean} true if the relation was added, false if it was
     *          already present (no-op, nothing written)
     */
    async assertRelation(docId, predicate, toId) {
        return this.#writes.withWriteLock(() => this.#writeAssertedRelation(docId, predicate, toId, 'assert'));
    }

    /**
     * Retract an asserted relation: remove it from the subject document's
     * `data.relations` and drop the derived edge. Derived (extractor/agent)
     * edges between the same pair are untouched — they are not the row's to
     * delete.
     *
     * @returns {boolean} true if the relation was removed, false if the
     *          document does not declare it (or the document no longer exists —
     *          its edges died with it in deleteNode)
     */
    async retractRelation(docId, predicate, toId) {
        return this.#writes.withWriteLock(() => this.#writeAssertedRelation(docId, predicate, toId, 'retract'));
    }

    // Incoming asserted edges are owned by the SURVIVING subject row. deleteNode
    // drops the index entries, but a later rebuildL3 would replay those rows and
    // resurrect the edge. Retract first. Derived incoming (extractor/agent) has
    // no row claim and dies in deleteNode alone.
    async #retractIncomingAssertedRelations(deletedId, skipIds) {
        const { incoming } = this.#edges.edgesOf(deletedId);
        for (const { p, from } of incoming) {
            if (skipIds?.has(from)) { continue; }
            const existing = this.#edges.edge(from, p, deletedId);
            if (!existing || existing.meta?.src !== 'doc') { continue; }
            await this.#writeAssertedRelation(from, p, deletedId, 'retract');
        }
    }

    async #writeAssertedRelation(docIdentifier, predicate, toIdentifier, op) {
        const docId = Number(docIdentifier);
        if (!Number.isInteger(docId) || docId <= 0) { throw new Error(`Invalid document id: ${docIdentifier}`); }
        const to = Number(toIdentifier);
        if (!Number.isInteger(to) || to <= 0) { throw new Error(`Invalid relation target id: ${toIdentifier}`); }
        predicateId(predicate); // throws on unknown and inverse-style names

        const storedDocument = await this.#getById(docId);
        if (!storedDocument) {
            if (op === 'retract') { return false; } // doc gone → its edges died in deleteNode
            throw new Error(`Document with ID "${docId}" not found`);
        }

        const previous = documentRelations(storedDocument);
        const key = relationKey({ p: predicate, to });
        const present = previous.some((r) => relationKey(r) === key);
        if (op === 'assert' ? present : !present) { return false; }

        const current = op === 'assert'
            ? [...previous, { p: predicate, to }]
            : previous.filter((r) => relationKey(r) !== key);

        // Relations are structural, not content (NON_CONTENT_DATA_KEYS): the
        // checksum/FTS/embedding projections all strip them via contentData(),
        // so this write needs none of #updateOne's identity churn — just the
        // row, the crud:updated timeline, and the edge diff.
        storedDocument.data = { ...storedDocument.data };
        if (current.length > 0) { storedDocument.data.relations = current; }
        else { delete storedDocument.data.relations; }
        storedDocument.updatedAt = new Date().toISOString();

        await this.documents.put(docId, storedDocument);
        await this.#timelineIndex.insert('crud:updated', docId, storedDocument.updatedAt);
        this.#derived.syncDocumentRelations(docId, previous, current);

        this.#emitEvent(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, {
            id: docId, document: storedDocument, reason: 'relations',
        }));
        return true;
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
        for (const edge of this.#edges.allEdges()) {
            if (edge.meta?.src === 'doc') { asserted.push(edge); }
        }

        let patched = 0;
        let orphaned = 0;
        for (const { from, p, to } of asserted) {
            const doc = await this.#getById(from);
            if (!doc) { orphaned++; continue; }
            if (await this.assertRelation(from, p, to)) { patched++; }
        }

        debug(`backfillAssertedRelations: scanned ${asserted.length} asserted edges, patched ${patched}, orphaned ${orphaned}`);
        return { scanned: asserted.length, patched, orphaned };
    }

    async unlink(idOrIds, spec = {}) {
        return this.#writes.withWriteLock(() => this.#unlink(idOrIds, spec));
    }

    async #unlink(idOrIds, spec = {}) {
        if (Array.isArray(idOrIds)) {
            return await this.#unlinkMany(idOrIds, spec);
        }
        if (!idOrIds) { throw new Error('Document id required'); }
        // `spec` is the OPTIONS argument (4th), not the feature array (3rd) —
        // features are unwrapped from the normalized spec inside. Passing it
        // third silently dropped `recursive`, so unlink(id, { recursive:true })
        // unticked only the leaf layer while unlinkMany([id], …) honoured it.
        return await this.#unlinkOne(idOrIds, this.#normalizeDocumentOperationSpec(spec), [], spec);
    }

    async delete(id, options = {}) {
        return this.#writes.withWriteLock(() => this.#delete(id, options));
    }

    async #delete(id, options = {}) {
        if (!id) { throw new Error('Document id required'); }
        return await this.#deleteOne(id, options);
    }

    async putMany(documents, spec = {}) {
        return this.#writes.withWriteLock(() => this.#putMany(documents, spec));
    }

    async #putMany(documents, spec = {}) {
        const skipLance = spec.skipLance === true;
        const deferredLanceBuffer = spec.deferredLanceBuffer;

        const normSpec = this.#normalizeDocumentOperationSpec(spec);
        if (!Array.isArray(documents)) {
            throw new Error('Document array must be an array');
        }
        if (documents.length === 0) { return []; }

        debug(`putMany: Attempting to store ${documents.length} documents`);

        // ── Phase 1: Parse, validate, dedup ──────────────────────────────

        const contextSpec = normSpec.context ?? null;
        const directorySpec = normSpec.directory ?? null;

        const featureBitmaps = parseBitmapArray(normSpec.features);
        const prepared = [];
        // In-batch content dedup: two identical files in one batch both miss the
        // checksum lookup (nothing is written until phase 2), so without this they
        // fork into two docs and the checksum index keeps only the last id —
        // corrupting the one-blob-one-doc model. Keyed by primary checksum.
        const batchByChecksum = new Map();

        for (let i = 0; i < documents.length; i++) {
            try {
                const doc = documents[i];

                let parsed;
                let existing = null;
                let isUpdate = false;
                let previous = null;

                // Dedup priority: a supplied id is an UPDATE of exactly that
                // document — the id is the stable key every bitmap/timeline/
                // checksum reference hangs off, so it must be preserved (no new
                // id minted), and an id that resolves to nothing is an error
                // rather than a silent insert. Content-addressed (checksum)
                // dedup is the path for ID-LESS writes, which is what makes a
                // re-import of the same content resolve to one document.
                // Ids are integers; a numeric-string id is normalized before
                // lookup so the update path resolves and the id is preserved.
                const suppliedId = (doc && doc.id !== undefined && doc.id !== null)
                    ? (typeof doc.id === 'string' ? parseInt(doc.id, 10) : doc.id)
                    : null;
                if (suppliedId !== null) {
                    existing = Number.isNaN(suppliedId)
                        ? null
                        : await this.#getById(suppliedId).catch(() => null);
                    if (existing) {
                        isUpdate = true;
                        // Snapshot previous state BEFORE update() mutates in place,
                        // so stale checksums/timelines/device tags can be cleaned.
                        previous = snapshotDocument(existing);
                        // Merge input onto existing (preserves locations, metadata,
                        // parentId chain; regenerates checksums when data changed).
                        parsed = existing.update(doc);
                        // update() trusts data.id verbatim (and returns the same
                        // mutated instance) — re-assert the canonical numeric id
                        // so a string-coerced input can't fork the storage key.
                        parsed.id = suppliedId;
                    } else {
                        // Same rule as put(): a named id that is not here is an
                        // error, never a silent insert under a fresh id.
                        throw SynapsD.#documentNotFound(doc.id);
                    }
                }

                if (!parsed) {
                    parsed = isDocumentInstance(doc) ? doc : parseInitializeDocument(doc);
                    parsed.validateData();

                    const primaryChecksum = parsed.getPrimaryChecksum();
                    existing = await this.getByChecksumString(primaryChecksum, { parse: true, schema: parsed.schema }).catch(() => null);
                    if (existing) {
                        parsed.id = existing.id;
                        mergeDedupePreservedFields(parsed, existing);
                        if (existing.createdAt) { parsed.createdAt = existing.createdAt; }
                        if (existing.updatedAt) { parsed.updatedAt = existing.updatedAt; }
                        previous = snapshotDocument(existing);
                    }
                }

                // In-batch dedup (content-addressed only; explicit id-updates are
                // intentional and never folded). Merge this doc's locations into
                // the earlier identical entry instead of minting a second doc.
                if (!isUpdate) {
                    const primaryChecksum = parsed.getPrimaryChecksum();
                    if (primaryChecksum) {
                        const dup = batchByChecksum.get(primaryChecksum);
                        if (dup) {
                            mergeDocumentLocations(dup.parsed, parsed.locations);
                            continue;
                        }
                    }
                }

                // Per-doc declarative features unioned with the batch-level list
                // (which applies to every doc) — this is what lets one putMany
                // batch carry different tags per document.
                const docFeatures = [...featureBitmaps];
                for (const key of documentFeatureKeys(parsed)) {
                    if (!docFeatures.includes(key)) { docFeatures.push(key); }
                }
                for (const key of schemaBitmapKeys(parsed)) {
                    if (!docFeatures.includes(key)) { docFeatures.push(key); }
                }

                validateDocumentRelations(parsed);

                const entry = { parsed, existing: !!existing, isUpdate, previous, docFeatures };
                prepared.push(entry);
                if (!isUpdate) {
                    const primaryChecksum = parsed.getPrimaryChecksum();
                    if (primaryChecksum) { batchByChecksum.set(primaryChecksum, entry); }
                }
            } catch (error) {
                const contextualError = new Error(`Failed to prepare document at index ${i}: ${error.message}`);
                contextualError.cause = error;
                contextualError.failedItem = documents[i];
                contextualError.failedIndex = i;
                throw contextualError;
            }
        }

        // Batch-generate IDs for new documents in one transaction
        const newDocs = prepared.filter(p => !p.existing);
        if (newDocs.length > 0) {
            const ids = this.#allocateDocumentIDs(newDocs.length);
            for (let i = 0; i < newDocs.length; i++) {
                newDocs[i].parsed.id = ids[i];
            }
        }

        // Validate all (now that IDs are assigned)
        for (let i = 0; i < prepared.length; i++) {
            try {
                prepared[i].parsed.validate();
            } catch (error) {
                const contextualError = new Error(`Validation failed for document at index ${i}: ${error.message}`);
                contextualError.cause = error;
                contextualError.failedIndex = i;
                throw contextualError;
            }
        }

        // ── Phase 2: Batch write ─────────────────────────────────────────

        try {
            await this.#writes.withDeferredMembership(async () => {
                await this.bitmapIndex.tick(this.allDocumentsBitmap.key, prepared.map((p) => p.parsed.id));
                for (const { parsed, existing, isUpdate, previous, docFeatures } of prepared) {
                    await this.documents.put(parsed.id, parsed);

                    // Features this write dropped from the document — untick, or a
                    // removed tag would linger in its bitmap forever. Snapshot was
                    // taken before update() mutated `existing` in place.
                    const staleFeatureKeys = (previous?.featureKeys || []).filter((k) => !docFeatures.includes(k));
                    if (staleFeatureKeys.length) { await this.#writes.applyMembership('untick', parsed.id, staleFeatureKeys); }

                    // Re-point the checksum index: drop checksums the edit dropped
                    // (empty diff for checksum-matched re-indexes), insert current.
                    if (existing && previous?.checksums) {
                        const staleChecksums = previous?.checksums.filter(c => !parsed.checksumArray.includes(c));
                        if (staleChecksums.length) {await this.#checksumIndex.deleteArray(staleChecksums);}
                    }
                    await this.#checksumIndex.insertArray(parsed.checksumArray, parsed.id);

                    // crud:created only for genuinely new docs; updates keep their createdAt
                    if (!isUpdate) {
                        await this.#timelineIndex.insert('crud:created', parsed.id, parsed.createdAt || new Date());
                    }
                    if (parsed.updatedAt) {await this.#timelineIndex.insert('crud:updated', parsed.id, parsed.updatedAt);}
                    if (existing && previous) {await this.#derived.removeDocumentTimelines(parsed.id, previous, parsed);}
                    await this.#derived.indexDocumentTimelines(parsed.id, parsed);
                    await this.#derived.indexDocumentGeo(parsed.id, parsed);
                    this.#derived.syncDocumentRelations(parsed.id, previous?.relations, documentRelations(parsed));
                    await this.#derived.indexDocument(parsed.id, contextSpec, directorySpec, docFeatures);
                    if (existing) {
                        await this.#derived.removeStaleLocationMembership(parsed.id, { locations: previous?.locations, orphanedAt: previous?.orphanedAt }, parsed, docFeatures);
                    }
                    await this.#writes.applyMembership(parsed.hasComment ? 'tick' : 'untick', parsed.id, [COMMENT_BITMAP_KEY]);
                    // Facet bitmaps (mime + status): tick current, untick whatever
                    // this batch-update left behind (contentType/status change).
                    const facetKeys = facetBitmapKeys(parsed);
                    const staleFacetKeys = (previous?.facetKeys || []).filter((k) => !facetKeys.includes(k));
                    if (staleFacetKeys.length) { await this.#writes.applyMembership('untick', parsed.id, staleFacetKeys); }
                    if (facetKeys.length) { await this.#writes.applyMembership('tick', parsed.id, facetKeys); }
                }
            });

        } catch (error) {
            throw new Error(`putMany transaction failed: ${error.message}`);
        }

        // ── Phase 3: Lance (best-effort, single batch add) ───────────────

        // Re-index FTS/vectors only for genuinely new or content-changed docs.
        // A membership-only re-tick (same content added to another tree path —
        // e.g. multi-path "Sync To") keeps identical checksums, so its Lance row
        // and embedding already exist. Re-adding them is wasteful and, because
        // phase 3 is awaited, was making each extra path's insert slow enough to
        // blow the client's 10s timeout (only the first path stuck → "order
        // decides the folder").
        const reindexDocs = prepared.filter(p => hasSearchContentChanged(p.previous, p.parsed));

        const needLanceRows = !skipLance || Array.isArray(deferredLanceBuffer);
        const lanceDocs = needLanceRows
            ? reindexDocs.map(({ parsed }) => parseInitializeDocument(parsed))
            : [];
        if (skipLance) {
            if (Array.isArray(deferredLanceBuffer)) {
                deferredLanceBuffer.push(...lanceDocs);
            }
        } else if (lanceDocs.length > 0) {
            try {
                await this.#lanceIndex.addMany(lanceDocs);
            } catch (_) { }
        }

        // ── Phase 3.5: Dense vectors ─────────────────────────────────────
        // Embedding is owned by the external embedd service, driven off the
        // DOCUMENT_INSERTED event below — synapsd no longer enqueues here.

        // ── Phase 4: Events ──────────────────────────────────────────────

        const storedIds = prepared.map(p => p.parsed.id);

        if (storedIds.length > 0) {
            // Emit for whichever tree(s) the docs landed in so cross-client
            // auto-open fires on both context and directory inserts.
            this.#trees.emitDocumentEvent(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, 'context', contextSpec, storedIds);
            this.#trees.emitDocumentEvent(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, 'directory', directorySpec, storedIds);
        }

        // Split inserts from updates so consumers (ws bridge, UIs) can tell an
        // edit from a new document — an in-place update keeps the same id.
        const insertedIds = prepared.filter(p => !p.isUpdate).map(p => p.parsed.id);
        const updatedIds = prepared.filter(p => p.isUpdate).map(p => p.parsed.id);

        if (insertedIds.length > 0) {
            // Singular event with `batch: true` kept for pre-batch consumers
            // (ws bridge, embedd enqueue); the .batch event is the canonical
            // one for batch-aware consumers (workspace hooks).
            this.#emitEvent(EVENTS.DOCUMENT_INSERTED, createEvent(EVENTS.DOCUMENT_INSERTED, {
                ids: insertedIds,
                count: insertedIds.length,
                batch: true,
                context: contextSpec,
                directory: directorySpec,
                reason: 'created',
                ...(normSpec.provenance || {}),
            }));
            this.#emitEvent(EVENTS.DOCUMENT_INSERTED_BATCH, createEvent(EVENTS.DOCUMENT_INSERTED_BATCH, {
                ids: insertedIds,
                count: insertedIds.length,
                context: contextSpec,
                directory: directorySpec,
                reason: 'created',
                ...(normSpec.provenance || {}),
            }));
        }
        if (updatedIds.length > 0) {
            this.#emitEvent(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, {
                ids: updatedIds,
                count: updatedIds.length,
                batch: true,
                reason: 'content',
                ...(normSpec.provenance || {}),
            }));
            this.#emitEvent(EVENTS.DOCUMENT_UPDATED_BATCH, createEvent(EVENTS.DOCUMENT_UPDATED_BATCH, {
                ids: updatedIds,
                count: updatedIds.length,
                context: contextSpec,
                directory: directorySpec,
                reason: 'content',
                ...(normSpec.provenance || {}),
            }));
        }

        return storedIds;
    }

    /** Append parsed documents to the Lance FTS table (same payload as putMany phase 3). */
    async indexDocumentsInLance(documents) {
        if (!documents?.length) { return; }
        try {
            await this.#lanceIndex.addMany(documents);
        } catch (_) { }
    }

    async optimizeLance() {
        return await this.#lanceIndex.optimize();
    }

    /**
     * Optimize dense-vector spaces: compact fragments, prune old versions, and
     * (re)build the ANN index. Pass a space name ('text'|'image') to optimize just
     * that Lance table; omit to optimize every configured space. Best-effort per
     * space — safe to call after a bulk import/re-embed. Returns { <space>: stats }.
     */
    async optimizeVectors(space = null) {
        return this.#vectors.optimizeVectors(space);
    }


    /**
     * Every dense-vector table in this workspace's Lance store, with the spaces
     * currently bound to them. Model-keyed tables (`vec_<space>__<slug>__<dim>`)
     * left behind by a model swap show up here as `active: false` — they still
     * hold their vectors (that is the point: switching back is free), and this is
     * how an operator finds the ones worth reclaiming.
     */
    async listVectorTables() {
        return this.#vectors.listVectorTables();
    }

    /**
     * Drop a superseded model's vectors: the Lance table plus the presence/seen
     * bitmaps derived from its name. Refuses a table that a space is currently
     * bound to — dropping the live one is what `clearSpace` is for, and doing it
     * here would silently wipe the vectors search is using.
     * @param {string} name  table name from listVectorTables()
     */
    async dropVectorTable(name) {
        return this.#vectors.dropVectorTable(name);
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
        return this.#vectors.getUnembeddedDocIds(space, schemas);
    }

    /**
     * Wipe an embedding space for a full re-embed: drop its vectors + presence
     * bitmap + seen ledger. After this, getUnembeddedDocIds returns everything.
     * @param {string} space
     */
    async clearSpace(space = 'text') {
        return this.#vectors.clearSpace(space);
    }

    /**
     * Swap the vector spaces at runtime — what a model change needs.
     *
     * Nothing structural pins them: `#getVectorSpace` builds a VectorIndex
     * lazily from `#semanticConfig.spaces` and caches it, so replacing the
     * config and dropping the cache is enough. The old handles are plain
     * references to Lance tables that stay on disk (that is what makes a revert
     * free) and are simply released.
     *
     * The CALLER must quiesce writes first — pause the workspace's embedding
     * queue and let the in-flight batch finish — or a batch can straddle the
     * swap and scatter half its chunks into the outgoing table.
     */
    async setVectorSpaces(spaces = {}) {
        return this.#vectors.setVectorSpaces(spaces);
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
        return this.#vectors.storeDocumentEmbeddings(docId, schema, updatedAt, chunks, opts);
    }

    /**
     * Same as repeated putMany(..., { tree, path }) per path, but one LMDB transaction + one bitmap flush.
     * items: [{ document, path: directoryPath }]
     */
    async putManyDirectoryPaths(items, treeName, featureArray = [], options = {}) {
        return this.#writes.withWriteLock(() => this.#putManyDirectoryPaths(items, treeName, featureArray, options));
    }

    async #putManyDirectoryPaths(items, treeName, featureArray = [], options = {}) {
        const skipLance = options.skipLance === true;
        const deferredLanceBuffer = options.deferredLanceBuffer;
        const emitEvent = options.emitEvent !== false;

        if (!Array.isArray(items) || items.length === 0) {
            return [];
        }

        const featureBitmaps = parseBitmapArray(featureArray);

        const prepared = [];
        // In-batch content dedup: identical blobs at different directory paths in
        // one batch would otherwise fork into separate docs (checksum not yet
        // written). Fold them into a single doc linked under every path.
        const batchByChecksum = new Map();

        for (let i = 0; i < items.length; i++) {
            const { document, path: dirPath } = items[i];
            try {
                const parsed = isDocumentInstance(document) ? document : parseInitializeDocument(document);
                parsed.validateData();

                const primaryChecksum = parsed.getPrimaryChecksum();
                const existing = await this.getByChecksumString(primaryChecksum, { parse: true, schema: parsed.schema }).catch(() => null);
                if (existing) {
                    // Already stored — skip re-insertion entirely
                    continue;
                }

                const directorySpec = { tree: treeName, path: dirPath };

                // Fold an earlier identical blob: merge locations + add this path.
                const dup = primaryChecksum ? batchByChecksum.get(primaryChecksum) : null;
                if (dup) {
                    mergeDocumentLocations(dup.parsed, parsed.locations);
                    dup.directorySpecs.push(directorySpec);
                    continue;
                }

                const docFeatures = [...featureBitmaps];
                for (const key of documentFeatureKeys(parsed)) {
                    if (!docFeatures.includes(key)) { docFeatures.push(key); }
                }
                for (const key of schemaBitmapKeys(parsed)) {
                    if (!docFeatures.includes(key)) { docFeatures.push(key); }
                }

                const entry = { parsed, docFeatures, directorySpecs: [directorySpec] };
                prepared.push(entry);
                if (primaryChecksum) { batchByChecksum.set(primaryChecksum, entry); }
            } catch (error) {
                const contextualError = new Error(`Failed to prepare document at index ${i}: ${error.message}`);
                contextualError.cause = error;
                throw contextualError;
            }
        }

        if (prepared.length === 0) { return []; }

        const ids = this.#allocateDocumentIDs(prepared.length);
        for (let i = 0; i < prepared.length; i++) {
            prepared[i].parsed.id = ids[i];
        }

        for (let i = 0; i < prepared.length; i++) {
            prepared[i].parsed.validate();
        }

        try {
            await this.#writes.withDeferredMembership(async () => {
                await this.bitmapIndex.tick(this.allDocumentsBitmap.key, prepared.map((p) => p.parsed.id));
                for (const { parsed, docFeatures, directorySpecs } of prepared) {
                    await this.documents.put(parsed.id, parsed);
                    await this.#checksumIndex.insertArray(parsed.checksumArray, parsed.id);
                    await this.#timelineIndex.insert('crud:created', parsed.id, parsed.createdAt || new Date());
                    if (parsed.updatedAt) {await this.#timelineIndex.insert('crud:updated', parsed.id, parsed.updatedAt);}
                    await this.#derived.indexDocumentTimelines(parsed.id, parsed);
                    await this.#derived.indexDocumentGeo(parsed.id, parsed);
                    // One doc can be linked under multiple directory paths (folded dups).
                    for (const directorySpec of directorySpecs) {
                        await this.#derived.indexDocument(parsed.id, null, directorySpec, docFeatures);
                    }
                }
            });
        } catch (error) {
            throw new Error(`putManyDirectoryPaths transaction failed: ${error.message}`);
        }

        const needLanceRows = !skipLance || Array.isArray(deferredLanceBuffer);
        const lanceDocs = needLanceRows
            ? prepared.map(({ parsed }) => parseInitializeDocument(parsed))
            : [];
        if (skipLance) {
            if (Array.isArray(deferredLanceBuffer)) {
                deferredLanceBuffer.push(...lanceDocs);
            }
        } else {
            try {
                await this.#lanceIndex.addMany(lanceDocs);
            } catch (_) { }
        }

        const storedIds = prepared.map(p => p.parsed.id);

        if (emitEvent) {
            const directoryPaths = [...new Set(prepared.flatMap(p => p.directorySpecs.map(d => d?.path)).filter(Boolean))];
            this.#emitEvent(EVENTS.DOCUMENT_INSERTED, createEvent(EVENTS.DOCUMENT_INSERTED, {
                ids: storedIds,
                count: storedIds.length,
                batch: true,
                directory: { tree: prepared[0]?.directorySpecs[0]?.tree, paths: directoryPaths },
                reason: 'created',
            }));
        }

        return storedIds;
    }

    async linkMany(ids, spec = {}) {
        return this.#writes.withWriteLock(() => this.#linkMany(ids, spec));
    }

    async #linkMany(ids, spec = {}) {
        const normSpec = this.#normalizeDocumentOperationSpec(spec);
        if (!Array.isArray(ids)) {
            throw new Error('Document ID array must be an array');
        }

        const result = {
            successful: [],
            failed: [],
            count: ids.length,
        };

        // Validate IDs upfront
        const validEntries = [];
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (typeof id !== 'number') {
                result.failed.push({ index: i, id, error: 'Invalid document ID: Must be a number.' });
            } else {
                validEntries.push({ index: i, id });
            }
        }

        if (validEntries.length === 0) { return result; }

        // Resolve spec fields once (same for all docs in this batch)
        const contextSpec = normSpec.context ?? null;
        const directorySpec = normSpec.directory ?? null;
        const featureBitmaps = parseBitmapArray(normSpec.features);

        // Batch-fetch all documents at once
        const validIds = validEntries.map(e => e.id);
        const rawDocs = await this.documents.getMany(validIds);

        const toProcess = [];
        for (let i = 0; i < validEntries.length; i++) {
            const { index, id } = validEntries[i];
            const docData = rawDocs[i];
            if (!docData) {
                result.failed.push({ index, id, error: `Document with ID "${id}" not found` });
                continue;
            }
            const doc = parseInitializeDocument(docData);
            const docFeatures = [...featureBitmaps];
            for (const key of documentFeatureKeys(doc)) {
                if (!docFeatures.includes(key)) { docFeatures.push(key); }
            }
            for (const key of schemaBitmapKeys(doc)) {
                if (!docFeatures.includes(key)) { docFeatures.push(key); }
            }
            toProcess.push({ index, id, docFeatures });
        }

        if (toProcess.length === 0) { return result; }

        // Single transaction for all index operations
        try {
            await this.#writes.withDeferredMembership(async () => {
                for (const { id, docFeatures } of toProcess) {
                    await this.#derived.indexDocument(id, contextSpec, directorySpec, docFeatures);
                }
            });
        } catch (error) {
            for (const { index, id } of toProcess) {
                result.failed.push({ index, id, error: error.message || 'Transaction failed' });
            }
            return result;
        }

        for (const { index, id } of toProcess) {
            result.successful.push({ index, id });
        }

        // One event per op, not per document: a lone doc gets a single event,
        // many docs collapse into batch events. Linking a folder of 1300 docs
        // otherwise emitted ~2600 socket messages and froze the browser.
        try {
            const ids = toProcess.map((e) => e.id);
            const delta = membershipDelta(
                { context: contextSpec, directory: directorySpec },
                { memberships: { context: contextSpec, directory: directorySpec } },
            );
            const shared = { ...delta, reason: 'membership', ...(normSpec.provenance || {}) };

            // DEPRECATED membership-only alias (see #linkOne).
            if (ids.length === 1) {
                this.#emitEvent(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, { id: ids[0], ...shared }));
            } else if (ids.length > 1) {
                this.#emitEvent(EVENTS.DOCUMENT_UPDATED_BATCH, createEvent(EVENTS.DOCUMENT_UPDATED_BATCH, { ids, ...shared }));
            }

            // First-class membership events. A lone document gets the singular
            // form WITH its document — same contract as #linkOne, one read —
            // so a rule matching on content behaves identically whether the
            // caller went through link() or linkMany([one]). Bulk links stay
            // id-only: loading 1000 documents to serve consumers that may not
            // want them is the cost this whole event family avoids, and the
            // consumer that does want them hydrates per document on fan-out.
            if (ids.length === 1) {
                const linkedData = await this.documents.get(ids[0]);
                const linkedDocument = linkedData ? parseDocumentData(linkedData) : null;
                if (linkedDocument) {
                    this.#emitEvent(EVENTS.DOCUMENT_LINKED, createEvent(EVENTS.DOCUMENT_LINKED, {
                        id: ids[0], document: linkedDocument, ...shared,
                    }));
                }
            } else if (ids.length > 1) {
                this.#emitEvent(EVENTS.DOCUMENT_LINKED_BATCH, createEvent(EVENTS.DOCUMENT_LINKED_BATCH, {
                    ids, count: ids.length, ...shared,
                }));
            }

            // Tree-scoped events drive the web UI content refresh + browser
            // extension. Batch helper handles the single/none cases internally.
            this.#trees.emitDocumentEvent(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, 'context', contextSpec, ids);
            this.#trees.emitDocumentEvent(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, 'directory', directorySpec, ids);
        } catch (eventError) {
            debug(`linkMany: Failed to emit events: ${eventError.message}`);
        }

        return result;
    }

    async unlinkMany(ids, spec = {}) {
        return this.#writes.withWriteLock(() => this.#unlinkMany(ids, spec));
    }

    async #unlinkMany(ids, spec = {}) {
        const normSpec = this.#normalizeDocumentOperationSpec(spec);
        // `recursive` rides in on the spec (Workspace.unlinkMany spreads its options
        // into the spec). There is no separate `options` param here.
        const recursive = Boolean(spec.recursive);
        if (!Array.isArray(ids)) {
            throw new Error('Document ID array must be an array');
        }

        const result = {
            successful: [],
            failed: [],
            count: ids.length,
        };

        // Validate IDs upfront
        const validEntries = [];
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (typeof id !== 'number') {
                result.failed.push({ index: i, id, error: 'Invalid document ID: Must be a number.' });
            } else {
                validEntries.push({ index: i, id });
            }
        }

        if (validEntries.length === 0) { return result; }

        // Resolve layers to remove from spec once (same for all docs in this batch)
        const contextSpec = normSpec.context ?? null;
        const directorySpec = normSpec.directory ?? null;
        const featureKeys = parseBitmapArray(normSpec.features).filter(Boolean);
        const layersToRemove = [];
        const removedContextPaths = [];
        const removedDirectoryPaths = [];

        if (contextSpec) {
            try {
                const { tree: contextTree, collection: contextCollection, path: normalizedContextSpec } = this.#trees.resolveSelection('context', contextSpec, '/');
                const pathLayersArray = parseContextSpecForInsert(normalizedContextSpec);
                for (const pathLayers of pathLayersArray) {
                    if (pathLayers.length === 1 && pathLayers[0] === '/') {
                        throw new Error('Cannot unlink from root context "/". Unlink a real path or delete the document.');
                    }
                    const filteredLayers = pathLayers.filter((context) => context !== '/');
                    if (filteredLayers.length === 0) {
                        throw new Error('Cannot unlink from root context "/". Unlink a real path or delete the document.');
                    }
                    const targetLayers = recursive
                        ? filteredLayers
                        : [filteredLayers[filteredLayers.length - 1]];
                    const layerIds = contextTree.resolveLayerIds(targetLayers);
                    layersToRemove.push(...layerIds.map((layerId) => contextCollection.makeKey(layerId)));
                    removedContextPaths.push(...SynapsD.#unlinkedContextPaths(filteredLayers, recursive));
                }
            } catch (error) {
                for (const { index, id } of validEntries) {
                    result.failed.push({ index, id, error: error.message });
                }
                return result;
            }
        }

        if (directorySpec) {
            try {
                const { tree: directoryTree, collection: directoryCollection, path: normalizedDirectoryPath } = this.#trees.resolveSelection('directory', directorySpec, '/');
                const directoryPaths = Array.isArray(normalizedDirectoryPath) ? normalizedDirectoryPath : [normalizedDirectoryPath];
                for (const directoryPath of directoryPaths) {
                    const nodeIds = directoryTree.getNodeIdsForPath(directoryPath, { recursive });
                    layersToRemove.push(...nodeIds.map((nodeId) => directoryCollection.makeKey(nodeId)));
                    if (nodeIds.length > 0) {
                        removedDirectoryPaths.push(directoryPath);
                    }
                }
            } catch (error) {
                for (const { index, id } of validEntries) {
                    result.failed.push({ index, id, error: error.message });
                }
                return result;
            }
        }

        layersToRemove.push(...normalizeBitmapKeys(featureKeys));
        const uniqueLayers = Array.from(new Set(layersToRemove));

        // Single transaction for all membership removals
        try {
            await this.#writes.withDeferredMembership(async () => {
                for (const { id } of validEntries) {
                    if (uniqueLayers.length > 0) {
                        await this.#writes.removeDocumentMembership(id, uniqueLayers);
                    }
                }
            });
        } catch (error) {
            for (const { index, id } of validEntries) {
                result.failed.push({ index, id, error: error.message || 'Transaction failed' });
            }
            return result;
        }

        for (const { index, id } of validEntries) {
            result.successful.push({ index, id });
        }

        // One event per op: single for a lone doc, batch otherwise (avoids a
        // socket-emit storm on large bulk removes).
        try {
            const ids = validEntries.map((e) => e.id);
            const shared = {
                ...membershipDelta(
                    { context: removedContextPaths, directory: removedDirectoryPaths, features: featureKeys },
                    {
                        contextArray: removedContextPaths,
                        directoryArray: removedDirectoryPaths,
                        featureArray: featureKeys,
                    },
                ),
                recursive,
                reason: 'membership',
                ...(normSpec.provenance || {}),
            };

            // DEPRECATED membership-only alias (see #unlinkOne).
            if (ids.length === 1) {
                this.#emitEvent(EVENTS.DOCUMENT_REMOVED, createEvent(EVENTS.DOCUMENT_REMOVED, { id: ids[0], ...shared }));
            } else if (ids.length > 1) {
                this.#emitEvent(EVENTS.DOCUMENT_REMOVED_BATCH, createEvent(EVENTS.DOCUMENT_REMOVED_BATCH, { ids, ...shared }));
            }

            // First-class membership events, mirroring linkMany: singular WITH
            // the document for a lone id, id-only batch beyond that.
            if (ids.length === 1) {
                const unlinkedData = await this.documents.get(ids[0]);
                const unlinkedDocument = unlinkedData ? parseDocumentData(unlinkedData) : null;
                if (unlinkedDocument) {
                    this.#emitEvent(EVENTS.DOCUMENT_UNLINKED, createEvent(EVENTS.DOCUMENT_UNLINKED, {
                        id: ids[0], document: unlinkedDocument, ...shared,
                    }));
                }
            } else if (ids.length > 1) {
                this.#emitEvent(EVENTS.DOCUMENT_UNLINKED_BATCH, createEvent(EVENTS.DOCUMENT_UNLINKED_BATCH, {
                    ids, count: ids.length, ...shared,
                }));
            }

            // Tree-scoped events drive cross-client auto-close (browser extension)
            // and web UI refresh — they carry the path + tree id/name the consumers
            // match on. Emit for whichever tree(s) the unlink touched.
            this.#trees.emitDocumentEvent(EVENTS.TREE_DOCUMENT_REMOVED_BATCH, 'context', contextSpec, ids);
            this.#trees.emitDocumentEvent(EVENTS.TREE_DOCUMENT_REMOVED_BATCH, 'directory', directorySpec, ids);
        } catch (eventError) {
            debug(`unlinkMany: Failed to emit events: ${eventError.message}`);
        }

        return result;
    }

    /**
     * Datasets — path-independent ingest provenance (data/dataset/<name>),
     * stamped at ingest via spec.features. Every query intersects with the
     * dataset selection (virtual 'default' = unstamped docs, selected unless
     * deselected); see #resolveParsed. Dataset views are ordinary canvas
     * layers saving data/dataset/* keys in their querySpec features.
     */

    /** List dataset names with document counts. */
    async listDatasets() {
        const keys = await this.bitmapIndex.listBitmaps('data/dataset/');
        const out = [];
        for (const key of keys) {
            const bitmap = await this.bitmapIndex.getBitmap(key, false);
            out.push({ name: key.slice('data/dataset/'.length), key, documentCount: bitmap ? bitmap.size : 0 });
        }
        return out;
    }

    /**
     * Drop a dataset: delete every document stamped with it (unless
     * dropDocuments:false — then only the stamp/bitmap is removed) and remove
     * the protected bitmap. Safe to re-create by simply stamping again.
     * @param {string} name dataset name (or full data/dataset/<name> key)
     * @returns {{name, documentsDeleted, failed}}
     */
    async deleteDataset(name, { dropDocuments = true } = {}) {
        if (!name) { throw new Error('Dataset name required'); }
        const key = normalizeBitmapKey(String(name).startsWith('data/dataset/') ? String(name) : `data/dataset/${name}`);
        const bitmap = await this.bitmapIndex.getBitmap(key, false);
        const ids = bitmap ? bitmap.toArray() : [];
        let documentsDeleted = 0;
        let failed = [];
        if (dropDocuments && ids.length > 0) {
            const result = await this.deleteMany(ids);
            documentsDeleted = result.successful.length;
            failed = result.failed;
        }
        // deleteMany untick paths may have already emptied it; remove regardless.
        await this.bitmapIndex.deleteBitmap(key, { force: true });
        this.#emitEvent('dataset.deleted', createEvent('dataset.deleted', { name: key.slice('data/dataset/'.length), key, documentsDeleted }));
        return { name: key.slice('data/dataset/'.length), documentsDeleted, failed };
    }

    async deleteMany(ids, options = {}) {
        return this.#writes.withWriteLock(() => this.#deleteMany(ids, options));
    }

    async #deleteMany(ids, options = {}) {
        if (!Array.isArray(ids)) {
            throw new Error('Document ID array must be an array');
        }

        const result = {
            successful: [],
            failed: [],
            count: ids.length,
        };

        // Validate IDs upfront
        const validEntries = [];
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (typeof id !== 'number') {
                result.failed.push({ index: i, id, error: 'Invalid document ID: Must be a number.' });
            } else {
                validEntries.push({ index: i, id });
            }
        }

        if (validEntries.length === 0) { return result; }

        // Batch-fetch all documents at once
        const validIds = validEntries.map(e => e.id);
        const rawDocs = await this.documents.getMany(validIds);

        const toDelete = [];
        for (let i = 0; i < validEntries.length; i++) {
            const { index, id } = validEntries[i];
            const docData = rawDocs[i];
            if (!docData) {
                result.failed.push({ index, id, error: 'Document not found or already deleted' });
            } else {
                toDelete.push({ index, id, document: parseDocumentData(docData) });
            }
        }

        if (toDelete.length === 0) { return result; }

        const { emitEvent = true } = options;
        const now = new Date().toISOString();

        // Single transaction for all deletes
        try {
            await this.#writes.withDeferredMembership(async () => {
                const doomed = new Set(toDelete.map(({ id }) => id));
                for (const { id, document } of toDelete) {
                    await this.#retractIncomingAssertedRelations(id, doomed);
                    await this.documents.delete(id);
                    const clearedLayers = await this.#synapses.clearSynapses(id, { syncBitmaps: false });
                    await this.#writes.applyMembership('untick', id, clearedLayers);
                    this.#edges.deleteNode(id);
                    await this.#derived.removeDocumentTimelines(id, document);
                    await this.#timelineIndex.removeFromAll(id);
                    if (await this.#geoIndex.has(id)) { await this.#geoIndex.remove(id); }
                    await this.#checksumIndex.deleteArray(document.checksumArray);
                    // Free-pool admission deferred until after lance cleanup (below).
                    await this.#timelineIndex.insert('crud:deleted', id, document.updatedAt || now);
                }
            });
        } catch (error) {
            for (const { index, id } of toDelete) {
                result.failed.push({ index, id, error: error.message || 'Transaction failed' });
            }
            return result;
        }

        const deletedIds = toDelete.map(({ id }) => id);
        // Live-membership untick is UNCONDITIONAL (unlike free-pool admission
        // below): even if lance cleanup fails and the ids leak, the docs are
        // gone from the store and must leave internal/docs/all.
        try { await this.bitmapIndex.untick(this.allDocumentsBitmap.key, deletedIds); } catch (e) {
            debug(`deleteMany: internal/docs/all untick failed: ${e.message}`);
        }

        // Best-effort Lance cleanup (outside transaction — separate system).
        // Bulk delete is all-or-nothing, so free-pool admission is batch-wide:
        // recycle the ids only if both fts and vector cleanup succeed; otherwise
        // they leak (stay allocated) rather than risk reuse with stale residue.
        let lanceClean = true;
        try {
            lanceClean = await this.#lanceIndex.deleteMany(deletedIds);
        } catch (e) {
            lanceClean = false;
            debug(`deleteMany: Lance deleteMany failed: ${e.message}`);
        }
        if (this.#vectors.openedCount > 0) {
            try {
                for (const vi of this.#vectors.openedIndexes()) {
                    const vecClean = await vi.deleteMany(deletedIds);
                    lanceClean = lanceClean && vecClean;
                }
            } catch (e) {
                lanceClean = false;
                debug(`deleteMany: Vector deleteMany failed: ${e.message}`);
            }
        }

        if (lanceClean) {
            try {
                // Persisting tick (Bitmap.tick is in-memory only); accepts the id array.
                await this.bitmapIndex.tick(this.deletedDocumentsBitmap.key, deletedIds);
                debug(`deleteMany: ${deletedIds.length} ids admitted to free-id pool`);
            } catch (e) {
                debug(`deleteMany: free-pool admission failed (ids leak): ${e.message}`);
            }
        }

        for (const { index, id } of toDelete) {
            result.successful.push({ index, id });
        }

        // One event per op: single for a lone doc, batch otherwise (avoids a
        // socket-emit storm on large purges).
        if (emitEvent && result.successful.length > 0) {
            const ids = result.successful.map((e) => e.id);
            const provenance = this.#normalizeProvenance(options.provenance) || {};
            if (ids.length === 1) {
                this.#emitEvent(EVENTS.DOCUMENT_DELETED, createEvent(EVENTS.DOCUMENT_DELETED, { id: ids[0], reason: 'deleted', ...provenance }));
            } else {
                this.#emitEvent(EVENTS.DOCUMENT_DELETED_BATCH, createEvent(EVENTS.DOCUMENT_DELETED_BATCH, { ids, reason: 'deleted', ...provenance }));
            }
        }

        return result;
    }

    /**
     * Allocate `count` document IDs, reusing freed IDs before minting new ones.
     *
     * `internal/gc/deleted` (this.deletedDocumentsBitmap) is a strict free-id
     * pool: ids land there only after a delete fully cleans (incl. lance). We pop
     * densest-first (minimum()) so reused ids cluster low → best roaring density,
     * then top up the shortfall from the monotonic counter.
     *
     * Pool pop + counter bump + pool persist run in ONE LMDB transactionSync.
     * The datasets share a single env (see LmdbBackend), so the writes commit
     * atomically; and because the callback is fully synchronous, no other async
     * writer can interleave and grab the same freed id (the allocation lock).
     *
     * @param {number} count
     * @returns {number[]} allocated ids (length === count)
     */
    #allocateDocumentIDs(count) {
        if (!Number.isInteger(count) || count <= 0) { return []; }
        const counterKey = 'internal/document-id-counter';
        const pool = this.deletedDocumentsBitmap;

        return this.#internalStore.transactionSync(() => {
            const ids = [];

            // 1. Reuse freed ids, densest-first.
            if (pool) {
                while (ids.length < count && !pool.isEmpty) {
                    const id = pool.minimum();
                    pool.remove(id);
                    ids.push(id);
                }
            }
            const popped = ids.length;

            // 2. Top up the remainder from the monotonic counter.
            const need = count - popped;
            if (need > 0) {
                let currentCounter = this.#internalStore.get(counterKey);
                if (currentCounter === undefined || currentCounter === null) {
                    currentCounter = INTERNAL_BITMAP_ID_MAX;
                }
                const firstId = currentCounter + 1;
                this.#internalStore.putSync(counterKey, currentCounter + need);
                for (let i = 0; i < need; i++) { ids.push(firstId + i); }
            }

            // 3. Persist the shrunken pool in the SAME tx as the counter bump so a
            //    crash can't leave a popped id both reused and still in the pool.
            if (pool && popped > 0) {
                this.bitmapIndex.saveBitmapSync(pool.key, pool);
            }

            return ids;
        });
    }

    async #putOne(document, contextSpec = { path: '/' }, featureBitmapArray = [], emitEvent = true) {
        if (!document) { throw new Error('Document is required'); }

        // Canonical document insert signature accepts a selector/options object.
        let directorySpec = null;
        let provenance = null;
        if (this.#isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            // Preserve an explicit null context (consistent with #updateOne /
            // putMany / link): a directory-only insert into the backends tree should NOT
            // tick the context root — see #resolveDocumentMembershipKeys, which
            // skips root for backends directory paths when contextSpec is falsy.
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
            emitEvent = opts.emitEvent ?? emitEvent;
            provenance = this.#normalizeProvenance(opts.provenance);
        }

        const featureBitmaps = parseBitmapArray(featureBitmapArray);
        const parsedDocument = isDocumentInstance(document) ? document : parseInitializeDocument(document);
        validateDocumentRelations(parsedDocument);
        parsedDocument.validateData();

        // Dedup by checksum
        const primaryChecksum = parsedDocument.getPrimaryChecksum();
        const storedDocument = await this.getByChecksumString(primaryChecksum, { parse: true, schema: parsedDocument.schema });

        if (storedDocument) {
            parsedDocument.id = storedDocument.id;
            mergeDedupePreservedFields(parsedDocument, storedDocument);
            if (storedDocument.createdAt) { parsedDocument.createdAt = storedDocument.createdAt; }
            if (storedDocument.updatedAt) { parsedDocument.updatedAt = storedDocument.updatedAt; }
        } else {
            parsedDocument.id = this.#allocateDocumentIDs(1)[0];
        }

        parsedDocument.validate();

        // The document's own features are declarative — bitmaps follow them, so
        // union them with any caller-supplied ones (tree/insert-time + device
        // tags). Schema is always among them (Document guarantees it); the
        // explicit push covers pre-built Document instances.
        for (const key of documentFeatureKeys(parsedDocument)) {
            if (!featureBitmaps.includes(key)) { featureBitmaps.push(key); }
        }
        for (const key of schemaBitmapKeys(parsedDocument)) {
            if (!featureBitmaps.includes(key)) { featureBitmaps.push(key); }
        }
        // A re-put that drops a feature must untick its bitmap, or removals would
        // never take (same reasoning as the facet keys below). Schema keys are in
        // the diff too, so a subtype the re-put moved away from unticks.
        const staleFeatureKeys = storedDocument
            ? [...documentFeatureKeys(storedDocument), ...schemaBitmapKeys(storedDocument)]
                .filter((k) => !featureBitmaps.includes(k))
            : [];

        try {
            await this.#writes.withDeferredMembership(async () => {
                await this.documents.put(parsedDocument.id, parsedDocument);
                await this.bitmapIndex.tick(this.allDocumentsBitmap.key, parsedDocument.id);
                if (staleFeatureKeys.length) { await this.#writes.applyMembership('untick', parsedDocument.id, staleFeatureKeys); }
                await this.#checksumIndex.insertArray(parsedDocument.checksumArray, parsedDocument.id);
                await this.#timelineIndex.insert('crud:created', parsedDocument.id, parsedDocument.createdAt || new Date());
                if (parsedDocument.updatedAt) {await this.#timelineIndex.insert('crud:updated', parsedDocument.id, parsedDocument.updatedAt);}
                if (storedDocument) {await this.#derived.removeDocumentTimelines(parsedDocument.id, storedDocument, parsedDocument);}
                await this.#derived.indexDocumentTimelines(parsedDocument.id, parsedDocument);
                await this.#derived.indexDocumentGeo(parsedDocument.id, parsedDocument);
                this.#derived.syncDocumentRelations(
                    parsedDocument.id,
                    documentRelations(storedDocument),
                    documentRelations(parsedDocument),
                );
                await this.#derived.indexDocument(parsedDocument.id, contextSpec, directorySpec, featureBitmaps);
                if (storedDocument) {
                    await this.#derived.removeStaleLocationMembership(parsedDocument.id, storedDocument, parsedDocument, featureBitmaps);
                }
                await this.#writes.applyMembership(parsedDocument.hasComment ? 'tick' : 'untick', parsedDocument.id, [COMMENT_BITMAP_KEY]);
                // Facet bitmaps (mime + status): tick current, untick stale from
                // the pre-write doc state when this put replaced an existing doc.
                const facetKeys = facetBitmapKeys(parsedDocument);
                const staleFacetKeys = storedDocument
                    ? facetBitmapKeys(storedDocument).filter((k) => !facetKeys.includes(k))
                    : [];
                if (staleFacetKeys.length) { await this.#writes.applyMembership('untick', parsedDocument.id, staleFacetKeys); }
                if (facetKeys.length) { await this.#writes.applyMembership('tick', parsedDocument.id, facetKeys); }
            });
        } catch (error) {
            throw new Error('Error inserting document atomically: ' + error.message);
        }

        // Best-effort Lance upsert
        try { await this.#lanceIndex.upsert(parseInitializeDocument(parsedDocument)); } catch (_) { }

        if (emitEvent) {
            const { tree: contextTree } = this.#trees.resolveSelection('context', contextSpec, '/');
            contextTree.emit(EVENTS.TREE_DOCUMENT_INSERTED, createEvent(EVENTS.TREE_DOCUMENT_INSERTED, {
                documentId: parsedDocument.id,
                contextSpec,
                directorySpec,
                source: 'tree',
            }));
            this.#emitEvent(EVENTS.DOCUMENT_INSERTED, createEvent(EVENTS.DOCUMENT_INSERTED, {
                id: parsedDocument.id,
                document: parsedDocument,
                context: contextSpec,
                directory: directorySpec,
                reason: 'created',
                ...(provenance || {}),
            }));
        }

        return parsedDocument.id;
    }

    async #linkOne(docId, contextSpec = { path: '/' }, featureBitmapArray = [], emitEvent = true) {
        if (!docId) { throw new Error('Document id required'); }

        let directorySpec = null;
        let provenance = null;
        if (this.#isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
            emitEvent = opts.emitEvent ?? emitEvent;
            provenance = this.#normalizeProvenance(opts.provenance);
        }

        const numericId = typeof docId === 'string' ? parseInt(docId, 10) : docId;
        if (!Number.isInteger(numericId)) {
            throw new Error('Document identifier must be a numeric ID');
        }

        const storedDocument = await this.#getById(numericId);
        if (!storedDocument) {
            throw new Error(`Document with ID "${numericId}" not found`);
        }

        const featureBitmaps = parseBitmapArray(featureBitmapArray).filter(Boolean);
        // What the CALLER asked to tick, before the schema keys the engine
        // re-ticks on every link are folded in. Those keys are not a delta —
        // the document already had them — so they belong in the write path,
        // not in an event that says "here is what changed".
        const requestedFeatures = [...featureBitmaps];
        for (const key of schemaBitmapKeys(storedDocument)) {
            if (!featureBitmaps.includes(key)) { featureBitmaps.push(key); }
        }

        await this.#writes.withDeferredMembership(async () => {
            await this.#derived.indexDocument(numericId, contextSpec, directorySpec, featureBitmaps);
        });

        if (emitEvent) {
            const treeType = contextSpec ? 'context' : (directorySpec ? 'directory' : null);
            const treeSpec = contextSpec ?? directorySpec;
            if (treeType && treeSpec) {
                const { tree } = this.#trees.resolveSelection(treeType, treeSpec, treeType === 'context' ? '/' : null);
                tree.emit(EVENTS.TREE_DOCUMENT_INSERTED, createEvent(EVENTS.TREE_DOCUMENT_INSERTED, {
                    documentId: numericId,
                    contextSpec,
                    directorySpec,
                    source: 'tree',
                }));
            }
            const delta = membershipDelta(
                { context: contextSpec, directory: directorySpec, features: requestedFeatures },
                { memberships: { context: contextSpec, directory: directorySpec, features: featureBitmaps } },
            );
            // DEPRECATED membership-only alias — no document, so automation
            // cannot match on content. Superseded by document.linked below.
            this.#emitEvent(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, {
                id: numericId,
                ...delta,
                reason: 'membership',
                ...(provenance || {}),
            }));
            // First-class membership event carrying the full document so
            // automation (hooks/rules) can match on content.
            this.#emitEvent(EVENTS.DOCUMENT_LINKED, createEvent(EVENTS.DOCUMENT_LINKED, {
                id: numericId,
                document: storedDocument,
                ...delta,
                reason: 'membership',
                ...(provenance || {}),
            }));
        }

        return numericId;
    }

    async #hasOne(id, spec = {}) {
        if (!id) { throw new Error('Document id required'); }

        if (!await this.documents.has(id)) {
            debug(`hasDocument: Document with ID "${id}" not found in the main 'documents' store.`);
            return false;
        }

        const selectorBitmap = await this.#candidates.buildSelectorBitmap({
            context: spec.context ?? null,
            directory: spec.directory ?? null,
        });
        if (selectorBitmap && selectorBitmap.isEmpty) {
            return false;
        }

        const featureBitmap = await this.#candidates.buildFeaturesBitmap(spec.features ?? null);
        if (featureBitmap && featureBitmap.isEmpty) {
            return false;
        }

        let resultBitmap = selectorBitmap;
        if (featureBitmap) {
            if (resultBitmap) {
                resultBitmap.andInPlace(featureBitmap);
            } else {
                resultBitmap = featureBitmap;
            }
        }

        if (!resultBitmap) {
            debug(`hasDocument: Document ID "${id}" exists in store, and no specific filters were provided by the caller.`);
            return true;
        }

        return resultBitmap.has(id);
    }

    async getBitmapsForDocument(id, prefix = '') {
        if (!id) {throw new Error('Document ID required');}

        // Use the synapse reverse index (DocID -> membership keys) instead of
        // scanning + loading every bitmap and testing has(id). Synapse keys are
        // stored normalized, so normalize the prefix to compare apples-to-apples.
        // Covers all membership bitmaps (context/directory/feature/device); BSI
        // slices, timelines and internal bitmaps are intentionally excluded — they
        // are not document memberships.
        const layerKeys = await this.#synapses.listSynapses(id);
        if (!prefix) { return layerKeys; }
        const normalizedPrefix = BitmapIndex.normalizeKey(prefix);
        return layerKeys.filter((key) => key.startsWith(normalizedPrefix));
    }

    /**
     * Copy a document's placement memberships (context-tree + directory-tree
     * bitmaps) onto a successor document — the placement-migration primitive
     * for in-place file edits, where same-path-new-content means a new doc id
     * under content identity and curated placements must follow the successor.
     *
     * Only placement bitmaps are copied:
     *   context/<treeId>/<layerId>   context tree memberships
     *   vfs/<treeId>/<nodeId>        directory tree placements
     * Feature/facet/device/timeline state is deliberately NOT copied — the
     * successor derives its own from its document body. Trees in
     * `excludeTrees` (name or id — e.g. the backends mirror tree, whose paths
     * the successor writes itself) are skipped.
     *
     * @returns {Promise<string[]>} the copied bitmap keys
     */
    async migrateDocumentMemberships(fromId, toId, { excludeTrees = [] } = {}) {
        if (!fromId || !toId) { throw new Error('fromId and toId are required'); }
        const from = Number(fromId);
        const to = Number(toId);
        if (from === to) { return []; }

        const excludedPrefixes = excludeTrees
            .map((t) => this.getTree(t))
            .filter(Boolean)
            .flatMap((tree) => [
                BitmapIndex.normalizeKey(this.#trees.directoryCollection(tree.id).prefix),
                BitmapIndex.normalizeKey(this.#trees.contextCollection(tree.id).prefix),
            ]);

        const layerKeys = await this.#synapses.listSynapses(from);
        const placementKeys = layerKeys.filter((key) =>
            (key.startsWith('context/') || key.startsWith('vfs/'))
            && !excludedPrefixes.some((prefix) => key.startsWith(prefix)));
        if (placementKeys.length === 0) { return []; }

        await this.#writes.applyMembership('tick', to, placementKeys);
        return placementKeys;
    }

    async listDocumentTreePaths(id, treeNameOrId) {
        if (!id) { throw new Error('Document ID required'); }
        const tree = this.getTree(treeNameOrId);
        if (!tree) {
            throw new Error(`Tree not found: ${treeNameOrId}`);
        }
        if (tree.type !== 'directory') {
            throw new Error(`Tree "${tree.name}" is not a directory tree`);
        }

        const collection = this.#trees.directoryCollection(tree.id);
        const layerKeys = await this.#synapses.listSynapses(id);
        // Synapse keys are stored normalized (lowercased); the raw collection
        // prefix carries the uppercase ULID tree id, so normalize to compare.
        const prefix = BitmapIndex.normalizeKey(collection.prefix);
        const paths = [];

        for (const layerKey of layerKeys) {
            if (!layerKey.startsWith(prefix)) {
                continue;
            }
            const nodeId = layerKey.slice(prefix.length);
            // Node ids are uppercase ULIDs but arrive lowercased through key
            // normalization — try both casings.
            const path = await tree.getPathByNodeId(nodeId)
                ?? await tree.getPathByNodeId(nodeId.toUpperCase());
            if (path) {
                paths.push(path);
            }
        }

        return Array.from(new Set(paths));
    }

    async listDocumentTreeMemberships(id, treeNameOrId) {
        if (!id) { throw new Error('Document ID required'); }
        const tree = this.getTree(treeNameOrId);
        if (!tree) {
            throw new Error(`Tree not found: ${treeNameOrId}`);
        }

        const layerKeys = await this.#synapses.listSynapses(id);
        if (tree.type === 'directory') {
            return await this.listDocumentTreePaths(id, tree.id);
        }

        const collection = this.#trees.contextCollection(tree.id);
        const prefix = BitmapIndex.normalizeKey(collection.prefix);
        const paths = [];

        for (const layerKey of layerKeys) {
            if (!layerKey.startsWith(prefix)) {
                continue;
            }
            const layerId = layerKey.slice(prefix.length);
            const path = tree.getPathByLayerId(layerId)
                ?? tree.getPathByLayerId(layerId.toUpperCase());
            if (path) {
                paths.push(path);
            }
        }

        return Array.from(new Set(paths));
    }

    /**
     * Document ids under a tree path, for scoping a bulk operation to part of a
     * workspace — "re-embed just this project" rather than all 23k photos.
     *
     * `scope` is `ctx://<path>` / `dir://<path>` (the default context and
     * directory trees), or `<treeName>://<path>` for a named tree. Returns null
     * when the scope names no tree, so callers can tell "no such tree" from
     * "tree is empty".
     */
    async documentIdsUnderScope(scope) {
        if (typeof scope !== 'string' || scope.length === 0) { return null; }
        const m = scope.match(/^([a-zA-Z0-9_-]+):\/\/?(.*)$/);
        const alias = m ? m[1].toLowerCase() : null;
        const rawPath = m ? m[2] : scope;
        const path = `/${String(rawPath || '').replace(/^\/+/, '')}`;

        let tree = null;
        if (alias === 'ctx' || alias === 'context') { tree = this.getDefaultContextTree(); }
        else if (alias === 'dir' || alias === 'directory') { tree = this.getDefaultDirectoryTree(); }
        else if (alias) { tree = this.getTree(m[1]); }
        else { tree = this.getDefaultContextTree(); }
        if (!tree) { return null; }

        const bitmap = await tree.findRecursive(path);
        return bitmap ? bitmap.toArray() : [];
    }

    async hasDocumentTreeMembership(id, treeNameOrId) {
        if (!id) { throw new Error('Document ID required'); }
        const tree = this.getTree(treeNameOrId);
        if (!tree) {
            throw new Error(`Tree not found: ${treeNameOrId}`);
        }

        const prefix = BitmapIndex.normalizeKey(tree.type === 'directory'
            ? this.#trees.directoryCollection(tree.id).prefix
            : this.#trees.contextCollection(tree.id).prefix);
        const layerKeys = await this.#synapses.listSynapses(id);
        return layerKeys.some((layerKey) => layerKey.startsWith(prefix));
    }

    /**
     * List documents under `path` of a directory tree, optionally filtered by
     * whether they are ALSO linked into any other tree. `linked: false` returns
     * documents present only in this tree (e.g. backend mirrors never filed
     * anywhere — safe-to-purge candidates); `linked: true` the inverse;
     * `linked: null` returns everything under the path. Pure bitmap algebra.
     */
    async listTreeDocuments(treeNameOrId, options = {}) {
        const { path = '/', linked = null, limit = null, offset = 0, parse = true, idsOnly = false } = options;
        const tree = this.getTree(treeNameOrId);
        if (!tree) { throw new Error(`Tree not found: ${treeNameOrId}`); }
        if (tree.type !== 'directory') { throw new Error(`Tree "${tree.name}" is not a directory tree`); }

        const candidates = await tree.findRecursive(path);
        const result = candidates ? candidates.clone() : new RoaringBitmap32();
        if (!result.isEmpty && (linked === true || linked === false)) {
            const linkedElsewhere = await this.#membershipBitmapExcludingTree(tree.id);
            if (linked) {
                result.andInPlace(linkedElsewhere);
            } else {
                result.andNotInPlace(linkedElsewhere);
            }
        }

        const totalCount = result.size;
        let ids = result.toArray();
        if (offset > 0) { ids = ids.slice(offset); }
        if (limit != null && limit >= 0) { ids = ids.slice(0, limit); }
        if (idsOnly) {
            return { ids, count: ids.length, totalCount };
        }
        const fetched = ids.length > 0
            ? await this.getDocumentsByIdArray(ids, { parse })
            : { data: [] };
        const documents = Array.isArray(fetched) ? fetched : (fetched?.data ?? []);
        return {
            documents: documents.filter(Boolean),
            count: ids.length,
            totalCount,
        };
    }

    // Union of document memberships across every tree except the given one.
    // Context trees are covered by their root layer bitmap alone (every insert
    // ticks the root — universal membership); directory trees by the recursive
    // union of their node bitmaps.
    async #membershipBitmapExcludingTree(excludedTreeId) {
        const union = new RoaringBitmap32();
        for (const meta of this.#trees.metadata()) {
            if (meta.id === excludedTreeId) { continue; }
            const other = this.getTree(meta.id);
            if (!other) { continue; }
            if (meta.type === 'context') {
                if (!other.rootLayer) { continue; }
                const bitmap = await this.#trees.contextCollection(meta.id).getBitmap(other.rootLayer.id, false);
                if (bitmap) { union.orInPlace(bitmap); }
            } else {
                const bitmap = await other.findRecursive('/');
                if (bitmap) { union.orInPlace(bitmap); }
            }
        }
        return union;
    }

    // ========================================
    // Read surface: resolveCandidates + rank
    // ========================================
    //
    // The public read API is list() + query(). Both are thin callers of one seam:
    //   resolveCandidates(spec) -> { bitmap, keys, collectionKeys, coarse }
    //   rank(bitmap, match, opts) -> page             match=null slices, else fts/vector/hybrid
    // The db stays stateless. `keys` is the legacy human-readable key list;
    // `collectionKeys` are the real bitmap keys consulted (collection vocabulary)
    // so a QuerySession can intersect them against membership.changed signals for
    // precise invalidation; `coarse` flags a temporal (BSI) dependency that has no
    // stable key and must be re-resolved on any relevant write. Nothing cached here.

    async resolveCandidates(rawSpec = {}) {
        return this.#candidates.resolveCandidates(rawSpec);
    }

    // bitmap===null => unconstrained (all docs / search-all); empty => no survivors.
    async rank(bitmap, match = null, options = {}) {
        return this.#queries.rank(bitmap, match, options);
    }

    async query(match = null, spec = {}) {
        return this.#queries.query(match, spec);
    }

    async list(spec = {}) {
        return this.#queries.list(spec);
    }

    async search(spec = {}) {
        return this.#queries.search(spec);
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
        return this.#queries.searchByVector(queryVector, spec, options);
    }

    /**
     * The stored embedding for a document in a named vector space (its first
     * chunk row), or null. Powers "more like this document" without any vector
     * crossing the API boundary — pair with searchByVector(excludeIds:[docId]).
     */
    async getDocumentVector(docId, space = 'image') {
        return this.#vectors.getDocumentVector(docId, space);
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
        return this.#queries.searchRefined(queries, baseSpec, options);
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
        return this.#queries.searchCompound(lines, options);
    }

    /**
     * Open a long-running, refinable query session bound to this db. Reuses
     * resolveCandidates/rank — no duplicated query logic. See QuerySession.
     *
     * @param {object|object[]} specs  one spec, an array of specs, or {spec,label}[]
     * @param {object} opts            { mode, emit, combinator, debounceMs, limit, offset }
     */
    async openSession(specs = [], opts = {}) {
        const session = new QuerySession(this, opts);
        const list = Array.isArray(specs) ? specs : (specs ? [specs] : []);
        for (const entry of list) {
            if (entry && typeof entry === 'object' && 'spec' in entry) {
                await session.add(entry.spec, entry.label);
            } else {
                await session.add(entry);
            }
        }
        return session;
    }

    async #updateOne(docIdentifier, updateData = null, contextSpec = null, featureBitmapArray = []) {
        if (!docIdentifier) { throw new Error('Document identifier required'); }
        if (typeof docIdentifier !== 'number') { throw new Error('Document identifier must be a numeric ID'); }
        if (!Array.isArray(featureBitmapArray)) { featureBitmapArray = [featureBitmapArray].filter(Boolean); }

        // Canonical update signature accepts a selector/options object.
        let directorySpec = null;
        let provenance = null;
        let emitEvent = true;
        if (this.#isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
            provenance = this.#normalizeProvenance(opts.provenance);
            emitEvent = opts.emitEvent !== false;
        }

        const docId = docIdentifier;
        const featureBitmaps = parseBitmapArray(featureBitmapArray);

        const storedDocument = await this.#getById(docId);
        if (!storedDocument) { throw new Error(`Document with ID "${docId}" not found`); }
        const previous = snapshotDocument(storedDocument);

        // If no update data provided, we're only updating memberships
        if (updateData === null) {
            updateData = storedDocument;
        } else if (typeof updateData === 'object' && !isDocumentInstance(updateData)) {
            if (updateData.schema) {
                updateData = parseInitializeDocument(updateData);
            }
        }

        const updatedDocument = storedDocument.update(updateData);
        validateDocumentRelations(updatedDocument);
        updatedDocument.validate();

        // Bitmaps follow the document's features — union the updated document's
        // own array with any caller-supplied keys.
        for (const key of documentFeatureKeys(updatedDocument)) {
            if (!featureBitmaps.includes(key)) { featureBitmaps.push(key); }
        }
        for (const key of schemaBitmapKeys(updatedDocument)) {
            if (!featureBitmaps.includes(key)) { featureBitmaps.push(key); }
        }
        const staleFeatureKeys = previous.featureKeys.filter((k) => !featureBitmaps.includes(k));

        try {
            await this.#writes.withDeferredMembership(async () => {
                await this.documents.put(updatedDocument.id, updatedDocument);
                // Idempotent self-heal: updates re-assert live membership.
                await this.bitmapIndex.tick(this.allDocumentsBitmap.key, updatedDocument.id);
                await this.#checksumIndex.deleteArray(previous.checksums);
                await this.#checksumIndex.insertArray(updatedDocument.checksumArray, updatedDocument.id);
                if (updatedDocument.updatedAt) {await this.#timelineIndex.insert('crud:updated', updatedDocument.id, updatedDocument.updatedAt);}
                await this.#derived.removeDocumentTimelines(updatedDocument.id, previous, updatedDocument);
                await this.#derived.indexDocumentTimelines(updatedDocument.id, updatedDocument);
                await this.#derived.indexDocumentGeo(updatedDocument.id, updatedDocument);
                this.#derived.syncDocumentRelations(updatedDocument.id, previous.relations, documentRelations(updatedDocument));

                // Untick features this edit removed (e.g. a tag deleted in the UI)
                // BEFORE re-indexing, so a case-only change re-ticks correctly.
                if (staleFeatureKeys.length) { await this.#writes.applyMembership('untick', updatedDocument.id, staleFeatureKeys); }
                // Index across all views using shared helper
                await this.#derived.indexDocument(updatedDocument.id, contextSpec, directorySpec, featureBitmaps);
                await this.#derived.removeStaleLocationMembership(updatedDocument.id, { locations: previous.locations, orphanedAt: previous.orphanedAt }, updatedDocument, featureBitmaps);
                // Presence bitmap tracks comment state; untick when cleared on this edit.
                await this.#writes.applyMembership(updatedDocument.hasComment ? 'tick' : 'untick', updatedDocument.id, [COMMENT_BITMAP_KEY]);
                // Facet bitmaps (mime + status): tick current keys, untick any the
                // contentType/status change left behind (derived from doc state, can't drift).
                const newFacetKeys = facetBitmapKeys(updatedDocument);
                const staleFacetKeys = previous.facetKeys.filter(k => !newFacetKeys.includes(k));
                if (staleFacetKeys.length) { await this.#writes.applyMembership('untick', updatedDocument.id, staleFacetKeys); }
                if (newFacetKeys.length) { await this.#writes.applyMembership('tick', updatedDocument.id, newFacetKeys); }
            });

            if (emitEvent) {
                this.#emitEvent(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, { id: updatedDocument.id, document: updatedDocument, reason: 'content', ...(provenance || {}) }));
            }

            // Best-effort Lance upsert
            try {
                await this.#lanceIndex.upsert(parseInitializeDocument(updatedDocument));
            } catch (e) {
                debug(`put/update: Lance upsert failed for ${updatedDocument.id}: ${e.message}`);
            }
            // Content changed → the doc must be re-embedded. The external embedd
            // service reacts to DOCUMENT_UPDATED; here we drop it from the seen
            // ledger so a reconcile re-embeds it even if the live event is missed.
            for (const space of this.#vectors.openedNames()) {
                try { await this.bitmapIndex.untick(this.#vectors.seenKey(space), Number(updatedDocument.id)); } catch (_) { }
            }

            return updatedDocument.id;
        } catch (error) {
            debug(`put/update: Error during update: ${error.message}`);
            throw error;
        }
    }

    // Removes documents from context and/or feature bitmaps
    async #unlinkOne(docId, contextSpec = { path: '/' }, featureBitmapArray = [], options = { recursive: false }) {
        if (!docId) { throw new Error('Document id required'); }
        if (typeof options !== 'object') { options = { recursive: false }; }

        let directorySpec = null;
        let provenance = null;
        if (this.#isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
            provenance = this.#normalizeProvenance(opts.provenance);
        }

        const featureKeys = normalizeBitmapKeys(featureBitmapArray);
        const layersToRemove = [];
        const removedContextPaths = [];
        const removedDirectoryPaths = [];

        if (contextSpec) {
            const { tree: contextTree, collection: contextCollection, path: normalizedContextSpec } = this.#trees.resolveSelection('context', contextSpec, '/');
            const pathLayersArray = parseContextSpecForInsert(normalizedContextSpec);

            for (const pathLayers of pathLayersArray) {
                if (pathLayers.length === 1 && pathLayers[0] === '/') {
                    throw new Error('Cannot unlink from root context "/". Unlink a real path or delete the document.');
                }

                const filteredLayers = pathLayers.filter((context) => context !== '/');
                if (filteredLayers.length === 0) {
                    throw new Error('Cannot unlink from root context "/". Unlink a real path or delete the document.');
                }

                const targetLayers = options.recursive
                    ? filteredLayers
                    : [filteredLayers[filteredLayers.length - 1]];
                const layerIds = contextTree.resolveLayerIds(targetLayers);
                layersToRemove.push(...layerIds.map((layerId) => contextCollection.makeKey(layerId)));
                removedContextPaths.push(...SynapsD.#unlinkedContextPaths(filteredLayers, options.recursive));
            }
        }

        if (directorySpec) {
            const { tree: directoryTree, collection: directoryCollection, path: normalizedDirectoryPath } = this.#trees.resolveSelection('directory', directorySpec, '/');
            const directoryPaths = Array.isArray(normalizedDirectoryPath) ? normalizedDirectoryPath : [normalizedDirectoryPath];

            for (const directoryPath of directoryPaths) {
                const nodeIds = directoryTree.getNodeIdsForPath(directoryPath, { recursive: Boolean(options.recursive) });
                layersToRemove.push(...nodeIds.map((nodeId) => directoryCollection.makeKey(nodeId)));
                if (nodeIds.length > 0) {
                    removedDirectoryPaths.push(directoryPath);
                }
            }
        }

        layersToRemove.push(...featureKeys);

        try {
            if (layersToRemove.length > 0) {
                await this.#writes.withDeferredMembership(async () => {
                    await this.#writes.removeDocumentMembership(docId, Array.from(new Set(layersToRemove)));
                });
                debug(`unlink: Removed doc ${docId} from ${layersToRemove.length} layers via Synapses`);
            }

            const delta = membershipDelta(
                { context: removedContextPaths, directory: removedDirectoryPaths, features: featureKeys },
                {
                    contextArray: removedContextPaths,
                    directoryArray: removedDirectoryPaths,
                    featureArray: featureKeys,
                },
            );
            // DEPRECATED membership-only alias — superseded by
            // document.unlinked below, which carries the document.
            this.#emitEvent(EVENTS.DOCUMENT_REMOVED, createEvent(EVENTS.DOCUMENT_REMOVED, {
                id: docId,
                ...delta,
                recursive: options.recursive,
                reason: 'membership',
                ...(provenance || {}),
            }));
            // First-class membership event carrying the full document (still in
            // the store — unlink only drops memberships) so automation can match
            // on content. Omitted if the document is gone.
            try {
                const unlinkedData = await this.documents.get(docId);
                if (unlinkedData) {
                    this.#emitEvent(EVENTS.DOCUMENT_UNLINKED, createEvent(EVENTS.DOCUMENT_UNLINKED, {
                        id: docId,
                        document: parseDocumentData(unlinkedData),
                        ...delta,
                        recursive: options.recursive,
                        reason: 'membership',
                        ...(provenance || {}),
                    }));
                }
            } catch (error) {
                debug(`unlink: document.unlinked emit skipped for ${docId}: ${error.message}`);
            }
            return docId;
        } catch (error) {
            debug(`Error during unlink for ID ${docId}: ${error.message}`);
            throw error;
        }
    }

    // Deletes documents from all bitmaps and the main dataset
    async #deleteOne(docId, options = {}) {
        if (!docId) { throw new Error('Document id required'); }
        const { emitEvent = true } = options;
        const provenance = this.#normalizeProvenance(options.provenance);
        debug(`delete: Document with ID "${docId}" found (or context check passed), proceeding to delete..`);

        let document = null;
        let transactionSuccess = false;

        try {
            // Get document before deletion (outside transaction to check existence)
            const documentData = await this.documents.get(docId);
            if (!documentData) {
                debug(`delete: Document with ID "${docId}" not found`);
                return false;
            }
            document = parseDocumentData(documentData);
            debug('delete > Document: ', document);

            // Wrap all critical database operations in a single transaction for atomicity
            await this.#writes.withDeferredMembership(async () => {
                // Delete document from main database
                await this.documents.delete(docId);
                // Unconditional (unlike free-pool admission): the doc is gone
                // from the store, it must leave internal/docs/all either way.
                await this.bitmapIndex.untick(this.allDocumentsBitmap.key, docId);
                debug(`delete: Document ${docId} deleted from main store`);

                // Delete document from all bitmaps AND Reverse Index via Synapses
                // await this.bitmapIndex.untickAll(docId);
                await this.#retractIncomingAssertedRelations(docId);
                const clearedLayers = await this.#synapses.clearSynapses(docId, { syncBitmaps: false });
                await this.#writes.applyMembership('untick', docId, clearedLayers);
                this.#edges.deleteNode(docId);
                debug(`delete: Document ${docId} removed from all bitmaps, Synapses index and edge plane`);

                // Remove document from all custom and CRUD timelines before recording deletion.
                // Doc-derived first: multi-position membership cells can only be
                // recomputed from the row's entries (removeFromAll covers the BSI planes).
                await this.#derived.removeDocumentTimelines(docId, document);
                await this.#timelineIndex.removeFromAll(docId);
                if (await this.#geoIndex.has(docId)) { await this.#geoIndex.remove(docId); }
                debug(`delete: Document ${docId} removed from timeline indices`);

                // Delete document checksums from inverted index
                await this.#checksumIndex.deleteArray(document.checksumArray);
                debug(`delete: Checksums for document ${docId} deleted from index`);

                // NOTE: free-pool admission (deletedDocumentsBitmap) happens AFTER
                // lance cleanup succeeds, outside this tx — see below.

                // Update timestamp index
                await this.#timelineIndex.insert('crud:deleted', docId, document.updatedAt || new Date());
                debug(`delete: Timestamp for document ${docId} updated in index`);
            });

            transactionSuccess = true;
            debug(`delete: All database operations completed atomically for document ID: ${docId}`);

        } catch (error) {
            debug(`delete: Transaction failed for document ID: ${docId}, error: ${error.message}`);
            // If transaction failed, ensure we don't attempt Lance cleanup
            transactionSuccess = false;
            throw new Error(`Failed to delete document atomically: ${error.message}`);
        }

        // Best-effort Lance delete (outside transaction since it's a separate system)
        if (transactionSuccess) {
            // Gate free-pool admission on lance cleanup: only recycle the id if
            // the fts (+ vector) rows are gone. If cleanup fails the id leaks
            // (stays allocated) but is never reused with a stale residue. The
            // crud:deleted timeline already serves any audit/tombstone need.
            let lanceClean = true;
            try {
                lanceClean = await this.#lanceIndex.delete(docId);
                debug(`delete: LanceDB cleanup ${lanceClean ? 'completed' : 'FAILED'} for document ${docId}`);
            } catch (e) {
                lanceClean = false;
                debug(`delete: Lance delete failed for ${docId}: ${e.message}`);
            }
            if (this.#vectors.openedCount > 0) {
                try {
                    for (const vi of this.#vectors.openedIndexes()) {
                        const vecClean = await vi.deleteDoc(docId);
                        lanceClean = lanceClean && vecClean;
                    }
                } catch (e) {
                    lanceClean = false;
                    debug(`delete: Vector delete failed for ${docId}: ${e.message}`);
                }
            }

            if (lanceClean) {
                try {
                    // Persisting tick (Bitmap.tick is in-memory only); keeps the
                    // cached deletedDocumentsBitmap instance and the store in sync.
                    await this.bitmapIndex.tick(this.deletedDocumentsBitmap.key, docId);
                    debug(`delete: Document ${docId} admitted to free-id pool`);
                } catch (e) {
                    debug(`delete: free-pool admission failed for ${docId} (id leaks): ${e.message}`);
                }
            }

            if (emitEvent) {
                this.#emitEvent(EVENTS.DOCUMENT_DELETED, createEvent(EVENTS.DOCUMENT_DELETED, { id: docId, reason: 'deleted', ...(provenance || {}) }));
            }
            debug(`delete: Successfully deleted document ID: ${docId}`);
            return true;
        }

        return false;
    }

    /**
     * Convenience methods
     */

    async getDocument(docId, contextSpec = '/', options = { parse: true }) {
        if (!docId) { throw new Error('Document id required'); }
        if (options.parse) {
            return await this.#getById(docId);
        } else {
            return await this.documents.get(docId, contextSpec, options);
        }
    }

    /**
     * Get a document by ID and return a properly instantiated document object
     * @param {string|number} id - Document ID
     * @param {Object} options - Options object
     * @param {boolean} options.parse - Whether to parse the documents
     * @returns {Document|null} Document instance or null if not found
     */
    async #getById(id, options = { parse: true }) {
        if (!id) { throw new Error('Document id required'); }
        if (typeof id === 'string') { id = parseInt(id); }
        debug(`getById: Searching for document with ID ${id} of type ${typeof id}`);

        // Get raw document data from database
        const rawDocData = await this.documents.get(id);
        if (!rawDocData) {
            debug(`Document with ID ${id} not found`);
            return null;
        }

        // Return a JS object
        return options.parse ? parseInitializeDocument(rawDocData) : rawDocData;
    }

    /**
     * Get multiple documents by ID and return properly instantiated document objects
     * @param {Array<string|number>} idArray - Array of document IDs
     * @param {Object} options - Options object
     * @param {boolean} options.parse - Whether to parse the documents
     * @param {number} options.limit - Maximum number of documents to return
     * TODO: Support proper pagination!
     * @returns {Array<Document>} Array of document instances
     */
    async getDocumentsByIdArray(idArray, options = { parse: true, limit: null }) {
        if (!Array.isArray(idArray)) {
            throw new Error('Document ID array must be an array');
        }

        // Convert all ids to numbers if they are strings
        const processedIdArray = idArray.map(id => typeof id === 'string' ? parseInt(id) : id);

        if (processedIdArray.length === 0) {
            debug('getDocumentsByIdArray: No IDs to fetch after context filter (if applied).ନ');
            return {
                data: [],
                count: 0, // Count is 0 as no documents will be fetched that match criteria
                error: null,
            };
        }

        debug(`getDocumentsByIdArray: Getting ${processedIdArray.length} documents from DB.`);
        try {
            const documents = await this.documents.getMany(processedIdArray);
            // The `count` should reflect how many documents were found that matched the criteria (including context)
            // If limit is applied, count still refers to total potential matches, not just the returned slice.
            const totalMatchingCount = documents.length;

            const limitedDocs = options.limit ? documents.slice(0, options.limit) : documents;

            return {
                data: options.parse ? limitedDocs.map(doc => parseInitializeDocument(doc)) : limitedDocs,
                count: totalMatchingCount, // This is the count of documents found for the (possibly context-filtered) IDs
                error: null,
            };
        } catch (error) {
            debug(`Error in getDocumentsByIdArray: ${error.message}`);
            return {
                data: [],
                count: 0,
                error: error.message,
            };
        }
    }

    /**
     * Get a document by checksum string and return a properly instantiated document object
     * @param {string} checksumString - Checksum string
     * @returns {Document|null} Document instance or null if not found
     */
    /**
     * @param {string} checksumString
     * @param {object} [options]
     * @param {string} [options.schema] Restrict the match to one schema. OPT-IN,
     *   and used only on the dedup paths: the checksum index is global per
     *   workspace and carries no schema prefix, so two schemas whose
     *   `checksumFields` serialize to the same string collide and the incoming
     *   document silently OVERWRITES the other's id. Live exposure:
     *   Link['data.uri'] vs Tab['data.url'] (both bare URLs), Dotfile['data.url'],
     *   Device['data.deviceId'].
     *
     *   Deliberately NOT prefixing the stored checksum with the schema id: that
     *   changes every document's identity and forces a full re-dedup. Scoping the
     *   LOOKUP leaves all stored checksums untouched — no migration, no identity
     *   fork. And deliberately not a default: plain lookups
     *   (`hasByChecksumString`, the route handlers, stored reconciliation) are
     *   "find the doc with these bytes", where cross-schema matching is the
     *   correct behaviour.
     */
    async getByChecksumString(checksumString, options = { parse: true }) {
        if (!checksumString) { throw new Error('Checksum string required'); }
        debug(`getByChecksumString: Searching for document with checksum ${checksumString}`);

        // Get document ID from checksum index
        const id = await this.#checksumIndex.checksumStringToId(checksumString);
        if (!id) { return null; }

        // Return the document instance, passing the contextSpec through
        const document = await this.#getById(id, options);
        if (options?.schema && document && document.schema !== options.schema) { return null; }
        return document;
    }

    // spec: { context?, directory?, features?, attributes? } — same shape as has().
    // (The old 3-arg form silently dropped its features argument: has() takes two.)
    async hasByChecksumString(checksumString, spec = {}) {
        if (!checksumString) { throw new Error('Checksum string required'); }
        const id = await this.#checksumIndex.checksumStringToId(checksumString);
        if (!id) { return false; }
        return await this.has(id, spec);
    }

    /**
     * Get multiple documents by checksum string and return properly instantiated document objects
     * @param {Array<string>} checksumStringArray - Array of checksum strings
     * @returns {Array<Document>} Array of document instances
     */
    // ⚠️ `contextSpec` is accepted and IGNORED — this method has no context scoping
    // and never had any. Kept in the signature only so the positional `options` arg
    // does not shift under any caller; there are currently none in this monorepo, so
    // deleting the whole method is the better fix if that stays true.
    async getDocumentsByChecksumStringArray(checksumStringArray, _contextSpec = '/', options = { parse: true }) {
        if (!Array.isArray(checksumStringArray)) {
            throw new Error('Checksum string array must be an array');
        }
        debug(`getDocumentsByChecksumStringArray: Getting ${checksumStringArray.length} documents`);

        try {
            // Batch-resolve all checksums to IDs in parallel
            const resolvedIds = await this.#checksumIndex.checksumStringArrayToIds(checksumStringArray);
            const ids = resolvedIds.filter(Boolean);

            // Use getDocumentsByIdArray which now properly returns a result object
            return await this.getDocumentsByIdArray(ids, options);
        } catch (error) {
            debug(`Error in getDocumentsByChecksumStringArray: ${error.message}`);
            return {
                data: [],
                count: 0,
                error: error.message,
            };
        }
    }

    /**
     * Query methods
     */

    /**
     * Utils
     */

    async dumpDocuments(dstDir, contextSpec = { path: '/' }, featureBitmapArray = [], filterArray = []) {
        if (!dstDir) { throw new Error('Destination directory required'); }
        if (typeof dstDir !== 'string') { throw new Error('Destination directory must be a string'); }
        debug('Dumping DB documents to directory: ', dstDir);
        debug('Context spec: ', contextSpec);
        debug('Feature bitmaps: ', featureBitmapArray);

        // Ensure the destination directory exists
        if (!fs.existsSync(dstDir)) { fs.mkdirSync(dstDir, { recursive: true }); }

        // Get all documents from the documents dataset
        const documentArray = await this.list({
            context: contextSpec,
            features: { allOf: parseBitmapArray(featureBitmapArray).filter(Boolean) },
            filters: filterArray,
        });
        debug(`Found ${documentArray.length} documents to dump..`);

        // Loop through all documents in the returned array
        for (let doc of documentArray) {
            doc = parseInitializeDocument(doc);

            // Create a directory for each document schema
            const schemaDir = path.join(dstDir, doc.schema);
            debug('Creating schema directory: ', schemaDir);
            if (!fs.existsSync(schemaDir)) { fs.mkdirSync(schemaDir, { recursive: true }); }

            // Write the document to the destination directory
            debug('Writing document to: ', path.join(schemaDir, `${doc.id}.json`));
            fs.writeFileSync(path.join(schemaDir, `${doc.id}.json`), doc.toJSON());
        }

        debug('All queried documents have been written to the destination directories');
        return true;
    }

    async dumpBitmaps(dstDir, bitmapArray = []) {
        if (!dstDir) { throw new Error('Destination directory required'); }
        if (!Array.isArray(bitmapArray)) { bitmapArray = [bitmapArray]; }
        if (typeof dstDir !== 'string') { throw new Error('Destination directory must be a string'); }
        debug('Dumping DB bitmaps to directory: ', dstDir);
        debug('Bitmap array: ', bitmapArray);

        // Ensure the destination directory exists
        if (!fs.existsSync(dstDir)) { fs.mkdirSync(dstDir, { recursive: true }); }

        // TODO: To finish, more important stuff to be done!

    }

    // Emit a tree.document.* event for a context/directory selection. Emitting on
    // the tree means #registerTreeEvents stamps treeId/treeName/treeType, and the
    // workspace runtime listener adds workspaceId — the shape clients (browser
    // extension auto-open/close, web UI) rely on. Carries documentIds + the path
    // so consumers can fetch/close by id without inline document bodies.
    // Public: emit a tree-scoped document event for an already-known selection
    // (e.g. a scoped purge that deleted ids at a specific tree+path). Lets callers
    // that hold the selector drive cross-client auto-close without per-doc
    // membership reconstruction. Pass whichever of context/directory applies.
    emitTreeDocumentEvent(eventName, { context = null, directory = null, documentIds = [] } = {}) {
        return this.#trees.emitTreeDocumentEvent(eventName, { context, directory, documentIds });
    }

    #isDocumentOperationOptions(value) {
        return Boolean(
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            ['context', 'directory', 'features', 'attributes', 'emitEvent', 'provenance'].some((key) => Object.prototype.hasOwnProperty.call(value, key)),
        );
    }

    #normalizeWriteFeatures(features) {
        if (features == null) {
            return [];
        }
        let keys;
        if (Array.isArray(features)) {
            keys = normalizeBitmapKeys(features);
        } else if (typeof features === 'object') {
            keys = normalizeBitmapKeys(features.allOf ?? features.features ?? []);
        } else {
            keys = normalizeBitmapKeys(features);
        }
        // 'default' is the VIRTUAL dataset (docs stamped with no dataset,
        // computed at query time) — stamping it physically would make those
        // docs permanently invisible to the dataset selection.
        if (keys.includes('data/dataset/default')) {
            throw new Error('"default" is a reserved dataset name (the virtual unstamped-documents dataset); pick another name');
        }
        return keys;
    }

    // Write spec: { paths?, features?/attributes?, context?, directory?, emitEvent? }.
    // paths use the canonical ctx:/dir: grammar; context/directory are the legacy
    // selector form kept until consumers migrate. Returns the internal membership
    // shape { context, directory, features, emitEvent }.
    #normalizeDocumentOperationSpec(spec = {}) {
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { spec = {}; }

        let context = spec.context !== undefined ? spec.context : { path: '/' };
        let directory = spec.directory ?? null;

        if (Array.isArray(spec.paths)) {
            const ctx = [];
            const dir = [];
            for (const token of spec.paths.filter(Boolean)) {
                const body = String(token).replace(/^[+!]/, '');
                if (body.startsWith('dir:')) { dir.push(body.slice(4)); }
                else if (body.startsWith('ctx:')) { ctx.push(body.slice(4)); }
                else { ctx.push(body); }
            }
            // The paths grammar is authoritative: derive BOTH selectors from it and
            // do not retain the implicit root-context default. Otherwise a dir-only
            // op (e.g. unlink from dir:/foo) also targets ctx:/ → "Cannot unlink
            // from root context".
            context = ctx.length > 0 ? { path: ctx.length === 1 ? ctx[0] : ctx } : null;
            directory = dir.length > 0 ? { path: dir.length === 1 ? dir[0] : dir } : null;
        }

        const legacyFeatures = spec.features ?? spec.attributes?.allOf ?? spec.attributes ?? [];
        return {
            context,
            directory,
            features: this.#normalizeWriteFeatures(legacyFeatures),
            emitEvent: spec.emitEvent ?? true,
            provenance: this.#normalizeProvenance(spec.provenance),
        };
    }

    // Caller-supplied provenance rides on emitted events so automation layers
    // (workspace hooks/rules) can detect and bound their own cascades. Only the
    // three known keys pass through; anything else is dropped.
    /**
     * The context PATHS an unlink dropped, for the event's membership delta.
     *
     * Unlinking `/a/b/c` unticks the leaf layer `c`, or every layer along the
     * path when recursive — but a consumer reasoning about "what changed"
     * thinks in paths, not in the layer names a path decomposes into. Layer
     * names were what the payload used to carry under a field called
     * `contextArray`, which silently matched nothing for anyone who read the
     * name literally.
     *
     * @param {string[]} filteredLayers layer names of the path, root removed
     * @param {boolean} recursive
     * @returns {string[]} '/a/b/c', or every prefix of it when recursive
     */
    static #unlinkedContextPaths(filteredLayers, recursive) {
        if (filteredLayers.length === 0) { return []; }
        if (!recursive) { return [`/${filteredLayers.join('/')}`]; }
        return filteredLayers.map((_, i) => `/${filteredLayers.slice(0, i + 1).join('/')}`);
    }

    #normalizeProvenance(provenance) {
        if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) { return null; }
        const out = {};
        if (typeof provenance.origin === 'string' && provenance.origin) { out.origin = provenance.origin; }
        if (typeof provenance.causedBy === 'string' && provenance.causedBy) { out.causedBy = provenance.causedBy; }
        if (Number.isInteger(provenance.depth) && provenance.depth >= 0) { out.depth = provenance.depth; }
        return Object.keys(out).length > 0 ? out : null;
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
    async #documentStoreIsEmpty() {
        for await (const _ of this.documents.getKeys({ limit: 1 })) { return false; }
        return true;
    }



    /**
     * Merge a legacy bitmap key into its canonical form (OR + delete legacy).
     * For callers that know a key's true spelling after the allowed charset
     * widened ('@'/':' used to squash to '_'). Idempotent; returns true when
     * a merge happened.
     */
    async migrateBitmapKey(legacyKey, canonicalKey) {
        return this.bitmapIndex.migrateKey(legacyKey, canonicalKey);
    }

    #emitEvent(...args) { return this.#writes.emit(...args); }

    emitTreeEvent(tree, eventName, payload) { return this.#writes.emitTreeEvent(tree, eventName, payload); }

    // One-time backfill for stores created before internal/docs/all existed:
    // an empty maintained bitmap alongside a non-empty document store means the
    // bitmap predates the feature — rebuild it from the store keys.
    async #backfillAllDocumentsBitmap() {
        const bitmap = this.allDocumentsBitmap;
        if (!bitmap || !bitmap.isEmpty) { return; }
        const ids = [];
        for await (const { key } of this.documents.getRange()) {
            const id = Number(key);
            if (Number.isInteger(id) && id > 0) { ids.push(id); }
        }
        if (ids.length > 0) {
            await this.bitmapIndex.tick(bitmap.key, ids);
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
    async #replayDerivedPlane(ids = null) {
        const documentIds = ids ?? await this.#allDocumentIds();
        let edges = 0;

        for (const id of documentIds) {
            const row = this.documents.get(id);
            if (!row || typeof row !== 'object') { continue; }

            let doc;
            try { doc = parseInitializeDocument(row); } catch (error) {
                debug(`rebuild: skipping ${id} — ${error.message}`);
                continue;
            }
            doc.id = id;

            const derived = [
                ...facetBitmapKeys(doc),
                ...this.#derived.locationDerivedFeatures(doc),
                ...documentFeatureKeys(doc),
                ...schemaBitmapKeys(doc),
            ];
            // The user-authored comment is the one text class nothing can
            // regenerate, so its presence bitmap has to come back from the row like
            // every other derived key. rebuildL3 drops the bitmap; this re-ticks it.
            if (doc.hasComment) { derived.push(COMMENT_BITMAP_KEY); }
            await this.#writes.applyMembership('tick', id, normalizeBitmapKeys(derived));

            const relations = documentRelations(doc);
            if (relations.length > 0) {
                // link() is idempotent (dupsort dedups), so a replay over an intact
                // index is a no-op rather than a duplicate.
                this.#derived.syncDocumentRelations(id, [], relations);
                edges += relations.length;
            }
        }

        return edges;
    }


    async #allDocumentIds() {
        const ids = [];
        for await (const { key } of this.documents.getRange()) {
            const id = Number(key);
            if (Number.isInteger(id) && id > 0) { ids.push(id); }
        }
        return ids;
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
                this.#edges.removeEdges({ src });
            } else {
                this.#edges.clear();
            }
        }

        if (bitmaps) {
            // device/os|type resolve through the #deviceFacets cache rather than off
            // the document being replayed, so the cache has to be row-fresh BEFORE
            // the drop. Otherwise those two keys are dropped and only partially put
            // back, which is the one way this rebuild could lose derived state.
            await this.#derived.loadDeviceFacets();

            for (const prefix of [...derivedBitmapPrefixes(), ...RETIRED_BITMAP_PREFIXES]) {
                for (const key of await this.bitmapIndex.listBitmaps(prefix)) {
                    await this.bitmapIndex.deleteBitmap(key);
                    stats.bitmapsDropped++;
                }
            }
        }

        if (edges || bitmaps) {
            const ids = await this.#allDocumentIds();
            stats.documents = ids.length;
            stats.edges = await this.#replayDerivedPlane(ids);
            if (onProgress) { onProgress({ ...stats }); }
        }

        if (timelines) { await this.reindexCrudTimelines({ onProgress }); }
        if (search) { await this.reindexSearchIndex({ rebuild: true, onProgress }); }
        if (embeddings) { await this.reindexEmbeddings({ onProgress }); }

        return stats;
    }

    async reindexCrudTimelines({ batchSize = 1000, onProgress = null } = {}) {
        if (!this.isRunning()) { throw new Error('Database is not running'); }

        // 1. Drop stale crud timelines (clears BOTH old start/end and any ts bitmaps).
        const crudTimelines = ['crud:created', 'crud:updated', 'crud:deleted'];
        let removedTimelines = 0;
        for (const name of crudTimelines) {
            if (await this.#timelineIndex.deleteTimeline(name)) { removedTimelines++; }
        }

        // 2. Collect every document id.
        const ids = [];
        for await (const { key } of this.documents.getRange()) {
            const id = Number(key);
            if (Number.isInteger(id) && id > 0) { ids.push(id); }
        }

        // 3. Re-derive crud:created/updated in id batches, buffered per batch.
        const counts = { scanned: 0, created: 0, updated: 0, removedTimelines };
        for (let i = 0; i < ids.length; i += batchSize) {
            const slice = ids.slice(i, i + batchSize);
            const docs = safeParseDocuments(await this.documents.getMany(slice));

            await this.#writes.withDeferredMembership(async () => {
                for (const doc of docs) {
                    counts.scanned++;
                    if (doc.createdAt) {
                        await this.#timelineIndex.insert('crud:created', doc.id, new Date(doc.createdAt));
                        counts.created++;
                    }
                    if (doc.updatedAt) {
                        await this.#timelineIndex.insert('crud:updated', doc.id, new Date(doc.updatedAt));
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
        if (!this.isRunning()) { throw new Error('Database is not running'); }

        // 1. Drop stale data/mime/* bitmaps for a clean rebuild.
        let dropped = 0;
        for (const key of await this.bitmapIndex.listBitmaps(MIME_BITMAP_PREFIX)) {
            try { await this.bitmapIndex.deleteBitmap(key); dropped++; } catch (_) { /* ignore */ }
        }

        // 2. Collect every document id.
        const ids = [];
        for await (const { key } of this.documents.getRange()) {
            const id = Number(key);
            if (Number.isInteger(id) && id > 0) { ids.push(id); }
        }

        // 3. Re-tick mime keys in id batches, buffered per batch.
        const counts = { scanned: 0, ticked: 0, dropped, total: ids.length };
        const touchedKeys = new Set();
        for (let i = 0; i < ids.length; i += batchSize) {
            const slice = ids.slice(i, i + batchSize);
            const docs = safeParseDocuments(await this.documents.getMany(slice));

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
        if (!this.isRunning()) { throw new Error('Database is not running'); }
        if (!this.#lanceIndex || !this.#lanceIndex.isReady) {
            throw new Error('FTS index not available (semantic disabled or Lance not ready)');
        }

        // rebuild: wipe the table + coverage bitmap first, so a drift where the
        // bitmap over-claims (rows lost but bitmap persisted) is fully repaired.
        if (rebuild) { await this.#lanceIndex.clearFts(); }

        const totalDocs = await this.documents.getCount();
        const startStats = await this.#lanceIndex.stats().catch(() => ({ indexedDocs: 0 }));
        const alreadyIndexed = startStats.indexedDocs || 0;

        // Loop bounded batches until coverage stops growing (backfill skips indexed
        // docs and processes up to `batchSize` new ones per call).
        let prevIndexed = alreadyIndexed;
        for (;;) {
            await this.#lanceIndex.backfill(this.bitmapIndex, this.documents, parseInitializeDocument, batchSize);
            const stats = await this.#lanceIndex.stats().catch(() => ({ indexedDocs: prevIndexed }));
            const nowIndexed = stats.indexedDocs || 0;
            if (onProgress) { onProgress({ indexed: nowIndexed, totalDocs }); }
            if (nowIndexed <= prevIndexed) { break; } // no progress → done (or stuck)
            prevIndexed = nowIndexed;
        }

        try { await this.#lanceIndex.optimize(); } catch (e) { debug(`reindexSearchIndex: optimize failed: ${e.message}`); }

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
        if (!this.isRunning()) { throw new Error('Database is not running'); }
        if (!this.#vectors.primary) {
            throw new Error('Dense vector store not available (semantic disabled or not ready)');
        }
        const space = opts.space || 'text';
        const embeddableSchemas = (Array.isArray(opts.schemas) && opts.schemas.length)
            ? opts.schemas
            : Array.from(this.#vectors.config.embeddableSchemas);
        const all = await this.bitmapIndex.OR(normalizeBitmapKeys(embeddableSchemas));
        const totalEmbeddable = all ? all.size : 0;
        const unembedded = await this.getUnembeddedDocIds(space, embeddableSchemas);
        return { space, unembedded, totalEmbeddable, embeddableSchemas };
    }

    clearSync() {
        if (!this.isRunning()) {
            throw new Error('Database is not running');
        }
        this.db.clearSync();// returns void
        return true;
    }

    async clearAsync() {
        if (!this.isRunning()) {
            throw new Error('Database is not running');
        }
        await this.db.clearAsync();
        return true;
    }

}

export default SynapsD;
export { EVENTS } from './utils/events.js';
