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
import { EVENTS, createEvent } from './utils/events.js';

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
import { normalizeBitmapKey } from './indexes/bitmaps/lib/keys.js';
import SemanticEngine from './semantic/index.js';

// Views / Abstractions
import ContextTree from './views/ContextTree.js';
import DirectoryTree from './views/DirectoryTree.js';

// Extracted utilities
import { parseBitmapArray } from './utils/parsing.js';
import { parseInitializeDocument } from './utils/document.js';
import QuerySession from './session/QuerySession.js';
import TreeRegistry from './trees/TreeRegistry.js';
import CandidateResolver from './query/CandidateResolver.js';
import QueryEngine from './query/QueryEngine.js';
import WriteCoordinator from './write/WriteCoordinator.js';
import DocumentWriter from './write/DocumentWriter.js';
import DocumentDeletion from './write/DocumentDeletion.js';
import MembershipWriter from './write/MembershipWriter.js';
import { normalizeDocumentOperationSpec } from './write/options.js';
import DerivedIndexes from './write/DerivedIndexes.js';
import Maintenance from './maintenance/Maintenance.js';
import EngineLifecycle from './lifecycle/EngineLifecycle.js';

import { relationKey, documentRelations } from './documents/derivation.js';

// Preserve the existing package entry-point exports.
export {
    derivedBitmapPrefixes,
    facetBitmapKeys as facetBitmapKeysForTest,
    schemaBitmapKeys as schemaBitmapKeysForTest,
} from './documents/derivation.js';

// Constants
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
    #lifecycle;
    #options;
    #storageClosed = false;

    #trees;
    #candidates;
    #queries;
    #writes;
    #writer;
    #deletion;
    #membershipWriter;
    #derived;
    #maintenance;

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
        this.#options = { ...options };
        this.#openStorage(options);
        this.#lifecycle = new EngineLifecycle({
            initialize: async () => {
                if (this.#storageClosed) {
                    // Preserve live search tuning/model configuration across restart.
                    const semantic = this.#vectors.config;
                    this.#bitmapCache.clear();
                    this.#openStorage({ ...this.#options, semantic });
                    this.#storageClosed = false;
                }
                await this.#initializeRuntime();
            },
            close: () => this.#writes.closeAndDrain(async () => {
                if (this.#storageClosed) { return; }
                this.#emitEvent(EVENTS.BEFORE_SHUTDOWN, createEvent(EVENTS.BEFORE_SHUTDOWN));
                await this.#db.close();
                this.#storageClosed = true;
            }),
            publish: (...args) => this.#emitEvent(...args),
        });
    }

    #openStorage(options) {
        debug('Initializing SynapsD');
        debug('DB Options:', options);

        // Initialize database backend
        this.#rootPath = options.rootPath ?? options.path;
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
            getEdges: () => this.#edges,
        });
        this.#writer = new DocumentWriter({
            documents: this.documents,
            bitmapIndex: this.bitmapIndex,
            trees: this.#trees,
            writes: this.#writes,
            derived: this.#derived,
            vectors: this.#vectors,
            checksumIndex: this.#checksumIndex,
            internalStore: this.#internalStore,
            getTimeline: () => this.#timelineIndex,
            getLance: () => this.#lanceIndex,
            getAllBitmap: () => this.allDocumentsBitmap,
            getDeletedBitmap: () => this.deletedDocumentsBitmap,
            getById: (...args) => this.#getById(...args),
            getByChecksumString: (...args) => this.getByChecksumString(...args),
        });
        this.#deletion = new DocumentDeletion({
            documents: this.documents,
            bitmapIndex: this.bitmapIndex,
            writes: this.#writes,
            derived: this.#derived,
            vectors: this.#vectors,
            checksumIndex: this.#checksumIndex,
            getTimeline: () => this.#timelineIndex,
            getGeo: () => this.#geoIndex,
            getEdges: () => this.#edges,
            getSynapses: () => this.#synapses,
            getLance: () => this.#lanceIndex,
            getAllBitmap: () => this.allDocumentsBitmap,
            getDeletedBitmap: () => this.deletedDocumentsBitmap,
            retractIncoming: (...args) => this.#retractIncomingAssertedRelations(...args),
        });
        this.#membershipWriter = new MembershipWriter({
            documents: this.documents,
            trees: this.#trees,
            writes: this.#writes,
            derived: this.#derived,
            getById: (...args) => this.#getById(...args),
        });
        this.#maintenance = new Maintenance({
            documents: this.documents,
            bitmapIndex: this.bitmapIndex,
            derived: this.#derived,
            writes: this.#writes,
            vectors: this.#vectors,
            getAllBitmap: () => this.allDocumentsBitmap,
            getTimeline: () => this.#timelineIndex,
            getEdges: () => this.#edges,
            getLance: () => this.#lanceIndex,
            getById: (...args) => this.#getById(...args),
            assertRelation: (from, p, to) => this.#writeAssertedRelation(from, p, to, 'assert'),
            isRunning: () => this.isRunning(),
        });

    }

    /**
     * Getters
     */

    get rootPath() { return this.#rootPath; }
    get status() { return this.#lifecycle.status; }
    get stats() {
        return {
            dbBackend: this.#dbBackend,
            dbPath: this.#rootPath,
            status: this.#lifecycle.status,
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

    async start() { return this.#lifecycle.start(); }

    async #initializeRuntime() {
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
            if (await this.#maintenance.documentStoreIsEmpty()) {
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
        await this.#maintenance.backfillAllDocumentsBitmap();

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
            const healed = await this.#maintenance.backfillAssertedRelations();
            if (healed.patched || healed.orphaned) {
                debug(`start: asserted-relations backfill patched ${healed.patched}, orphaned ${healed.orphaned}`);
            }
            await this.#internalStore.put(RELATIONS_BACKFILL_KEY, new Date().toISOString());
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
        return this.#writes.withWriteLock(async () => {
            return this.#trees.createTree(name, type, options);
        });
    }

    async deleteTree(nameOrId) {
        return this.#writes.withWriteLock(async () => {
            return this.#trees.deleteTree(nameOrId);
        });
    }

    async renameTree(nameOrId, newName) {
        return this.#writes.withWriteLock(async () => {
            return this.#trees.renameTree(nameOrId, newName);
        });
    }

    getTreePaths(nameOrId) {
        return this.#trees.getTreePaths(nameOrId);
    }

    getTreeJson(nameOrId) {
        return this.#trees.getTreeJson(nameOrId);
    }

    async stop() { return this.shutdown(); }

    async shutdown() { return this.#lifecycle.shutdown(); }

    async restart() { return this.#lifecycle.restart(); }

    isRunning() { return this.#lifecycle.status === 'running'; }

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

    async put(document, spec = {}) {
        return this.#writes.withWriteLock(() => this.#writer.put(document, spec));
    }

    async link(idOrIds, spec = {}) {
        return this.#writes.withWriteLock(() => this.#membershipWriter.link(idOrIds, spec));
    }

    async has(id, spec = {}) {
        if (!id) { throw new Error('Document id required'); }
        return await this.#hasOne(id, normalizeDocumentOperationSpec(spec));
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
        return this.#writes.withDeferredMembership(async () => {
            if (!options.meta?.src) {
                throw new Error(
                    'relate() writes DERIVED edges and requires meta.src (e.g. "extractor:foo"); ' +
                    'asserted relations are document-owned — use assertRelation()',
                );
            }
            this.#edges.link(fromId, predicate, toId, options.meta);

            if (options.inheritMemberships) {
                await this.#writes.addDocumentMembership(Number(toId), await this.#synapses.listSynapses(Number(fromId)));
            }
            return true;
        });
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
        return this.#writes.withDeferredMembership(async () => {
            const existing = this.#edges.edge(fromId, predicate, toId);
            if (existing && existing.meta?.src === 'doc') {
                throw new Error(
                    `Edge ${fromId} --${predicate}--> ${toId} is asserted (owned by the document's ` +
                    'data.relations) — use retractRelation() instead of unrelate()',
                );
            }
            return this.#edges.unlink(fromId, predicate, toId);
        });
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
        storedDocument.version = (Number.isInteger(storedDocument.version) ? storedDocument.version : 1) + 1;

        await this.#writes.withDeferredMembership(async () => {
            await this.documents.put(docId, storedDocument);
            await this.#timelineIndex.insert('crud:updated', docId, storedDocument.updatedAt);
            this.#derived.syncDocumentRelations(docId, previous, current);

            this.#emitEvent(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, {
                id: docId, document: storedDocument, reason: 'relations',
            }));
        });
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
        return this.#writes.withWriteLock(() => this.#maintenance.backfillAssertedRelations());
    }

    async unlink(idOrIds, spec = {}) {
        return this.#writes.withWriteLock(() => this.#membershipWriter.unlink(idOrIds, spec));
    }

    async delete(id, options = {}) {
        return this.#writes.withWriteLock(() => this.#deletion.delete(id, options));
    }

    async putMany(documents, spec = {}) {
        return this.#writes.withWriteLock(() => this.#writer.putMany(documents, spec));
    }

    /** Append parsed documents to the Lance FTS table (same payload as putMany phase 3). */
    async indexDocumentsInLance(documents) {
        return this.#writes.withWriteLock(async () => {
            if (!documents?.length) { return; }
            try {
                await this.#lanceIndex.addMany(documents);
            } catch (_) { }
        });
    }

    async optimizeLance() {
        return this.#writes.withWriteLock(async () => {
            return await this.#lanceIndex.optimize();
        });
    }

    /**
     * Optimize dense-vector spaces: compact fragments, prune old versions, and
     * (re)build the ANN index. Pass a space name ('text'|'image') to optimize just
     * that Lance table; omit to optimize every configured space. Best-effort per
     * space — safe to call after a bulk import/re-embed. Returns { <space>: stats }.
     */
    async optimizeVectors(space = null) {
        return this.#writes.withWriteLock(async () => {
            return this.#vectors.optimizeVectors(space);
        });
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
        return this.#writes.withWriteLock(async () => {
            return this.#vectors.dropVectorTable(name);
        });
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
        return this.#writes.withWriteLock(async () => {
            return this.#vectors.clearSpace(space);
        });
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
        return this.#writes.withWriteLock(async () => {
            return this.#vectors.setVectorSpaces(spaces);
        });
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
        return this.#writes.withWriteLock(async () => {
            return this.#vectors.storeDocumentEmbeddings(docId, schema, updatedAt, chunks, opts);
        });
    }

    /**
     * Same as repeated putMany(..., { tree, path }) per path, but one LMDB transaction + one bitmap flush.
     * items: [{ document, path: directoryPath }]
     */
    async putManyDirectoryPaths(items, treeName, featureArray = [], options = {}) {
        return this.#writes.withWriteLock(() => this.#writer.putManyDirectoryPaths(items, treeName, featureArray, options));
    }

    async linkMany(ids, spec = {}) {
        return this.#writes.withWriteLock(() => this.#membershipWriter.linkMany(ids, spec));
    }

    async unlinkMany(ids, spec = {}) {
        return this.#writes.withWriteLock(() => this.#membershipWriter.unlinkMany(ids, spec));
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
        return this.#writes.withWriteLock(async () => {
            if (!name) { throw new Error('Dataset name required'); }
            const key = normalizeBitmapKey(String(name).startsWith('data/dataset/') ? String(name) : `data/dataset/${name}`);
            const bitmap = await this.bitmapIndex.getBitmap(key, false);
            const ids = bitmap ? bitmap.toArray() : [];
            let documentsDeleted = 0;
            let failed = [];
            if (dropDocuments && ids.length > 0) {
                const result = await this.#deletion.deleteMany(ids);
                documentsDeleted = result.successful.length;
                failed = result.failed;
            }
            // deleteMany untick paths may have already emptied it; remove regardless.
            await this.bitmapIndex.deleteBitmap(key, { force: true });
            this.#emitEvent('dataset.deleted', createEvent('dataset.deleted', { name: key.slice('data/dataset/'.length), key, documentsDeleted }));
            return { name: key.slice('data/dataset/'.length), documentsDeleted, failed };
        });
    }

    async deleteMany(ids, options = {}) {
        return this.#writes.withWriteLock(() => this.#deletion.deleteMany(ids, options));
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
        return this.#writes.withWriteLock(async () => {
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

            await this.#writes.withDeferredMembership(() => this.#writes.addDocumentMembership(to, placementKeys));
            return placementKeys;
        });
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

    /**
     * Merge a legacy bitmap key into its canonical form (OR + delete legacy).
     * For callers that know a key's true spelling after the allowed charset
     * widened ('@'/':' used to squash to '_'). Idempotent; returns true when
     * a merge happened.
     */
    async migrateBitmapKey(legacyKey, canonicalKey) {
        return this.#writes.withWriteLock(async () => {
            return this.bitmapIndex.migrateKey(legacyKey, canonicalKey);
        });
    }

    #emitEvent(...args) { return this.#writes.emit(...args); }

    emitTreeEvent(tree, eventName, payload) { return this.#writes.emitTreeEvent(tree, eventName, payload); }

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
        return this.#writes.withWriteLock(() => this.#maintenance.rebuildL3(opts));
    }

    async reindexCrudTimelines({ batchSize = 1000, onProgress = null } = {}) {
        return this.#writes.withWriteLock(() => this.#maintenance.reindexCrudTimelines({ batchSize, onProgress }));
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
        return this.#writes.withWriteLock(() => this.#maintenance.reindexMimeBitmaps({ batchSize, onProgress }));
    }

    /**
     * Backfill the Lance FTS index for every document not yet indexed. Needed for
     * databases populated before FTS existed (or only partially backfilled — start()
     * caps its backfill per run, so a large doc tail can stay unindexed across a few
     * restarts). Idempotent: addMany ticks the `internal/lance/fts` coverage bitmap,
     * so already-indexed docs are skipped. Runs in batches until no progress.
     *
     * Note: this populates BM25 full-text only. Dense vectors for old docs are a
     * separate operation owned by the external embedding service.
     *
     * @returns {Promise<{ indexed, totalDocs, alreadyIndexed }>}
     */
    async reindexSearchIndex({ batchSize = 1000, rebuild = false, onProgress = null } = {}) {
        return this.#writes.withWriteLock(() => this.#maintenance.reindexSearchIndex({ batchSize, rebuild, onProgress }));
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
        return this.#writes.withWriteLock(() => this.#maintenance.reindexEmbeddings(opts));
    }

    clearSync() {
        if (!this.isRunning()) {
            throw new Error('Database is not running');
        }
        this.db.clearSync();// returns void
        return true;
    }

    async clearAsync() {
        return this.#writes.withWriteLock(async () => {
            if (!this.isRunning()) {
                throw new Error('Database is not running');
            }
            await this.db.clearAsync();
            return true;
        });
    }

}

export default SynapsD;
export { EVENTS } from './utils/events.js';
