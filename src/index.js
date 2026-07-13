'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import debugInstance from 'debug';
import { ulid } from 'ulid';
const debug = debugInstance('canvas:synapsd');
const require = createRequire(import.meta.url);
const { RoaringBitmap32 } = require('roaring');

// Errors
import { ArgumentError } from './utils/errors.js';

// Events
import { EVENTS, createEvent } from './utils/events.js';
import { parseLocationUrl } from './utils/path-helpers.js';

// DB Backend
import LmdbBackend from './backends/lmdb/index.js';

// Schemas
import schemaRegistry from './schemas/SchemaRegistry.js';
import { isDocumentData, isDocumentInstance } from './schemas/SchemaRegistry.js';
import BaseDocument from './schemas/BaseDocument.js';

// Indexes
import BitmapIndex from './indexes/bitmaps/index.js';
import ChecksumIndex from './indexes/inverted/Checksum.js';
import TimelineIndex from './indexes/inverted/Timeline.js';
import Synapses from './indexes/inverted/Synapses.js';
import Relations from './indexes/inverted/Relations.js';
import LanceIndex from './indexes/lance/index.js';
import VectorIndex from './indexes/lance/VectorIndex.js';
import { normalizeBitmapKeys, normalizeBitmapKey } from './indexes/bitmaps/lib/keys.js';
import SemanticEngine from './semantic/index.js';

// Views / Abstractions
import ContextTree from './views/ContextTree.js';
import DirectoryTree from './views/DirectoryTree.js';

// Extracted utilities
import { parseContextSpecForInsert, parseBitmapArray } from './utils/parsing.js';
import { parseFilters, applyTimelineFilter } from './utils/filters.js';
import { parseSpec } from './utils/spec.js';
import { parseDocumentData, initializeDocument, parseInitializeDocument } from './utils/document.js';
import QuerySession from './session/QuerySession.js';
import PrefixedStore from './utils/PrefixedStore.js';

// Constants
const INTERNAL_BITMAP_ID_MAX = 100000;
// Default page size for list() when no limit is supplied. "All documents" is an
// explicit opt-in (limit:0), never the implicit default — a full parse on a 7M
// row store is a cost cliff.
const DEFAULT_LIST_LIMIT = 100;
// Startup migration (#migrateBitmapKeys) is an O(all-docs) transaction. Gate it
// behind a persisted version so it runs once per bump instead of on every boot.
// Increment when a new idempotent migration is added.
const SCHEMA_VERSION = 1;
const SCHEMA_VERSION_KEY = 'internal/schemaVersion';

// Presence bitmap for docs carrying a non-empty user-authored comment. A `feature/`
// key so it is non-internal (listed + user-filterable in the toolbox). Ticked/unticked
// from doc state on every write, so it is derived and can never drift.
const COMMENT_BITMAP_KEY = 'feature/has-comment';

// Per-MIME-type presence bitmaps, derived from a doc's metadata.contentType. Two
// keys per doc: the top-level type ('data/mime/image') for modality-scoped scans
// (e.g. image-only reembed = iterate this bitmap instead of re-scanning every doc)
// and the full type ('data/mime/image/jpeg') for granular filtering. Like the
// comment bitmap these are derived from doc state each write (no synapse reverse
// index), so a backfill (reindexMimeBitmaps) reconstructs them for existing docs.
// The generic inline-JSON default is skipped: notes/tabs/emails are all
// application/json, so it would only shadow the schema bitmaps with no new signal.
const MIME_BITMAP_PREFIX = 'data/mime/';
const GENERIC_MIME = 'application/json';
function mimeBitmapKeys(doc) {
    const raw = typeof doc?.metadata?.contentType === 'string' ? doc.metadata.contentType : '';
    const clean = raw.split(';')[0].trim().toLowerCase(); // drop '; charset=...' params
    if (!clean || clean === GENERIC_MIME) { return []; }
    const slash = clean.indexOf('/');
    if (slash <= 0 || slash >= clean.length - 1) { return []; } // not a valid type/subtype
    const type = clean.slice(0, slash);
    return normalizeBitmapKeys([`${MIME_BITMAP_PREFIX}${type}`, `${MIME_BITMAP_PREFIX}${clean}`]);
}

// Union extra locations into a document by url (used by in-batch content dedup,
// where two identical blobs carry different file:// locations). Mutates target.
function mergeDocumentLocations(target, extraLocations) {
    if (!Array.isArray(extraLocations) || extraLocations.length === 0) { return; }
    if (!Array.isArray(target.locations)) { target.locations = []; }
    const seen = new Set(target.locations.map((l) => l && l.url));
    for (const loc of extraLocations) {
        if (loc && loc.url && !seen.has(loc.url)) {
            target.locations.push(loc);
            seen.add(loc.url);
        }
    }
}

/**
 * Simplified SynapsD class
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

    // Tree Abstractions
    #treeCache = new Map();
    #treeMetadata = new Map();
    #defaultTreeIds = {
        context: null,
        directory: null,
    };

    // Bitmap Indexes
    #bitmapStore;   // Bitmap store
    #bitmapCache;   // In-memory cache for bitmap storage

    // Inverted Indexes
    #checksumIndex;
    #timelineIndex;
    #synapses;
    #relations;

    // Active deferred-membership buffer. Bitmap ticks/unticks are NOT bound to the
    // LMDB transaction (they mutate a shared, never-evicting in-memory cache via
    // putSync). To keep bitmaps consistent with a rolled-back write, membership
    // mutations are buffered during a #withDeferredMembership transaction and only
    // flushed to bitmaps after the transaction commits — discarded on rollback.
    // The synapse reverse-index (durable truth) is still written inside the tx.
    #membershipBuffer = null;

    // LanceDB
    #lanceIndex;

    // Semantic recall (dense + hybrid vector search)
    #semantic;
    #vectorIndex;              // the 'text' space (primary; drives search)
    #vectorSpaces = new Map(); // space name -> VectorIndex (includes 'text')
    #semanticConfig;

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
        this.#semantic = new SemanticEngine({ db: this });

        // Semantic / dense-vector config. Disabled => fts-only (vector + hybrid
        // search degrade gracefully to lexical). synapsd owns no embedding model:
        // vectors arrive via storeDocumentEmbeddings (the embedd service / any app),
        // and query embedding is an injected `embedQuery(text, space)` callback.
        const sem = options.semantic || {};
        this.#semanticConfig = {
            enabled: sem.enabled !== false,
            dim: sem.dim || 384,
            // Injected query-embedder (embedd service). Absent → vector/hybrid
            // search degrades to FTS (see rank()).
            embedQuery: typeof sem.embedQuery === 'function' ? sem.embedQuery : null,
            // Default candidate schemas for the unembedded-gap ledger when a caller
            // passes none. embedd normally supplies per-space candidate schemas.
            embeddableSchemas: new Set(sem.embeddableSchemas || ['data/abstraction/note']),
            // Vector "spaces": one LanceDB table per embedding model/dim. The
            // embedd service pushes vectors keyed by space; text keeps the legacy
            // table + bitmap key so existing data is not orphaned.
            spaces: sem.spaces || {
                text: { table: 'vec_text', dim: sem.dim || 384, bitmapKey: 'internal/lance/vectors' },
                // annIndex:false — image search is CROSS-MODAL (text query vector vs
                // photo vectors) with a tight distance floor. Lance's quantized ANN
                // indexes (SQ/PQ) train on the stored (image) distribution; a text
                // query lands far outside it and gets back wrong neighbours with
                // wildly inflated distances (measured: true 0.96 → ANN 1.49), which
                // the imageMaxDistance floor then rejects wholesale → zero results.
                // Exact scan is correct and fast at this scale once compacted.
                image: { table: 'vec_image', dim: 768, bitmapKey: 'internal/lance/vectors/image', annIndex: false },
            },
            // Image search relevance floor (cosine distance, 0 = identical). CLIP
            // image kNN returns its top-K for ANY query, so without a cap every
            // search folds in unrelated photos. 0.945 calibrated against SigLIP
            // base fp32 (embedd's default dtype): true matches measured at
            // 0.90–0.94 across car/wine/table/audi known-item queries, noise
            // floor starts ~0.95. (The old 0.97 default was calibrated on q8
            // vectors.) Live-tunable per workspace (setSearchTuning) and
            // env-overridable (CANVAS_IMAGE_MAX_DISTANCE). null/0 = no floor.
            imageMaxDistance: typeof sem.imageMaxDistance === 'number' ? sem.imageMaxDistance : 0.945,
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

        this.contextBitmapCollection = null;

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

        if (!this.#semanticConfig?.enabled) {
            out.semantic = { enabled: false };
            return out;
        }

        // Per-space stats for every CONFIGURED vector space (text + image), not
        // just the ones lazily initialized so far — otherwise the image space
        // disappears from the summary until something embeds/queries it. Lazily
        // opens each (embeddedDocs comes from the persistent presence bitmap, so
        // the count is right even for a freshly-opened table).
        const vectorSpaces = {};
        for (const name of Object.keys(this.#semanticConfig.spaces || {})) {
            try {
                const vi = await this.#getVectorSpace(name);
                vectorSpaces[name] = vi ? await vi.stats() : { ready: false };
            } catch (e) { vectorSpaces[name] = { ready: false, error: e.message }; }
        }

        out.semantic = {
            enabled: true,
            dim: this.#semanticConfig.dim,
            // Embedding is external (embedd service); synapsd owns no model.
            embedder: 'external',
            embedQuery: !!this.#semanticConfig.embedQuery,
            embeddableSchemas: [...this.#semanticConfig.embeddableSchemas],
            spaces: Object.keys(this.#semanticConfig.spaces || {}),
            // Tunable search knobs (surfaced so the UI can show/edit current values).
            imageMaxDistance: this.#semanticConfig.imageMaxDistance,
            searchWeights: { ...this.#semanticConfig.searchWeights },
            // Back-compat: `vector` stays the text space; `vectorSpaces` breaks it
            // out per space (text, image, …) so image embedding is observable.
            vector: vectorSpaces.text || (this.#vectorIndex ? await this.#vectorIndex.stats().catch(e => ({ ready: false, error: e.message })) : { ready: false }),
            vectorSpaces,
        };
        return out;
    }

    /**
     * Live-tunable search knobs (no restart): the image relevance floor and the
     * hybrid RRF fusion weights.
     * @param {{imageMaxDistance?: number|null, searchWeights?: {fts?:number, dense?:number, image?:number}}} tuning
     */
    setSearchTuning(tuning = {}) {
        if (Object.prototype.hasOwnProperty.call(tuning, 'imageMaxDistance')) {
            const v = tuning.imageMaxDistance;
            this.#semanticConfig.imageMaxDistance = (v === null || Number.isFinite(v)) ? v : this.#semanticConfig.imageMaxDistance;
        }
        if (tuning.searchWeights && typeof tuning.searchWeights === 'object') {
            const w = this.#semanticConfig.searchWeights;
            for (const k of ['fts', 'dense', 'image']) {
                const v = tuning.searchWeights[k];
                if (Number.isFinite(v) && v >= 0) { w[k] = v; }
            }
        }
        return {
            imageMaxDistance: this.#semanticConfig.imageMaxDistance,
            searchWeights: { ...this.#semanticConfig.searchWeights },
        };
    }

    get db() { return this.#db; } // For testing only

    // Inverted indexes
    get checksumIndex() { return this.#checksumIndex; }
    get timeline() { return this.#timelineIndex; }
    get synapses() { return this.#synapses; }
    get relations() { return this.#relations; }
    get semantic() { return this.#semantic; }

    /**
     * Service methods
     */

    async start() {
        debug('Starting SynapsD');
        try {
            // Initialize deletedDocumentsBitmap here
            this.deletedDocumentsBitmap = await this.bitmapIndex.createBitmap('internal/gc/deleted');

            this.#timelineIndex = new TimelineIndex(this.bitmapIndex);

            // Initialize Synapses inverted index
            this.#synapses = new Synapses(
                this.#db.createDataset('synapses'),
                this.bitmapIndex
            );

            // Typed doc<->doc relations (rel/* bitmaps; reuses bitmapIndex,
            // delegates membership inheritance to Synapses).
            this.#relations = new Relations(this.bitmapIndex, this.#synapses);

            // Initialize LanceDB under workspace root (rootPath/lance)
            this.#lanceIndex = new LanceIndex({
                rootPath: path.join(this.#rootPath, 'lance'),
                bitmapIndex: this.bitmapIndex,
            });
            await this.#lanceIndex.initialize();
            await this.#lanceIndex.backfill(this.bitmapIndex, this.documents, parseInitializeDocument, 1000);

            // Dense-vector stack (best-effort: failure leaves fts-only search intact)
            if (this.#semanticConfig.enabled) {
                try {
                    const textSpace = this.#semanticConfig.spaces.text || { table: 'vec_text', dim: this.#semanticConfig.dim, bitmapKey: 'internal/lance/vectors' };
                    this.#vectorIndex = new VectorIndex({
                        rootPath: path.join(this.#rootPath, 'lance'),
                        tableName: textSpace.table,
                        dim: textSpace.dim,
                        vectorBitmapKey: textSpace.bitmapKey,
                        bitmapIndex: this.bitmapIndex,
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

            await this.#semantic.initialize();

            await this.#loadTreeRegistry();
            await this.#ensureDefaultTrees();

            // True one-time legacy-format migration, gated behind a persisted
            // schema version so its O(all-docs) pass runs once per bump, not on
            // every startup.
            const appliedVersion = Number(this.#internalStore.get(SCHEMA_VERSION_KEY)) || 0;
            if (appliedVersion < SCHEMA_VERSION) {
                debug(`Schema migrations: applied=${appliedVersion} < current=${SCHEMA_VERSION}, running`);
                await this.#migrateBitmapKeys();
                await this.#internalStore.put(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
            } else {
                debug(`Schema migrations: up to date (v${appliedVersion}), skipping`);
            }

            // Set status
            this.#status = 'running';

            this.emit(EVENTS.STARTED, createEvent(EVENTS.STARTED));
            debug('SynapsD started');
        } catch (error) {
            this.#status = 'error';
            debug('SynapsD database error during startup: ', error);
            throw error;
        }
    }

    async listTrees(type = null) {
        const trees = Array.from(this.#treeMetadata.values());
        return type ? trees.filter((tree) => tree.type === type) : trees;
    }

    getTree(nameOrId) {
        if (!nameOrId) {
            return null;
        }

        const directMatch = this.#treeMetadata.get(String(nameOrId));
        if (directMatch) {
            return this.#instantiateTree(directMatch);
        }

        const normalized = this.#normalizeTreeName(nameOrId);
        for (const meta of this.#treeMetadata.values()) {
            if (this.#normalizeTreeName(meta.name) === normalized) {
                return this.#instantiateTree(meta);
            }
        }

        return null;
    }

    getDefaultContextTree() {
        return this.#getDefaultTreeByType('context');
    }

    getDefaultDirectoryTree() {
        return this.#getDefaultTreeByType('directory');
    }

    async createTree(name, type = 'context', options = {}) {
        const normalizedName = this.#normalizeTreeName(name);
        if (!normalizedName) { throw new Error('Tree name is required'); }
        if (!['context', 'directory'].includes(type)) { throw new Error(`Unsupported tree type "${type}"`); }
        if (this.getTree(name)) { throw new Error(`Tree already exists: ${name}`); }

        const now = new Date().toISOString();
        const meta = {
            id: options.id || ulid(),
            name: String(name).trim(),
            type,
            createdAt: now,
            updatedAt: now,
            isDefault: options.isDefault ?? !this.#defaultTreeIds[type],
            // Generic per-tree settings bag; synapsd only interprets generic
            // flags (e.g. linkContextRoot) — policy names live at the caller.
            settings: options.settings && typeof options.settings === 'object'
                ? { ...options.settings }
                : {},
        };

        await this.#internalStore.put(this.#treeMetaKey(meta.id), meta);
        this.#treeMetadata.set(meta.id, meta);
        if (meta.isDefault || !this.#defaultTreeIds[type]) {
            this.#defaultTreeIds[type] = meta.id;
        }

        const tree = this.#instantiateTree(meta);
        await tree.initialize();
        if (type === 'context' && meta.id === this.#defaultTreeIds.context) {
            this.contextBitmapCollection = tree.collection || this.#contextBitmapCollectionForTree(meta.id);
        }

        this.emit(EVENTS.TREE_CREATED, createEvent(EVENTS.TREE_CREATED, { treeId: meta.id, treeName: meta.name, treeType: meta.type }));
        return meta;
    }

    async deleteTree(nameOrId) {
        const meta = this.#resolveTreeMeta(nameOrId);
        if (!meta) { throw new Error(`Tree not found: ${nameOrId}`); }
        await this.#deleteTreeStorage(meta);
        this.#treeMetadata.delete(meta.id);
        this.#treeCache.delete(meta.id);
        if (this.#defaultTreeIds[meta.type] === meta.id) {
            this.#defaultTreeIds[meta.type] = null;
            const next = (await this.listTrees(meta.type))[0];
            if (next) {
                this.#defaultTreeIds[meta.type] = next.id;
            }
        }
        this.emit(EVENTS.TREE_DELETED, createEvent(EVENTS.TREE_DELETED, { treeId: meta.id, treeName: meta.name, treeType: meta.type }));
        return true;
    }

    async renameTree(nameOrId, newName) {
        const meta = this.#resolveTreeMeta(nameOrId);
        if (!meta) { throw new Error(`Tree not found: ${nameOrId}`); }
        if (this.getTree(newName)) { throw new Error(`Tree already exists: ${newName}`); }
        meta.name = String(newName).trim();
        meta.updatedAt = new Date().toISOString();
        await this.#internalStore.put(this.#treeMetaKey(meta.id), meta);
        // Update the cached instance so `tree.name` reflects the rename instead
        // of the stale construction-time value.
        const cached = this.#treeCache.get(meta.id);
        if (cached) { cached.name = meta.name; }
        this.emit(EVENTS.TREE_RENAMED, createEvent(EVENTS.TREE_RENAMED, { treeId: meta.id, treeName: meta.name, treeType: meta.type }));
        return meta;
    }

    getTreePaths(nameOrId) {
        const tree = this.getTree(nameOrId);
        if (!tree) { throw new Error(`Tree not found: ${nameOrId}`); }
        return tree.paths;
    }

    getTreeJson(nameOrId) {
        const tree = this.getTree(nameOrId);
        if (!tree) { throw new Error(`Tree not found: ${nameOrId}`); }
        return tree.buildJsonTree();
    }

    async stop() { return this.shutdown(); }

    async shutdown() {
        debug('Shutting down SynapsD');
        try {
            this.#status = 'shutting down';
            this.emit(EVENTS.BEFORE_SHUTDOWN, createEvent(EVENTS.BEFORE_SHUTDOWN));
            // Close index backends
            // LanceDB uses filesystem-based storage; no explicit close needed.
            // No embedding worker to tear down — embedding lives in the external
            // embedd service, which the server stops separately.
            // Close database backend
            await this.#db.close();

            this.#status = 'shutdown';
            this.emit(EVENTS.SHUTDOWN, createEvent(EVENTS.SHUTDOWN));

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

    async put(document, spec = {}) {
        const normSpec = this.#normalizeDocumentOperationSpec(spec);

        if (!document || typeof document !== 'object' || Array.isArray(document)) {
            throw new Error('Document object is required');
        }

        if (document.id !== undefined && document.id !== null) {
            const existing = await this.#getById(document.id);
            if (existing) {
                return await this.#updateOne(document.id, document, normSpec);
            }
        }

        return await this.#putOne(document, normSpec);
    }

    async link(idOrIds, spec = {}) {
        if (Array.isArray(idOrIds)) {
            return await this.linkMany(idOrIds, spec);
        }
        if (!idOrIds) { throw new Error('Document id required'); }
        return await this.#linkOne(idOrIds, this.#normalizeDocumentOperationSpec(spec));
    }

    async has(id, spec = {}) {
        if (!id) { throw new Error('Document id required'); }
        return await this.#hasOne(id, this.#normalizeDocumentOperationSpec(spec));
    }

    async unlink(idOrIds, spec = {}) {
        if (Array.isArray(idOrIds)) {
            return await this.unlinkMany(idOrIds, spec);
        }
        if (!idOrIds) { throw new Error('Document id required'); }
        return await this.#unlinkOne(idOrIds, this.#normalizeDocumentOperationSpec(spec), spec);
    }

    async delete(id, options = {}) {
        if (!id) { throw new Error('Document id required'); }
        return await this.#deleteOne(id, options);
    }

    async putMany(documents, spec = {}) {
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
                let prevChecksums = null;
                let prevLocations = null;
                let prevComment = null;
                let prevTimelineState = null;

                // Dedup priority: a supplied id that exists is an UPDATE — the id
                // is the stable key every bitmap/timeline/checksum reference hangs
                // off, so it must be preserved (no new id minted). Only when no id
                // matches do we fall back to content-addressed (checksum) dedup
                // (id-less re-imports of the same content resolve to one doc).
                // Ids are integers; a numeric-string id is normalized before
                // lookup so the update path resolves and the id is preserved.
                const suppliedId = (doc && doc.id !== undefined && doc.id !== null)
                    ? (typeof doc.id === 'string' ? parseInt(doc.id, 10) : doc.id)
                    : null;
                if (suppliedId !== null && !Number.isNaN(suppliedId)) {
                    existing = await this.#getById(suppliedId).catch(() => null);
                    if (existing) {
                        isUpdate = true;
                        // Snapshot previous state BEFORE update() mutates in place,
                        // so stale checksums/timelines/device tags can be cleaned.
                        prevChecksums = Array.isArray(existing.checksumArray) ? [...existing.checksumArray] : [];
                        prevLocations = Array.isArray(existing.locations) ? [...existing.locations] : [];
                        prevComment = typeof existing.comment === 'string' ? existing.comment : '';
                        prevTimelineState = {
                            timelines: Array.isArray(existing.timelines)
                                ? existing.timelines.map(entry => ({ ...entry }))
                                : [],
                        };
                        // Merge input onto existing (preserves locations, metadata,
                        // parentId chain; regenerates checksums when data changed).
                        parsed = existing.update(doc);
                        // update() trusts data.id verbatim (and returns the same
                        // mutated instance) — re-assert the canonical numeric id
                        // so a string-coerced input can't fork the storage key.
                        parsed.id = suppliedId;
                    }
                }

                if (!parsed) {
                    parsed = isDocumentInstance(doc) ? doc : parseInitializeDocument(doc);
                    parsed.validateData();

                    const primaryChecksum = parsed.getPrimaryChecksum();
                    existing = await this.getByChecksumString(primaryChecksum).catch(() => null);
                    if (existing) {
                        parsed.id = existing.id;
                        if (existing.createdAt) { parsed.createdAt = existing.createdAt; }
                        if (existing.updatedAt) { parsed.updatedAt = existing.updatedAt; }
                        prevChecksums = Array.isArray(existing.checksumArray) ? [...existing.checksumArray] : [];
                        prevLocations = Array.isArray(existing.locations) ? [...existing.locations] : [];
                        prevComment = typeof existing.comment === 'string' ? existing.comment : '';
                        prevTimelineState = {
                            timelines: Array.isArray(existing.timelines)
                                ? existing.timelines.map(entry => ({ ...entry }))
                                : [],
                        };
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

                const docFeatures = [...featureBitmaps];
                if (!docFeatures.includes(parsed.schema)) {
                    docFeatures.push(parsed.schema);
                }

                const entry = { parsed, existing: !!existing, isUpdate, prevChecksums, prevLocations, prevComment, prevTimelineState, docFeatures };
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
            await this.#withDeferredMembership(async () => {
                for (const { parsed, existing, isUpdate, prevChecksums, prevLocations, prevTimelineState, docFeatures } of prepared) {
                    await this.documents.put(parsed.id, parsed);

                    // Re-point the checksum index: drop checksums the edit dropped
                    // (empty diff for checksum-matched re-indexes), insert current.
                    if (existing && prevChecksums) {
                        const staleChecksums = prevChecksums.filter(c => !parsed.checksumArray.includes(c));
                        if (staleChecksums.length) await this.#checksumIndex.deleteArray(staleChecksums);
                    }
                    await this.#checksumIndex.insertArray(parsed.checksumArray, parsed.id);

                    // crud:created only for genuinely new docs; updates keep their createdAt
                    if (!isUpdate) {
                        await this.#timelineIndex.insert('crud:created', parsed.id, parsed.createdAt || new Date());
                    }
                    if (parsed.updatedAt) await this.#timelineIndex.insert('crud:updated', parsed.id, parsed.updatedAt);
                    if (existing && prevTimelineState) await this.#removeDocumentTimelines(parsed.id, prevTimelineState, parsed);
                    await this.#indexDocumentTimelines(parsed.id, parsed);
                    await this.#indexDocument(parsed.id, contextSpec, directorySpec, docFeatures);
                    if (existing) {
                        await this.#removeStaleDeviceMembership(parsed.id, prevLocations || [], parsed.locations, docFeatures);
                    }
                    await this.#applyMembership(parsed.hasComment ? 'tick' : 'untick', parsed.id, [COMMENT_BITMAP_KEY]);
                    const mimeKeys = mimeBitmapKeys(parsed);
                    if (mimeKeys.length) { await this.#applyMembership('tick', parsed.id, mimeKeys); }
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
        const isContentChanged = (p) => {
            if (!p.existing) { return true; }
            // A comment-only edit leaves the checksum untouched but changes FTS text
            // (generateFtsData always includes the comment), so it must reindex too.
            if ((p.prevComment ?? '') !== (typeof p.parsed.comment === 'string' ? p.parsed.comment : '')) { return true; }
            const prev = p.prevChecksums;
            if (!Array.isArray(prev)) { return true; }
            const cur = p.parsed.checksumArray || [];
            if (prev.length !== cur.length) { return true; }
            const prevSet = new Set(prev);
            return cur.some((c) => !prevSet.has(c));
        };
        const reindexDocs = prepared.filter(isContentChanged);

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
            this.#emitTreeDocumentEvent(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, 'context', contextSpec, storedIds);
            this.#emitTreeDocumentEvent(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, 'directory', directorySpec, storedIds);
        }

        // Split inserts from updates so consumers (ws bridge, UIs) can tell an
        // edit from a new document — an in-place update keeps the same id.
        const insertedIds = prepared.filter(p => !p.isUpdate).map(p => p.parsed.id);
        const updatedIds = prepared.filter(p => p.isUpdate).map(p => p.parsed.id);

        if (insertedIds.length > 0) {
            // Singular event with `batch: true` kept for pre-batch consumers
            // (ws bridge, embedd enqueue); the .batch event is the canonical
            // one for batch-aware consumers (workspace hooks).
            this.emit(EVENTS.DOCUMENT_INSERTED, createEvent(EVENTS.DOCUMENT_INSERTED, {
                ids: insertedIds,
                count: insertedIds.length,
                batch: true,
                context: contextSpec,
                directory: directorySpec,
                ...(normSpec.provenance || {}),
            }));
            this.emit(EVENTS.DOCUMENT_INSERTED_BATCH, createEvent(EVENTS.DOCUMENT_INSERTED_BATCH, {
                ids: insertedIds,
                count: insertedIds.length,
                context: contextSpec,
                directory: directorySpec,
                ...(normSpec.provenance || {}),
            }));
        }
        if (updatedIds.length > 0) {
            this.emit(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, {
                ids: updatedIds,
                count: updatedIds.length,
                batch: true,
                ...(normSpec.provenance || {}),
            }));
            this.emit(EVENTS.DOCUMENT_UPDATED_BATCH, createEvent(EVENTS.DOCUMENT_UPDATED_BATCH, {
                ids: updatedIds,
                count: updatedIds.length,
                context: contextSpec,
                directory: directorySpec,
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
        const names = space ? [space] : Object.keys(this.#semanticConfig.spaces || {});
        const out = {};
        for (const name of names) {
            const vi = await this.#getVectorSpace(name);
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

    /** Per-space "seen" bitmap key — docs the embedder has processed (incl. skips). */
    #seenKey(space) { return `internal/embed/seen/${space}`; }

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
            : Array.from(this.#semanticConfig.embeddableSchemas);
        // The user-authored comment always embeds into the text space, so any doc
        // carrying one belongs in the text gap even when its schema is not otherwise
        // embeddable (photos, files, tabs). hasComment AND-NOT seen = lazy-embed queue.
        const keys = space === 'text' ? [...cand, COMMENT_BITMAP_KEY] : cand;
        if (keys.length === 0) { return []; }
        const set = await this.bitmapIndex.OR(normalizeBitmapKeys(keys));
        if (!set || set.isEmpty) { return []; }
        const seen = await this.bitmapIndex.getBitmap(this.#seenKey(space), false);
        if (seen) { set.andNotInPlace(seen); }
        return set.toArray();
    }

    /**
     * Wipe an embedding space for a full re-embed: drop its vectors + presence
     * bitmap + seen ledger. After this, getUnembeddedDocIds returns everything.
     * @param {string} space
     */
    async clearSpace(space = 'text') {
        const vi = await this.#getVectorSpace(space);
        if (!vi) { return false; }
        // Ids currently tracked in either bitmap.
        const seenKey = this.#seenKey(space);
        const presenceKey = this.#semanticConfig.spaces[space]?.bitmapKey;
        const ids = new Set();
        for (const key of [seenKey, presenceKey]) {
            if (!key) { continue; }
            const bm = await this.bitmapIndex.getBitmap(key, false);
            if (bm) { for (const id of bm.toArray()) { ids.add(id); } }
        }
        const idArr = [...ids];
        if (idArr.length > 0) {
            await vi.deleteMany(idArr);                       // rows + presence untick
            try { await this.bitmapIndex.untickMany([seenKey], idArr); } catch (_) { }
        }
        return true;
    }

    /**
     * kNN the image (CLIP/SigLIP) space with a text query embedded by that space's
     * text encoder — the joint space means "red car" lands near matching photos.
     * Returns [] (and loads no model) unless photos are actually embedded, so
     * text-only searches never pay for the image model.
     *
     * Two floor modes:
     * - absolute (default): drop hits beyond imageMaxDistance. Right for global
     *   queries, where the floor separates "is a match at all" from noise.
     * - relative (`opts.relativeFloor`, refinement stages): the scope already
     *   established relevance (e.g. 40 car photos), so an absolute floor is wrong —
     *   "red" over car photos peaks around 0.95+, above the global floor, yet the
     *   reddest cars ARE the answer. Keep everything within REFINE_MARGIN of the
     *   scope's best hit instead: adaptive, narrows to the closest cluster.
     * @returns {Promise<number[]>} candidate docIds, best-first
     */
    async #imageVectorSearch(queryString, scopedIds, depth, opts = {}) {
        const cfg = this.#semanticConfig.spaces?.image;
        const embedQuery = this.#semanticConfig.embedQuery;
        if (!cfg || typeof embedQuery !== 'function') { return []; }
        const presence = await this.bitmapIndex.getBitmap(cfg.bitmapKey, false);
        if (!presence || presence.isEmpty) { return []; }
        const vi = await this.#getVectorSpace('image');
        if (!vi || !vi.isReady) { return []; }
        const qv = await embedQuery(queryString, 'image');
        if (!qv) { return []; }
        if (opts.relativeFloor) {
            const envMargin = Number(process.env.CANVAS_IMAGE_REFINE_MARGIN);
            const margin = Number.isFinite(envMargin) && envMargin > 0 ? envMargin : 0.035;
            const res = await vi.vectorSearch(qv, scopedIds, { limit: depth, offset: 0, minDistance: 0, maxDistance: 2, withDistances: true });
            const ids = res.pageIds || [];
            if (ids.length === 0) { return []; }
            const dist = res.distances || {};
            const best = dist[ids[0]];
            if (!Number.isFinite(best)) { return ids; }
            return ids.filter((id) => Number.isFinite(dist[id]) && dist[id] <= best + margin);
        }
        // Relevance floor (cosine distance cap, 0 = identical; smaller = stricter):
        // image kNN otherwise returns its top-K for ANY query, so every search folds
        // in unrelated photos. Precedence: env override → workspace setting →
        // fp32-calibrated default. A non-positive value disables the floor
        // (legacy top-K behaviour).
        const envMax = process.env.CANVAS_IMAGE_MAX_DISTANCE;
        const cfgMax = (envMax != null && envMax !== '') ? Number(envMax) : this.#semanticConfig.imageMaxDistance;
        const maxDistance = Number.isFinite(cfgMax) && cfgMax > 0 ? cfgMax : undefined;
        const res = await vi.vectorSearch(qv, scopedIds, { limit: depth, offset: 0, maxDistance });
        return res.pageIds || [];
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
     * @returns {Promise<number[]>}
     */
    async #queryMatchSet(queryString, scopeIds, limit, opts = {}) {
        const [fts, img] = await Promise.all([
            this.#lanceIndex.ftsQuery(queryString, scopeIds, { limit, offset: 0 }).catch(() => ({ pageIds: [] })),
            this.#imageVectorSearch(queryString, scopeIds, limit, { relativeFloor: !!opts.relativeImageFloor }).catch(() => []),
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
        const cfg = this.#semanticConfig.spaces?.image;
        const embedQuery = this.#semanticConfig.embedQuery;
        if (!cfg || typeof embedQuery !== 'function') { return []; }
        const presence = await this.bitmapIndex.getBitmap(cfg.bitmapKey, false);
        if (!presence || presence.isEmpty) { return []; }
        const vi = await this.#getVectorSpace('image');
        if (!vi || !vi.isReady) { return []; }
        const qv = await embedQuery(queryString, 'image');
        if (!qv) { return []; }
        // min 0 / max 2 forces cosine and keeps the full range (no filtering), so
        // every returned neighbour comes back with an interpretable distance.
        const res = await vi.vectorSearch(qv, scopedIds, { limit: n, offset: 0, minDistance: 0, maxDistance: 2, withDistances: true });
        const dist = res.distances || {};
        return (res.pageIds || []).map((id) => ({ id, distance: dist[id] }));
    }

    /**
     * Lazily create + initialize the VectorIndex for a named space. Returns null
     * if the semantic stack is disabled or the space is unknown.
     */
    async #getVectorSpace(space) {
        if (!this.#semanticConfig.enabled) { return null; }
        if (this.#vectorSpaces.has(space)) { return this.#vectorSpaces.get(space); }
        const cfg = this.#semanticConfig.spaces[space];
        if (!cfg) { debug(`unknown vector space '${space}'`); return null; }
        try {
            const vi = new VectorIndex({
                rootPath: path.join(this.#rootPath, 'lance'),
                tableName: cfg.table,
                dim: cfg.dim,
                vectorBitmapKey: cfg.bitmapKey,
                bitmapIndex: this.bitmapIndex,
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

    /**
     * Store app-provided chunk vectors for a document (the non-JSON / media path —
     * server doesn't decode blobs, the embedd service computes and ships vectors).
     * Content chunks use ordinal chunkIds (0..N). chunkId -1 is RESERVED for the
     * doc's user-authored comment chunk (embedd's COMMENT_CHUNK_ID), so it never
     * collides with content ordinals and keeps provenance at the vector layer.
     * @param {number} docId
     * @param {string} schema
     * @param {string} updatedAt
     * @param {{chunkId:number, text?:string, vector:number[]}[]} chunks
     * @param {{space?:string}} [opts] target embedding space (default 'text')
     */
    async storeDocumentEmbeddings(docId, schema, updatedAt, chunks, opts = {}) {
        const space = opts.space || 'text';
        const vi = await this.#getVectorSpace(space);
        if (!vi) { return false; }
        // upsertChunks ticks the presence bitmap when chunks>0 (unticks otherwise).
        await vi.upsertChunks(docId, schema, updatedAt, chunks);
        // Always mark the doc as processed in the ledger — even a deliberate skip
        // (0 chunks) must leave the unembedded gap, or reconcile re-fetches it forever.
        try { await this.bitmapIndex.tick(this.#seenKey(space), Number(docId)); } catch (_) { }
        return true;
    }

    /**
     * Same as repeated putMany(..., { tree, path }) per path, but one LMDB transaction + one bitmap flush.
     * items: [{ document, path: directoryPath }]
     */
    async putManyDirectoryPaths(items, treeName, featureArray = [], options = {}) {
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
                const existing = await this.getByChecksumString(primaryChecksum).catch(() => null);
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
                if (!docFeatures.includes(parsed.schema)) {
                    docFeatures.push(parsed.schema);
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
            await this.#withDeferredMembership(async () => {
                for (const { parsed, docFeatures, directorySpecs } of prepared) {
                    await this.documents.put(parsed.id, parsed);
                    await this.#checksumIndex.insertArray(parsed.checksumArray, parsed.id);
                    await this.#timelineIndex.insert('crud:created', parsed.id, parsed.createdAt || new Date());
                    if (parsed.updatedAt) await this.#timelineIndex.insert('crud:updated', parsed.id, parsed.updatedAt);
                    await this.#indexDocumentTimelines(parsed.id, parsed);
                    // One doc can be linked under multiple directory paths (folded dups).
                    for (const directorySpec of directorySpecs) {
                        await this.#indexDocument(parsed.id, null, directorySpec, docFeatures);
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
            this.emit(EVENTS.DOCUMENT_INSERTED, createEvent(EVENTS.DOCUMENT_INSERTED, {
                ids: storedIds,
                count: storedIds.length,
                batch: true,
                directory: { tree: prepared[0]?.directorySpecs[0]?.tree, paths: directoryPaths },
            }));
        }

        return storedIds;
    }

    async linkMany(ids, spec = {}) {
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
            if (!docFeatures.includes(doc.schema)) {
                docFeatures.push(doc.schema);
            }
            toProcess.push({ index, id, docFeatures });
        }

        if (toProcess.length === 0) { return result; }

        // Single transaction for all index operations
        try {
            await this.#withDeferredMembership(async () => {
                for (const { id, docFeatures } of toProcess) {
                    await this.#indexDocument(id, contextSpec, directorySpec, docFeatures);
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
            if (ids.length === 1) {
                this.emit(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, {
                    id: ids[0],
                    memberships: { context: contextSpec, directory: directorySpec },
                    ...(normSpec.provenance || {}),
                }));
            } else if (ids.length > 1) {
                this.emit(EVENTS.DOCUMENT_UPDATED_BATCH, createEvent(EVENTS.DOCUMENT_UPDATED_BATCH, {
                    ids,
                    memberships: { context: contextSpec, directory: directorySpec },
                    ...(normSpec.provenance || {}),
                }));
            }

            // Tree-scoped events drive the web UI content refresh + browser
            // extension. Batch helper handles the single/none cases internally.
            this.#emitTreeDocumentEvent(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, 'context', contextSpec, ids);
            this.#emitTreeDocumentEvent(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, 'directory', directorySpec, ids);
        } catch (eventError) {
            debug(`linkMany: Failed to emit events: ${eventError.message}`);
        }

        return result;
    }

    async unlinkMany(ids, spec = {}) {
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
                const { tree: contextTree, collection: contextCollection, path: normalizedContextSpec } = this.#resolveTreeSelection('context', contextSpec, '/');
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
                    removedContextPaths.push(...targetLayers);
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
                const { tree: directoryTree, collection: directoryCollection, path: normalizedDirectoryPath } = this.#resolveTreeSelection('directory', directorySpec, '/');
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
            await this.#withDeferredMembership(async () => {
                for (const { id } of validEntries) {
                    if (uniqueLayers.length > 0) {
                        await this.#removeDocumentMembership(id, uniqueLayers);
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
                contextArray: removedContextPaths,
                directoryArray: removedDirectoryPaths,
                featureArray: featureKeys,
                recursive,
                ...(normSpec.provenance || {}),
            };
            if (ids.length === 1) {
                this.emit(EVENTS.DOCUMENT_REMOVED, createEvent(EVENTS.DOCUMENT_REMOVED, { id: ids[0], ...shared }));
            } else if (ids.length > 1) {
                this.emit(EVENTS.DOCUMENT_REMOVED_BATCH, createEvent(EVENTS.DOCUMENT_REMOVED_BATCH, { ids, ...shared }));
            }

            // Tree-scoped events drive cross-client auto-close (browser extension)
            // and web UI refresh — they carry the path + tree id/name the consumers
            // match on. Emit for whichever tree(s) the unlink touched.
            this.#emitTreeDocumentEvent(EVENTS.TREE_DOCUMENT_REMOVED_BATCH, 'context', contextSpec, ids);
            this.#emitTreeDocumentEvent(EVENTS.TREE_DOCUMENT_REMOVED_BATCH, 'directory', directorySpec, ids);
        } catch (eventError) {
            debug(`unlinkMany: Failed to emit events: ${eventError.message}`);
        }

        return result;
    }

    async deleteMany(ids, options = {}) {
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
            await this.#withDeferredMembership(async () => {
                for (const { id, document } of toDelete) {
                    await this.documents.delete(id);
                    const clearedLayers = await this.#synapses.clearSynapses(id, { syncBitmaps: false });
                    await this.#applyMembership('untick', id, clearedLayers);
                    await this.#relations.clearRelations(id);
                    await this.#timelineIndex.removeFromAll(id);
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

        // Best-effort Lance cleanup (outside transaction — separate system).
        // Bulk delete is all-or-nothing, so free-pool admission is batch-wide:
        // recycle the ids only if both fts and vector cleanup succeed; otherwise
        // they leak (stay allocated) rather than risk reuse with stale residue.
        const deletedIds = toDelete.map(({ id }) => id);
        let lanceClean = true;
        try {
            lanceClean = await this.#lanceIndex.deleteMany(deletedIds);
        } catch (e) {
            lanceClean = false;
            debug(`deleteMany: Lance deleteMany failed: ${e.message}`);
        }
        if (this.#vectorSpaces.size > 0) {
            try {
                for (const vi of this.#vectorSpaces.values()) {
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
                this.emit(EVENTS.DOCUMENT_DELETED, createEvent(EVENTS.DOCUMENT_DELETED, { id: ids[0], ...provenance }));
            } else {
                this.emit(EVENTS.DOCUMENT_DELETED_BATCH, createEvent(EVENTS.DOCUMENT_DELETED_BATCH, { ids, ...provenance }));
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
            // putMany / link): a directory-only insert into /.backends should NOT
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
        parsedDocument.validateData();

        // Dedup by checksum
        const primaryChecksum = parsedDocument.getPrimaryChecksum();
        const storedDocument = await this.getByChecksumString(primaryChecksum);

        if (storedDocument) {
            parsedDocument.id = storedDocument.id;
            if (storedDocument.createdAt) { parsedDocument.createdAt = storedDocument.createdAt; }
            if (storedDocument.updatedAt) { parsedDocument.updatedAt = storedDocument.updatedAt; }
        } else {
            parsedDocument.id = this.#allocateDocumentIDs(1)[0];
        }

        parsedDocument.validate();

        // Ensure schema is in features
        if (!featureBitmaps.includes(parsedDocument.schema)) {
            featureBitmaps.push(parsedDocument.schema);
        }

        try {
            await this.#withDeferredMembership(async () => {
                await this.documents.put(parsedDocument.id, parsedDocument);
                await this.#checksumIndex.insertArray(parsedDocument.checksumArray, parsedDocument.id);
                await this.#timelineIndex.insert('crud:created', parsedDocument.id, parsedDocument.createdAt || new Date());
                if (parsedDocument.updatedAt) await this.#timelineIndex.insert('crud:updated', parsedDocument.id, parsedDocument.updatedAt);
                if (storedDocument) await this.#removeDocumentTimelines(parsedDocument.id, storedDocument, parsedDocument);
                await this.#indexDocumentTimelines(parsedDocument.id, parsedDocument);
                await this.#indexDocument(parsedDocument.id, contextSpec, directorySpec, featureBitmaps);
                if (storedDocument) {
                    await this.#removeStaleDeviceMembership(parsedDocument.id, storedDocument.locations, parsedDocument.locations, featureBitmaps);
                }
                await this.#applyMembership(parsedDocument.hasComment ? 'tick' : 'untick', parsedDocument.id, [COMMENT_BITMAP_KEY]);
                const mimeKeys = mimeBitmapKeys(parsedDocument);
                if (mimeKeys.length) { await this.#applyMembership('tick', parsedDocument.id, mimeKeys); }
            });
        } catch (error) {
            throw new Error('Error inserting document atomically: ' + error.message);
        }

        // Best-effort Lance upsert
        try { await this.#lanceIndex.upsert(parseInitializeDocument(parsedDocument)); } catch (_) { }

        if (emitEvent) {
            const { tree: contextTree } = this.#resolveTreeSelection('context', contextSpec, '/');
            contextTree.emit(EVENTS.TREE_DOCUMENT_INSERTED, createEvent(EVENTS.TREE_DOCUMENT_INSERTED, {
                documentId: parsedDocument.id,
                contextSpec,
                directorySpec,
                source: 'tree',
            }));
            this.emit(EVENTS.DOCUMENT_INSERTED, createEvent(EVENTS.DOCUMENT_INSERTED, {
                id: parsedDocument.id,
                document: parsedDocument,
                context: contextSpec,
                directory: directorySpec,
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
        if (!featureBitmaps.includes(storedDocument.schema)) {
            featureBitmaps.push(storedDocument.schema);
        }

        await this.#withDeferredMembership(async () => {
            await this.#indexDocument(numericId, contextSpec, directorySpec, featureBitmaps);
        });

        if (emitEvent) {
            const treeType = contextSpec ? 'context' : (directorySpec ? 'directory' : null);
            const treeSpec = contextSpec ?? directorySpec;
            if (treeType && treeSpec) {
                const { tree } = this.#resolveTreeSelection(treeType, treeSpec, treeType === 'context' ? '/' : null);
                tree.emit(EVENTS.TREE_DOCUMENT_INSERTED, createEvent(EVENTS.TREE_DOCUMENT_INSERTED, {
                    documentId: numericId,
                    contextSpec,
                    directorySpec,
                    source: 'tree',
                }));
            }
            this.emit(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, {
                id: numericId,
                memberships: { context: contextSpec, directory: directorySpec, features: featureBitmaps },
                ...(provenance || {}),
            }));
            // First-class membership event carrying the full document so
            // automation (hooks/rules) can match on content, which the
            // membership-only document.updated above cannot support.
            this.emit(EVENTS.DOCUMENT_LINKED, createEvent(EVENTS.DOCUMENT_LINKED, {
                id: numericId,
                document: storedDocument,
                memberships: { context: contextSpec, directory: directorySpec, features: featureBitmaps },
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

        const selectorBitmap = await this.#buildSelectorBitmap({
            context: spec.context ?? null,
            directory: spec.directory ?? null,
        });
        if (selectorBitmap && selectorBitmap.isEmpty) {
            return false;
        }

        const featureBitmap = await this.#buildFeaturesBitmap(spec.features ?? null);
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
        if (!id) throw new Error('Document ID required');

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

    async listDocumentTreePaths(id, treeNameOrId) {
        if (!id) { throw new Error('Document ID required'); }
        const tree = this.getTree(treeNameOrId);
        if (!tree) {
            throw new Error(`Tree not found: ${treeNameOrId}`);
        }
        if (tree.type !== 'directory') {
            throw new Error(`Tree "${tree.name}" is not a directory tree`);
        }

        const collection = this.#directoryBitmapCollectionForTree(tree.id);
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

        const collection = this.#contextBitmapCollectionForTree(tree.id);
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

    async hasDocumentTreeMembership(id, treeNameOrId) {
        if (!id) { throw new Error('Document ID required'); }
        const tree = this.getTree(treeNameOrId);
        if (!tree) {
            throw new Error(`Tree not found: ${treeNameOrId}`);
        }

        const prefix = BitmapIndex.normalizeKey(tree.type === 'directory'
            ? this.#directoryBitmapCollectionForTree(tree.id).prefix
            : this.#contextBitmapCollectionForTree(tree.id).prefix);
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
        for (const meta of this.#treeMetadata.values()) {
            if (meta.id === excludedTreeId) { continue; }
            const other = this.getTree(meta.id);
            if (!other) { continue; }
            if (meta.type === 'context') {
                if (!other.rootLayer) { continue; }
                const bitmap = await this.#contextBitmapCollectionForTree(meta.id).getBitmap(other.rootLayer.id, false);
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
        return await this.#resolveParsed(parseSpec(rawSpec));
    }

    async #resolveParsed(parsed) {
        const { paths, features, filters } = parsed;
        const keys = [];
        // collectionKeys: the actual bitmap keys (collection vocabulary) consulted,
        // for precise QuerySession invalidation. coarse: this candidate set depends
        // on an operand with no stable key (temporal BSI range) → consumers must
        // re-resolve it on any relevant write rather than key-intersect.
        const collectionKeys = [];
        let coarse = false;
        let bitmap = null;
        let constrained = false;

        const includeBitmap = await this.#buildPathsBitmap(paths.in, keys, collectionKeys);
        if (includeBitmap) {
            bitmap = includeBitmap;
            constrained = true;
        }

        const featureBitmap = await this.#buildFeaturesBitmap(features);
        if (featureBitmap) {
            keys.push(...features.allOf, ...features.anyOf, ...features.noneOf);
            // Feature keys are already collection vocabulary (same normalization as
            // membership feature keys), so they intersect tick keys directly.
            collectionKeys.push(...normalizeBitmapKeys([...features.allOf, ...features.anyOf, ...features.noneOf]));
            if (bitmap) { bitmap.andInPlace(featureBitmap); } else { bitmap = featureBitmap; }
            constrained = true;
        }

        if (filters.length > 0) {
            const { bitmapFilters, timelineFilters } = parseFilters(filters);
            if (bitmapFilters.length > 0) {
                const filterKeys = normalizeBitmapKeys(bitmapFilters);
                keys.push(...filterKeys);
                collectionKeys.push(...filterKeys);
                const filterBitmap = await this.bitmapIndex.AND(filterKeys);
                if (bitmap) { bitmap.andInPlace(filterBitmap); } else { bitmap = filterBitmap; }
                constrained = true;
            }
            if (timelineFilters.length > 0) {
                const timelineBitmap = await this.#combineTimelineFilters(timelineFilters);
                keys.push(...timelineFilters.map((f) => `t:${f.name}`));
                // Temporal filters live in BSI tiers, not stable membership keys —
                // a write does not tick a key we can intersect. Mark coarse.
                coarse = true;
                if (bitmap) { bitmap.andInPlace(timelineBitmap); } else { bitmap = timelineBitmap; }
                constrained = true;
            }
        }

        if (paths.not.length > 0) {
            const excludeBitmap = await this.#buildPathsBitmap(paths.not, keys, collectionKeys);
            if (excludeBitmap && !excludeBitmap.isEmpty) {
                const base = bitmap || await this.#buildAllDocumentsBitmap();
                base.andNotInPlace(excludeBitmap);
                bitmap = base;
                constrained = true;
            }
        }

        return {
            bitmap: constrained ? (bitmap || new RoaringBitmap32()) : null,
            keys,
            collectionKeys: Array.from(new Set(collectionKeys)),
            coarse,
        };
    }

    // Union bitmap for a set of {type, path} entries; null when there are none.
    // collectionKeys (optional) collects the real bitmap keys consulted per entry
    // (context/<treeId>/<layerId>, vfs/<treeId>/<nodeId>) for precise invalidation.
    async #buildPathsBitmap(entries = [], keys = [], collectionKeys = null) {
        if (!Array.isArray(entries) || entries.length === 0) { return null; }
        let result = null;
        for (const { type, path, tree, recursive } of entries) {
            keys.push(`${type}:${path}`);
            const selector = { path, ...(tree ? { tree } : {}), ...(recursive ? { recursive: true } : {}) };
            const bm = type === 'directory'
                ? await this.#buildDirectorySelectorBitmap(selector, collectionKeys)
                : await this.#buildContextSelectorBitmap(selector, collectionKeys);
            if (!bm) { continue; }
            if (result) { result.orInPlace(bm); } else { result = bm; }
        }
        return result;
    }

    // Sigil algebra over timeline filters: AND(allOf) ∩ OR(anyOf) \ OR(noneOf).
    // Returns a bitmap (never null) when given a non-empty filter set.
    async #combineTimelineFilters(timelineFilters) {
        const bySigil = { allOf: [], anyOf: [], noneOf: [] };
        for (const filter of timelineFilters) { bySigil[filter.sigil].push(filter); }

        const orOf = async (list) => {
            const result = new RoaringBitmap32();
            for (const filter of list) { result.orInPlace(await applyTimelineFilter(filter, this.#timelineIndex)); }
            return result;
        };

        let positive = null;
        if (bySigil.allOf.length > 0) {
            for (const filter of bySigil.allOf) {
                const bm = await applyTimelineFilter(filter, this.#timelineIndex);
                if (positive) { positive.andInPlace(bm); } else { positive = bm; }
            }
        }
        if (bySigil.anyOf.length > 0) {
            const anyBitmap = await orOf(bySigil.anyOf);
            if (positive) { positive.andInPlace(anyBitmap); } else { positive = anyBitmap; }
        }
        if (bySigil.noneOf.length > 0) {
            const base = positive || await this.#buildAllDocumentsBitmap();
            base.andNotInPlace(await orOf(bySigil.noneOf));
            positive = base;
        }

        return positive || new RoaringBitmap32();
    }

    // bitmap===null => unconstrained (all docs / search-all); empty => no survivors.
    async rank(bitmap, match = null, options = {}) {
        const parseDocuments = options.parse !== false;

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
            if (sortTimeline && this.#timelineIndex) {
                const base = bitmap === null ? await this.#buildAllDocumentsBitmap() : bitmap;
                if (base.isEmpty) { return this.#emptyResult(); }
                const keyMap = await this.#timelineIndex.getSortKeys(sortTimeline, base);
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
                const docs = await this.documents.getMany(slicedIds);
                const resultArray = parseDocuments ? this.#safeParseDocuments(docs) : docs;
                resultArray.count = resultArray.length;
                resultArray.totalCount = totalCount;
                resultArray.error = null;
                return resultArray;
            }

            if (bitmap === null) {
                const totalCount = await this.documents.getCount();
                const pagedDocs = [];
                let seen = 0;
                for await (const { value } of this.documents.getRange({ reverse: descending })) {
                    if (seen++ < offset) { continue; }
                    pagedDocs.push(value);
                    if (limit > 0 && pagedDocs.length >= limit) { break; }
                }
                const resultArray = parseDocuments ? this.#safeParseDocuments(pagedDocs) : pagedDocs;
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
            const docs = await this.documents.getMany(slicedIds);
            const resultArray = parseDocuments ? this.#safeParseDocuments(docs) : docs;
            resultArray.count = resultArray.length;
            resultArray.totalCount = totalCount;
            resultArray.error = null;
            return resultArray;
        }

        const queryString = typeof match === 'string' ? match : (match.text ?? null);
        if (typeof queryString !== 'string') {
            throw new ArgumentError('Query must be a string', 'query');
        }

        if (bitmap !== null && bitmap.isEmpty) { return this.#emptyResult(); }
        const scopedIds = bitmap ? bitmap.toArray() : [];
        const { pageIds, totalCount, error } = await this.#rankIds(scopedIds, queryString, options);

        const docs = pageIds.length > 0 ? await this.documents.getMany(pageIds) : [];
        const result = this.#safeParseDocuments(docs);
        result.count = result.length;
        result.totalCount = totalCount;
        result.error = error;
        // Calibration aid: when debug is requested, attach the raw (unfloored)
        // image kNN distances for this query so a caller can pick imageMaxDistance
        // from real numbers. Best-effort; never fails the search.
        if (options.debug) {
            try { result.debug = { imageDistances: await this.#imageDistances(queryString, scopedIds, 25) }; }
            catch (e) { result.debug = { imageDistances: [], error: e.message }; }
        }
        return result;
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
    async #rankIds(scopedIds, queryString, options = {}) {
        // fts (BM25) | vector (kNN) | hybrid (RRF); vector/hybrid degrade to fts
        // when the dense stack is unavailable.
        let mode = (options.mode || 'hybrid').toLowerCase();
        if ((mode === 'vector' || mode === 'hybrid') && (!this.#vectorIndex || !this.#vectorIndex.isReady)) {
            debug(`rank: mode '${mode}' requested but vector index not ready; falling back to fts`);
            mode = 'fts';
        }
        if (mode === 'fts' && (!this.#lanceIndex || !this.#lanceIndex.isReady)) {
            return { pageIds: [], totalCount: 0, error: 'FTS not initialized' };
        }

        const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : 50;
        const offset = Math.max(0, Number.isFinite(options.offset) ? Number(options.offset) : 0);

        let pageIds, totalCount, error;
        if (mode === 'vector' || mode === 'hybrid') {
            const depth = Math.max((limit + offset) * 5, 100);
            let queryVector = null;
            try {
                // Query embedding is injected (embedd service); absent → FTS fallback.
                const embedQuery = this.#semanticConfig.embedQuery;
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
            if (!queryVector && imgIds.length === 0) {
                ({ pageIds, totalCount, error } = await this.#lanceIndex.ftsQuery(queryString, scopedIds, { limit, offset }));
            } else if (mode === 'hybrid') {
                // Fuse DOCUMENT-level FTS (every doc — tabs included) with dense
                // kNN (embedded docs only) and image kNN via RRF. The VectorIndex's
                // own hybridSearch only fuses chunk-text BM25 over the vector table,
                // so it can't see un-embedded docs (e.g. tabs); doc-level FTS can.
                const [vec, fts] = await Promise.all([
                    queryVector
                        ? this.#vectorIndex.vectorSearch(queryVector, scopedIds, { limit: depth, offset: 0, minDistance: options.minDistance, maxDistance: options.maxDistance })
                        : Promise.resolve({ pageIds: [], error: null }),
                    this.#lanceIndex.ftsQuery(queryString, scopedIds, { limit: depth, offset: 0 }),
                ]);
                // Weights: see semanticConfig.searchWeights — fts outranks the
                // floor-less text kNN, while floored image kNN fuses at parity
                // with lexical (a photo that clears imageMaxDistance is as real
                // a match as a filename hit).
                const w = this.#semanticConfig.searchWeights;
                const operands = [
                    { ids: fts.pageIds || [], weight: w.fts },
                    { ids: vec.pageIds || [], weight: w.dense },
                ];
                if (imgIds.length) { operands.push({ ids: imgIds, weight: w.image }); }
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
                    ? await this.#vectorIndex.vectorSearch(queryVector, scopedIds, { limit: depth, offset: 0, minDistance: options.minDistance, maxDistance: options.maxDistance })
                    : { pageIds: [], error: null };
                if (imgIds.length) {
                    const wv = this.#semanticConfig.searchWeights;
                    const fused = this.#rrfMerge([
                        { ids: vec.pageIds || [], weight: wv.dense },
                        { ids: imgIds, weight: wv.image },
                    ]);
                    totalCount = fused.length;
                    pageIds = fused.slice(offset, offset + limit);
                    error = vec.error || null;
                } else {
                    totalCount = (vec.pageIds || []).length;
                    pageIds = (vec.pageIds || []).slice(offset, offset + limit);
                    error = vec.error || null;
                }
            }
        } else {
            ({ pageIds, totalCount, error } = await this.#lanceIndex.ftsQuery(queryString, scopedIds, { limit, offset }));
        }

        return { pageIds: pageIds || [], totalCount: totalCount ?? 0, error: error ?? null };
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

    async query(match = null, spec = {}) {
        const parsed = parseSpec(spec);
        const { bitmap } = await this.#resolveParsed(parsed);
        return await this.rank(bitmap, match, parsed.options);
    }

    async list(spec = {}) {
        const parsed = parseSpec(spec);
        try {
            const { bitmap } = await this.#resolveParsed(parsed);
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
        const queryString = spec.query ?? spec.search ?? spec.q ?? null;
        if (typeof queryString !== 'string') {
            throw new ArgumentError('Query must be a string', 'query');
        }
        return await this.query(queryString, spec);
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
        const base = baseSpec ? (await this.#resolveParsed(parseSpec(baseSpec))).bitmap : null;

        // No text → plain structured listing (slice path, no Lance needed).
        if (texts.length === 0) {
            return await this.rank(base, null, options);
        }
        // Single text → one scoped ranked search (existing behavior).
        if (texts.length === 1) {
            return await this.rank(base, texts[0], options);
        }

        if (!this.#lanceIndex || !this.#lanceIndex.isReady) {
            const empty = this.#emptyResult();
            empty.error = 'FTS not initialized';
            return empty;
        }

        // Fold all but the last query into a scope bitmap. Intermediate steps need
        // the FULL matching id set (not a page), so request a large internal limit;
        // scoped fts fetches every candidate, so the AND is exact for query 2+.
        const scope = await this.#foldQueryScope(texts.slice(0, -1), base);
        if (scope && scope.isEmpty) { return this.#emptyResult(); }

        // Final query ranks + paginates within the folded scope. The scope came
        // from a text stage, so the image leg switches to the scope-adaptive
        // cutoff — the absolute floor already did its job in stage one.
        return await this.rank(scope, texts[texts.length - 1], { ...options, imageRelativeFloor: true });
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
    async #foldQueryScope(texts, base) {
        const FOLD_LIMIT = 1_000_000;
        let scope = base; // RoaringBitmap32 | null (null = all docs)
        for (let i = 0; i < texts.length; i++) {
            if (scope && scope.isEmpty) { return scope; }
            const scopeIds = scope ? scope.toArray() : [];
            const matchedIds = await this.#queryMatchSet(texts[i], scopeIds, FOLD_LIMIT, { relativeImageFloor: i > 0 });
            const matched = new RoaringBitmap32(matchedIds);
            scope = scope ? RoaringBitmap32.and(scope, matched) : matched;
        }
        return scope;
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
            const base = hasSpec ? (await this.#resolveParsed(parseSpec(spec))).bitmap : null;

            if (texts.length === 0) {
                // Filters-only line: membership is the structured scope itself.
                const bitmap = base ?? await this.#buildAllDocumentsBitmap();
                return { bitmap, rankedIds: [], error: null };
            }
            const scope = await this.#foldQueryScope(texts.slice(0, -1), base);
            if (scope && scope.isEmpty) { return { bitmap: scope, rankedIds: [], error: null }; }

            const last = texts[texts.length - 1];
            const scopeIds = scope ? scope.toArray() : [];
            const relative = texts.length > 1;
            // Membership (full match set of the last stage) and ranking (its head)
            // in parallel — same stage, two views.
            const [memberIds, ranked] = await Promise.all([
                this.#queryMatchSet(last, scopeIds, 1_000_000, { relativeImageFloor: relative }),
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

        const docs = pageIds.length > 0 ? await this.documents.getMany(pageIds) : [];
        const result = this.#safeParseDocuments(docs);
        result.count = result.length;
        result.totalCount = orderedIds.length;
        result.error = evaluated.every((l) => l.error) ? evaluated.map((l) => l.error).join('; ') : null;
        result.lines = lineCounts;
        return result;
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
        const previousTimelineState = {
            timelines: Array.isArray(storedDocument.timelines)
                ? storedDocument.timelines.map(entry => ({ ...entry }))
                : [],
        };

        // If no update data provided, we're only updating memberships
        if (updateData === null) {
            updateData = storedDocument;
        } else if (typeof updateData === 'object' && !isDocumentInstance(updateData)) {
            if (updateData.schema) {
                updateData = parseInitializeDocument(updateData);
            }
        }

        // Capture locations before update() mutates storedDocument in place, so we can
        // untick device tags for any copy this write dropped.
        const previousLocations = Array.isArray(storedDocument.locations) ? [...storedDocument.locations] : [];
        // MIME presence keys before update(), so a contentType change unticks stale ones.
        const previousMimeKeys = mimeBitmapKeys(storedDocument);

        const updatedDocument = storedDocument.update(updateData);
        updatedDocument.validate();

        // Ensure schema is in features
        if (!featureBitmaps.includes(updatedDocument.schema)) {
            featureBitmaps.push(updatedDocument.schema);
        }

        try {
            await this.#withDeferredMembership(async () => {
                await this.documents.put(updatedDocument.id, updatedDocument);
                await this.#checksumIndex.deleteArray(storedDocument.checksumArray);
                await this.#checksumIndex.insertArray(updatedDocument.checksumArray, updatedDocument.id);
                if (updatedDocument.updatedAt) await this.#timelineIndex.insert('crud:updated', updatedDocument.id, updatedDocument.updatedAt);
                await this.#removeDocumentTimelines(updatedDocument.id, previousTimelineState, updatedDocument);
                await this.#indexDocumentTimelines(updatedDocument.id, updatedDocument);

                // Index across all views using shared helper
                await this.#indexDocument(updatedDocument.id, contextSpec, directorySpec, featureBitmaps);
                await this.#removeStaleDeviceMembership(updatedDocument.id, previousLocations, updatedDocument.locations, featureBitmaps);
                // Presence bitmap tracks comment state; untick when cleared on this edit.
                await this.#applyMembership(updatedDocument.hasComment ? 'tick' : 'untick', updatedDocument.id, [COMMENT_BITMAP_KEY]);
                // MIME presence bitmaps: tick current type keys, untick any the
                // contentType change left behind (derived from doc state, can't drift).
                const newMimeKeys = mimeBitmapKeys(updatedDocument);
                const staleMimeKeys = previousMimeKeys.filter(k => !newMimeKeys.includes(k));
                if (staleMimeKeys.length) { await this.#applyMembership('untick', updatedDocument.id, staleMimeKeys); }
                if (newMimeKeys.length) { await this.#applyMembership('tick', updatedDocument.id, newMimeKeys); }
            });

            if (emitEvent) {
                this.emit(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, { id: updatedDocument.id, document: updatedDocument, ...(provenance || {}) }));
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
            for (const space of this.#vectorSpaces.keys()) {
                try { await this.bitmapIndex.untick(this.#seenKey(space), Number(updatedDocument.id)); } catch (_) { }
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
            const { tree: contextTree, collection: contextCollection, path: normalizedContextSpec } = this.#resolveTreeSelection('context', contextSpec, '/');
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
                removedContextPaths.push(...targetLayers);
            }
        }

        if (directorySpec) {
            const { tree: directoryTree, collection: directoryCollection, path: normalizedDirectoryPath } = this.#resolveTreeSelection('directory', directorySpec, '/');
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
                await this.#withDeferredMembership(async () => {
                    await this.#removeDocumentMembership(docId, Array.from(new Set(layersToRemove)));
                });
                debug(`unlink: Removed doc ${docId} from ${layersToRemove.length} layers via Synapses`);
            }

            this.emit(EVENTS.DOCUMENT_REMOVED, createEvent(EVENTS.DOCUMENT_REMOVED, {
                id: docId,
                contextArray: removedContextPaths,
                directoryArray: removedDirectoryPaths,
                featureArray: featureKeys,
                recursive: options.recursive,
                ...(provenance || {}),
            }));
            // First-class membership event carrying the full document (still in
            // the store — unlink only drops memberships) so automation can match
            // on content. Omitted if the document is gone.
            try {
                const unlinkedData = await this.documents.get(docId);
                if (unlinkedData) {
                    this.emit(EVENTS.DOCUMENT_UNLINKED, createEvent(EVENTS.DOCUMENT_UNLINKED, {
                        id: docId,
                        document: parseDocumentData(unlinkedData),
                        contextArray: removedContextPaths,
                        directoryArray: removedDirectoryPaths,
                        featureArray: featureKeys,
                        recursive: options.recursive,
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
            await this.#withDeferredMembership(async () => {
                // Delete document from main database
                await this.documents.delete(docId);
                debug(`delete: Document ${docId} deleted from main store`);

                // Delete document from all bitmaps AND Reverse Index via Synapses
                // await this.bitmapIndex.untickAll(docId);
                const clearedLayers = await this.#synapses.clearSynapses(docId, { syncBitmaps: false });
                await this.#applyMembership('untick', docId, clearedLayers);
                await this.#relations.clearRelations(docId);
                debug(`delete: Document ${docId} removed from all bitmaps and Synapses index`);

                // Remove document from all custom and CRUD timelines before recording deletion.
                await this.#timelineIndex.removeFromAll(docId);
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
            if (this.#vectorSpaces.size > 0) {
                try {
                    for (const vi of this.#vectorSpaces.values()) {
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
                this.emit(EVENTS.DOCUMENT_DELETED, createEvent(EVENTS.DOCUMENT_DELETED, { id: docId, ...(provenance || {}) }));
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
     * @returns {BaseDocument|null} Document instance or null if not found
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
     * @returns {Array<BaseDocument>} Array of document instances
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
     * @returns {BaseDocument|null} Document instance or null if not found
     */
    async getByChecksumString(checksumString, options = { parse: true }) {
        if (!checksumString) { throw new Error('Checksum string required'); }
        debug(`getByChecksumString: Searching for document with checksum ${checksumString}`);

        // Get document ID from checksum index
        const id = await this.#checksumIndex.checksumStringToId(checksumString);
        if (!id) { return null; }

        // Return the document instance, passing the contextSpec through
        return await this.#getById(id, options);
    }

    async hasByChecksumString(checksumString, treeSelector = null, features = []) {
        if (!checksumString) { throw new Error('Checksum string required'); }
        const id = await this.#checksumIndex.checksumStringToId(checksumString);
        if (!id) { return false; }
        return await this.has(id, treeSelector, features);
    }

    /**
     * Get multiple documents by checksum string and return properly instantiated document objects
     * @param {Array<string>} checksumStringArray - Array of checksum strings
     * @returns {Array<BaseDocument>} Array of document instances
     */
    async getDocumentsByChecksumStringArray(checksumStringArray, contextSpec = '/', options = { parse: true }) {
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

    async setDocumentArrayFeatures(docIdArray, featureBitmapArray) {
        if (!Array.isArray(docIdArray)) {
            throw new Error('Document ID array must be an array');
        }
        if (!Array.isArray(featureBitmapArray) || featureBitmapArray.length === 0) {
            throw new Error('Feature bitmap array must be a non-empty array');
        }
        // Ensure all features are strings
        if (!featureBitmapArray.every(f => typeof f === 'string')) {
            throw new Error('All items in feature bitmap array must be strings');
        }
        debug(`setDocumentArrayFeatures: Setting features [${featureBitmapArray.join(', ')}] for ${docIdArray.length} documents`);

        const result = {
            successful: [], // Array of { index: number, id: number }
            failed: [],    // Array of { index: number, id: number, error: string }
            count: docIdArray.length,
        };

        // Validate IDs upfront, separate valid from invalid
        const validEntries = [];
        for (let i = 0; i < docIdArray.length; i++) {
            const id = docIdArray[i];
            if (typeof id !== 'number') {
                result.failed.push({ index: i, id, error: 'Invalid document ID: Must be a number.' });
            } else {
                validEntries.push({ index: i, id });
            }
        }

        // Single tickMany call with all valid IDs
        if (validEntries.length > 0) {
            try {
                const featureKeys = normalizeBitmapKeys(featureBitmapArray);
                await this.#withDeferredMembership(async () => {
                    for (const { id } of validEntries) {
                        await this.#addDocumentMembership(id, featureKeys);
                    }
                });
                for (const { index, id } of validEntries) {
                    result.successful.push({ index, id });
                }
                debug(`setDocumentArrayFeatures: Successfully set features for ${validEntries.length} documents.`);
            } catch (error) {
                debug(`setDocumentArrayFeatures: Batch tick failed. Error: ${error.message}`);
                for (const { index, id } of validEntries) {
                    result.failed.push({ index, id, error: error.message || 'Unknown error' });
                }
            }
        }

        debug(`setDocumentArrayFeatures: Processed ${result.count} requests. Successful: ${result.successful.length}, Failed: ${result.failed.length}`);
        return result;
    }

    async unsetDocumentArrayFeatures(docIdArray, featureBitmapArray) {
        if (!Array.isArray(docIdArray)) {
            throw new Error('Document ID array must be an array');
        }
        if (!Array.isArray(featureBitmapArray) || featureBitmapArray.length === 0) {
            throw new Error('Feature bitmap array must be a non-empty array');
        }
        // Ensure all features are strings
        if (!featureBitmapArray.every(f => typeof f === 'string')) {
            throw new Error('All items in feature bitmap array must be strings');
        }
        debug(`unsetDocumentArrayFeatures: Unsetting features [${featureBitmapArray.join(', ')}] for ${docIdArray.length} documents`);

        const result = {
            successful: [], // Array of { index: number, id: number }
            failed: [],    // Array of { index: number, id: number, error: string }
            count: docIdArray.length,
        };

        // Validate IDs upfront, separate valid from invalid
        const validEntries = [];
        for (let i = 0; i < docIdArray.length; i++) {
            const id = docIdArray[i];
            if (typeof id !== 'number') {
                result.failed.push({ index: i, id, error: 'Invalid document ID: Must be a number.' });
            } else {
                validEntries.push({ index: i, id });
            }
        }

        // Single untickMany call with all valid IDs
        if (validEntries.length > 0) {
            try {
                const featureKeys = normalizeBitmapKeys(featureBitmapArray);
                await this.#withDeferredMembership(async () => {
                    for (const { id } of validEntries) {
                        await this.#removeDocumentMembership(id, featureKeys);
                    }
                });
                for (const { index, id } of validEntries) {
                    result.successful.push({ index, id });
                }
                debug(`unsetDocumentArrayFeatures: Successfully unset features for ${validEntries.length} documents.`);
            } catch (error) {
                debug(`unsetDocumentArrayFeatures: Batch untick failed. Error: ${error.message}`);
                for (const { index, id } of validEntries) {
                    result.failed.push({ index, id, error: error.message || 'Unknown error' });
                }
            }
        }

        debug(`unsetDocumentArrayFeatures: Processed ${result.count} requests. Successful: ${result.successful.length}, Failed: ${result.failed.length}`);
        return result;
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

    /**
     * Internal methods
     */

    async #loadTreeRegistry() {
        this.#treeMetadata.clear();
        this.#defaultTreeIds = { context: null, directory: null };

        const treeIds = new Set();
        for await (const key of this.#internalStore.getKeys({
            start: 'tree/',
            end: 'tree/\uffff',
        })) {
            const match = String(key).match(/^tree\/([^/]+)\/meta$/);
            if (match) {
                treeIds.add(match[1]);
            }
        }

        for (const treeId of treeIds) {
            const meta = this.#internalStore.get(this.#treeMetaKey(treeId));
            if (!meta) { continue; }
            this.#treeMetadata.set(meta.id, meta);
            if (meta.isDefault && !this.#defaultTreeIds[meta.type]) {
                this.#defaultTreeIds[meta.type] = meta.id;
            }
        }
    }

    async #ensureDefaultTrees() {
        if ((await this.listTrees('context')).length === 0) {
            await this.createTree('default', 'context', { isDefault: true });
        }
        if ((await this.listTrees('directory')).length === 0) {
            await this.createTree('directory', 'directory', { isDefault: true });
        }

        if (!this.#defaultTreeIds.context) {
            this.#defaultTreeIds.context = (await this.listTrees('context'))[0]?.id || null;
        }
        if (!this.#defaultTreeIds.directory) {
            this.#defaultTreeIds.directory = (await this.listTrees('directory'))[0]?.id || null;
        }

        if (this.#defaultTreeIds.context) {
            this.contextBitmapCollection = this.#contextBitmapCollectionForTree(this.#defaultTreeIds.context);
        }

        for (const meta of this.#treeMetadata.values()) {
            await this.#instantiateTree(meta).initialize();
        }
    }

    #resolveTreeMeta(nameOrId, type = null) {
        const tree = this.getTree(nameOrId);
        if (!tree) {
            return null;
        }
        const meta = this.#treeMetadata.get(tree.id) || null;
        if (type && meta?.type !== type) {
            return null;
        }
        return meta;
    }

    #getDefaultTreeByType(type) {
        const treeId = this.#defaultTreeIds[type] || null;
        return treeId ? this.getTree(treeId) : null;
    }

    #instantiateTree(meta) {
        if (!meta) { return null; }
        if (this.#treeCache.has(meta.id)) {
            return this.#treeCache.get(meta.id);
        }

        const dataStore = new PrefixedStore(this.#internalStore, `tree/${meta.id}`);
        const tree = meta.type === 'directory'
            ? new DirectoryTree({
                dataStore,
                db: this,
                bitmapIndex: this.bitmapIndex,
                treeId: meta.id,
                treeName: meta.name,
                settings: meta.settings,
                bitmapCollection: this.#directoryBitmapCollectionForTree(meta.id),
            })
            : new ContextTree({
                dataStore,
                db: this,
                treeId: meta.id,
                treeName: meta.name,
                settings: meta.settings,
                bitmapCollection: this.#contextBitmapCollectionForTree(meta.id),
            });

        this.#registerTreeEvents(tree, meta);
        this.#treeCache.set(meta.id, tree);
        return tree;
    }

    #registerTreeEvents(tree, meta) {
        if (tree.__synapsdTreeEventsBound) { return; }
        tree.__synapsdTreeEventsBound = true;
        const db = this;
        tree.on('**', function (payload = {}) {
            const eventName = this.event;
            if (!eventName) { return; }
            const forwarded = payload && typeof payload === 'object' ? { ...payload } : { value: payload };
            if (!forwarded.treeId) { forwarded.treeId = meta.id; }
            if (!forwarded.treeName) { forwarded.treeName = meta.name; }
            if (!forwarded.treeType) { forwarded.treeType = meta.type; }
            if (!forwarded.source) { forwarded.source = 'tree'; }
            db.emit(eventName, forwarded);
        });
    }

    #treeMetaKey(treeId) {
        return `tree/${treeId}/meta`;
    }

    #contextBitmapCollectionForTree(treeId) {
        return this.bitmapIndex.createCollection(`context/${treeId}`);
    }

    #directoryBitmapCollectionForTree(treeId) {
        return this.bitmapIndex.createCollection(`vfs/${treeId}`);
    }

    #normalizeTreeName(name) {
        return String(name ?? '')
            .normalize('NFKC')
            .trim()
            .replace(/\s+/g, ' ')
            .toLowerCase();
    }

    async #deleteTreeStorage(meta) {
        const internalKeys = [];
        for await (const key of this.#internalStore.getKeys({
            start: `tree/${meta.id}/`,
            end: `tree/${meta.id}/\uffff`,
        })) {
            internalKeys.push(key);
        }
        for (const key of internalKeys) {
            await this.#internalStore.remove(key);
        }

        const bitmapPrefix = meta.type === 'directory' ? `vfs/${meta.id}` : `context/${meta.id}`;
        const bitmapKeys = await this.bitmapIndex.listBitmaps(bitmapPrefix);
        for (const key of bitmapKeys) {
            await this.bitmapIndex.deleteBitmap(key);
        }
    }

    #resolveTreeSelection(type, spec, defaultPath = null) {
        if (typeof spec === 'string' || Array.isArray(spec)) {
            throw new Error(`Legacy ${type} path strings are no longer supported. Pass { tree, path } instead.`);
        }
        const pathFallbackKey = type === 'directory' ? 'directory' : 'context';
        const treeSelector = spec && typeof spec === 'object' && !Array.isArray(spec)
            ? (spec.tree ?? spec.treeId ?? spec.nameOrId ?? null)
            : null;
        const path = spec && typeof spec === 'object' && !Array.isArray(spec)
            ? (spec.path ?? spec[pathFallbackKey] ?? defaultPath)
            : (spec ?? defaultPath);
        const tree = treeSelector ? this.getTree(treeSelector) : this.#getDefaultTreeByType(type);
        if (!tree) {
            throw new Error(`No ${type} tree available`);
        }
        if (tree.type !== type) {
            throw new Error(`Tree "${tree.name}" is not a ${type} tree`);
        }
        return {
            tree,
            collection: type === 'context'
                ? this.#contextBitmapCollectionForTree(tree.id)
                : this.#directoryBitmapCollectionForTree(tree.id),
            path,
        };
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
        this.#emitTreeDocumentEvent(eventName, 'context', context, documentIds);
        this.#emitTreeDocumentEvent(eventName, 'directory', directory, documentIds);
    }

    #emitTreeDocumentEvent(eventName, type, spec, documentIds) {
        if (!spec || !Array.isArray(documentIds) || documentIds.length === 0) { return; }
        try {
            const { tree, path } = this.#resolveTreeSelection(type, spec, '/');
            const contextSpec = Array.isArray(path) ? (path[0] ?? '/') : (path ?? '/');
            tree.emit(eventName, createEvent(eventName, { documentIds, contextSpec, source: 'tree' }));
        } catch (error) {
            debug(`#emitTreeDocumentEvent ${eventName} (${type}) failed: ${error.message}`);
        }
    }

    #isDocumentOperationOptions(value) {
        return Boolean(
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            ['context', 'directory', 'features', 'attributes', 'emitEvent', 'provenance'].some((key) => Object.prototype.hasOwnProperty.call(value, key))
        );
    }

    #normalizeWriteFeatures(features) {
        if (features == null) {
            return [];
        }
        if (Array.isArray(features)) {
            return normalizeBitmapKeys(features);
        }
        if (typeof features === 'object') {
            return normalizeBitmapKeys(features.allOf ?? features.features ?? []);
        }
        return normalizeBitmapKeys(features);
    }

    #normalizeQueryFeatures(features) {
        if (!features) {
            return null;
        }

        if (Array.isArray(features)) {
            return {
                allOf: [],
                anyOf: normalizeBitmapKeys(features),
                noneOf: [],
            };
        }

        if (typeof features !== 'object') {
            throw new Error('list(): features must be an array or object');
        }

        return {
            allOf: normalizeBitmapKeys(features.allOf ?? []),
            anyOf: normalizeBitmapKeys(features.anyOf ?? []),
            noneOf: normalizeBitmapKeys(features.noneOf ?? []),
        };
    }

    #resolveGenericTreeSelection(selector = null, defaultPath = '/', fallbackType = 'context') {
        if (selector == null) {
            const tree = this.#getDefaultTreeByType(fallbackType);
            if (!tree) {
                throw new Error(`No ${fallbackType} tree available`);
            }
            return {
                type: tree.type,
                tree,
                path: defaultPath,
                spec: { tree: tree.id, path: defaultPath },
            };
        }

        if (typeof selector === 'string' || Array.isArray(selector)) {
            const tree = this.#getDefaultTreeByType(fallbackType);
            if (!tree) {
                throw new Error(`No ${fallbackType} tree available`);
            }
            return {
                type: tree.type,
                tree,
                path: selector,
                spec: { tree: tree.id, path: selector },
            };
        }

        if (typeof selector !== 'object' || Array.isArray(selector)) {
            throw new Error('Invalid tree selector');
        }

        if (Object.prototype.hasOwnProperty.call(selector, 'context')) {
            const { tree, path } = this.#resolveTreeSelection('context', {
                tree: selector.tree ?? selector.treeId ?? selector.nameOrId ?? null,
                path: selector.path ?? selector.context ?? defaultPath,
            }, defaultPath);
            return {
                type: 'context',
                tree,
                path,
                spec: { tree: tree.id, path },
            };
        }

        if (Object.prototype.hasOwnProperty.call(selector, 'directory')) {
            const { tree, path } = this.#resolveTreeSelection('directory', {
                tree: selector.tree ?? selector.treeId ?? selector.nameOrId ?? null,
                path: selector.path ?? selector.directory ?? defaultPath,
            }, defaultPath);
            return {
                type: 'directory',
                tree,
                path,
                spec: { tree: tree.id, path },
            };
        }

        const treeSelector = selector.tree ?? selector.treeId ?? selector.nameOrId ?? null;
        const tree = treeSelector ? this.getTree(treeSelector) : this.#getDefaultTreeByType(fallbackType);
        if (!tree) {
            throw new Error(`Tree not found: ${treeSelector}`);
        }

        const path = selector.path ?? defaultPath;
        return {
            type: tree.type,
            tree,
            path,
            spec: { tree: tree.id, path },
        };
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
    async #migrateBitmapKeys() {
        let migrated = 0;

        // --- Context bitmaps: name → ULID ---
        for (const meta of await this.listTrees('context')) {
            const tree = this.getTree(meta.id);
            const collection = this.#contextBitmapCollectionForTree(meta.id);
            const layerKeys = await tree.layers;
            for (const layerKey of layerKeys) {
                const layer = tree.getLayerById(layerKey);
                if (!layer || layer.name === '/') continue;

                const oldKey = collection.makeKey(layer.name);
                const newKey = collection.makeKey(layer.id);
                if (oldKey === newKey) continue;

                if (this.bitmapIndex.hasBitmap(oldKey) && !this.bitmapIndex.hasBitmap(newKey)) {
                    await this.bitmapIndex.renameBitmap(oldKey, newKey);
                    migrated++;
                }
            }
        }

        // --- Feature bitmaps: revert feature/ prefix back to raw keys ---
        // Previous code stored features under feature/data/..., feature/client/..., etc.
        // We now store them directly as data/..., client/..., tag/..., etc.
        const featureKeys = await this.bitmapIndex.listBitmaps('feature/');
        for (const oldKey of featureKeys) {
            const naturalKey = oldKey.slice('feature/'.length);
            if (!this.bitmapIndex.hasBitmap(naturalKey)) {
                await this.bitmapIndex.renameBitmap(oldKey, naturalKey);
            } else {
                await this.bitmapIndex.mergeBitmap(oldKey, [naturalKey]);
                await this.bitmapIndex.deleteBitmap(oldKey);
            }
            migrated++;
        }

        if (migrated > 0) {
            debug(`Bitmap key migration: renamed ${migrated} bitmap(s) to new format`);
        }
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

    /**
     * Shared bitmap indexing for both insert and update operations.
     * Handles: context tree bitmaps, directory tree bitmaps, feature bitmaps, synapses.
     */
    async #indexDocument(docId, contextSpec, directorySpec, featureBitmaps) {
        // Union device-presence tags derived from the document's locations so that
        // "what's on device X" is a single bitmap intersection. Conservative: only
        // file://<deviceId>/… locations tick device/id/<deviceId>; non-device URLs
        // (stored://, s3://, http://, imap://) and {WORKSPACE_ROOT}-style placeholders
        // are skipped — their authority is a backend/bucket/host, not a device.
        // Additive (matches existing feature-bitmap semantics); the document is
        // already persisted before this runs in every write path, so we read it back
        // for the canonical location set.
        const features = Array.isArray(featureBitmaps) ? [...featureBitmaps] : [];
        try {
            const stored = await this.documents.get(docId);
            for (const tag of this.#deviceFeaturesFromLocations(stored?.locations)) {
                if (!features.includes(tag)) { features.push(tag); }
            }
        } catch (_) { /* best-effort: presence tags must never block indexing */ }

        const allSynapseKeys = await this.#resolveDocumentMembershipKeys(contextSpec, directorySpec, features);
        await this.#addDocumentMembership(docId, allSynapseKeys);
    }

    /**
     * Derive device-presence feature tags from a document's locations.
     * Returns ['device/id/<deviceId>', …] for each distinct device-local copy.
     * @param {Array<{url:string}>} locations
     * @returns {string[]}
     */
    #deviceFeaturesFromLocations(locations) {
        const tags = new Set();
        for (const loc of Array.isArray(locations) ? locations : []) {
            const parsed = parseLocationUrl(loc?.url);
            if (!parsed || parsed.scheme !== 'file') { continue; }
            const authority = parsed.backend;
            // Skip {WORKSPACE_ROOT}/{VAR} placeholders — workspace-relative, not a device.
            if (!authority || /^\{.*\}$/.test(authority)) { continue; }
            // Normalize to the bitmap-key form the index actually stores (lowercased,
            // sanitized) so derivation, add, and untick all compare apples-to-apples.
            tags.add(normalizeBitmapKey(`device/id/${authority}`));
        }
        return [...tags];
    }

    /**
     * Untick device-presence tags a write dropped from the document's locations.
     * Powers dedup/cleanup: when a copy disappears from locations (an agent prunes a
     * stale path, a device loses the file), its device/id/<id> bitmap is removed so
     * "what's on device X" stays accurate. A tag the caller explicitly re-asserts in
     * this write (assertedFeatures, e.g. the writing-client tag) is never unticked.
     * @param {number} docId
     * @param {Array<{url:string}>} previousLocations  locations before the write
     * @param {Array<{url:string}>} currentLocations   locations after the write
     * @param {string[]} assertedFeatures              tags explicitly set this write
     */
    async #removeStaleDeviceMembership(docId, previousLocations, currentLocations, assertedFeatures = []) {
        const previous = this.#deviceFeaturesFromLocations(previousLocations);
        if (previous.length === 0) { return; }
        const current = new Set(this.#deviceFeaturesFromLocations(currentLocations));
        const asserted = new Set((Array.isArray(assertedFeatures) ? assertedFeatures : []).map(normalizeBitmapKey));
        const stale = previous.filter((tag) => !current.has(tag) && !asserted.has(tag));
        if (stale.length > 0) { await this.#removeDocumentMembership(docId, stale); }
    }

    async #indexDocumentTimelines(docId, document) {
        const entries = this.#normalizeDocumentTimelineEntries(document);
        for (const entry of entries) {
            await this.#timelineIndex.insert(entry.name, docId, entry.interval);
        }
    }

    async #removeDocumentTimelines(docId, ...documents) {
        const names = new Set();
        for (const document of documents) {
            for (const entry of this.#normalizeDocumentTimelineEntries(document)) {
                names.add(entry.name);
            }
        }

        for (const name of names) {
            await this.#timelineIndex.remove(name, docId);
        }
    }

    #normalizeDocumentTimelineEntries(document) {
        const timelines = Array.isArray(document?.timelines) ? document.timelines : [];
        return timelines.map((entry) => {
            const name = entry.name ?? entry.timeline;
            if (!name) { throw new Error('Document timeline entry requires name or timeline'); }
            if (!('start' in entry)) { throw new Error(`Document timeline entry "${name}" requires start`); }

            const start = entry.scale ? { scale: entry.scale, value: entry.start } : entry.start;
            const rawEnd = entry.end ?? entry.start;
            const end = entry.scale ? { scale: entry.scale, value: rawEnd } : rawEnd;

            return { name, interval: { start, end } };
        });
    }

    async #resolveDocumentMembershipKeys(contextSpec, directorySpec, featureBitmaps) {
        const allSynapseKeys = [];

        if (contextSpec) {
            const { tree: contextTree, collection, path: contextPath } = this.#resolveTreeSelection('context', contextSpec, '/');
            const pathLayersArray = parseContextSpecForInsert(contextPath);
            for (const pathLayers of pathLayersArray) {
                const pathString = pathLayers.join('/');
                await contextTree.insertPath(pathString);

                const layerIds = contextTree.resolveLayerIds(pathLayers);
                // Always tick root layer for universal membership bitmap (O(1) path='/' queries)
                if (contextTree.rootLayer && !layerIds.includes(contextTree.rootLayer.id)) {
                    layerIds.unshift(contextTree.rootLayer.id);
                }
                allSynapseKeys.push(...layerIds.map((layerId) => collection.makeKey(layerId)));
            }
        }

        if (directorySpec) {
            const { tree: directoryTree, path: directoryPath } = this.#resolveTreeSelection('directory', directorySpec, null);
            const dirs = Array.isArray(directoryPath) ? directoryPath : [directoryPath];
            const nodeIds = typeof directoryTree.ensurePaths === 'function'
                ? await directoryTree.ensurePaths(dirs)
                : [];
            const collection = this.#directoryBitmapCollectionForTree(directoryTree.id);
            allSynapseKeys.push(...nodeIds.map((nodeId) => collection.makeKey(nodeId)));

            // Directory-only inserts surface at the default context root unless
            // the tree opts out (settings.linkContextRoot === false) — e.g. a
            // backend-mirror tree whose documents should stay out of the user's
            // context until explicitly filed.
            if (!contextSpec && directoryTree.settings?.linkContextRoot !== false) {
                const contextTree = this.getDefaultContextTree();
                if (contextTree?.rootLayer) {
                    const collection = this.#contextBitmapCollectionForTree(contextTree.id);
                    allSynapseKeys.push(collection.makeKey(contextTree.rootLayer.id));
                }
            }
        }

        allSynapseKeys.push(...normalizeBitmapKeys(featureBitmaps ?? []));
        return Array.from(new Set(allSynapseKeys));
    }

    /**
     * Run an LMDB transaction with rollback-safe bitmap membership.
     *
     * Bitmap ticks/unticks issued inside `txBody` (via #add/#removeDocumentMembership
     * and clearSynapses) are buffered, not applied, while the transaction runs. They
     * are flushed to the bitmap index only after the transaction commits — so a
     * rollback leaves no phantom ticks in the shared bitmap cache. The synapse
     * reverse index is still written transactionally inside `txBody`.
     *
     * Reentrancy: a nested call shares the outermost buffer; only the outermost
     * flush runs (matching how raw #db.transaction nesting would behave today).
     */
    async #withDeferredMembership(txBody) {
        if (this.#membershipBuffer) {
            return this.#db.transaction(txBody);
        }
        const buffer = [];
        this.#membershipBuffer = buffer;
        try {
            await this.#db.transaction(txBody);
        } finally {
            this.#membershipBuffer = null;
        }
        // Only reached when the transaction committed (a throw propagates above and
        // skips this), so the buffer is discarded on rollback.
        await this.#flushMembershipBuffer(buffer);
    }

    async #flushMembershipBuffer(buffer) {
        const changes = [];
        for (const { op, docId, keys } of buffer) {
            try {
                const affected = op === 'tick'
                    ? await this.bitmapIndex.tickMany(keys, docId)
                    : await this.bitmapIndex.untickMany(keys, docId);
                if (affected && affected.length) { changes.push({ docId, op, keys: affected }); }
            } catch (error) {
                // Committed doc may now lack/keep a bitmap membership it should
                // not — recoverable by reindexing from the synapse reverse index.
                debug(`Post-commit bitmap ${op} failed for doc ${docId}: ${error.message}`);
            }
        }
        this.#emitMembershipChanged(changes);
    }

    /** Buffer a bitmap membership op if a deferred-membership tx is active, else apply now. */
    async #applyMembership(op, docId, keys) {
        if (this.#membershipBuffer) {
            this.#membershipBuffer.push({ op, docId, keys });
            return;
        }
        const affected = op === 'tick'
            ? await this.bitmapIndex.tickMany(keys, docId)
            : await this.bitmapIndex.untickMany(keys, docId);
        if (affected && affected.length) {
            this.#emitMembershipChanged([{ docId, op, keys: affected }]);
        }
    }

    // Post-commit signal of the exact collection bitmap keys that changed, so a
    // QuerySession can precisely invalidate only the operands that touched them.
    // Keys are collection-vocabulary (context/<treeId>/<layerId>, vfs/<treeId>/<nodeId>,
    // feature keys) — the same vocabulary resolveCandidates() reports as collectionKeys.
    #emitMembershipChanged(changes) {
        if (!changes || changes.length === 0) { return; }
        this.emit(EVENTS.MEMBERSHIP_CHANGED, createEvent(EVENTS.MEMBERSHIP_CHANGED, { changes }));
    }

    async #addDocumentMembership(docId, bitmapKeys) {
        const keys = normalizeBitmapKeys(bitmapKeys);
        if (keys.length === 0) {
            return false;
        }
        // Synapse reverse index stays in-tx (durable truth); bitmap tick is deferred.
        await this.#synapses.createSynapses(docId, keys, { syncBitmaps: false });
        await this.#applyMembership('tick', docId, keys);
        return true;
    }

    async #removeDocumentMembership(docId, bitmapKeys) {
        const keys = normalizeBitmapKeys(bitmapKeys);
        if (keys.length === 0) {
            return false;
        }
        await this.#synapses.removeSynapses(docId, keys, { syncBitmaps: false });
        await this.#applyMembership('untick', docId, keys);
        return true;
    }

    async #buildSelectorBitmap(selector = null) {
        if (!selector) {
            return null;
        }

        if (selector.context || selector.directory) {
            const contextBitmap = selector.context ? await this.#buildContextSelectorBitmap(selector.context) : null;
            const directoryBitmap = selector.directory ? await this.#buildDirectorySelectorBitmap(selector.directory) : null;

            if (contextBitmap && directoryBitmap) {
                contextBitmap.andInPlace(directoryBitmap);
                return contextBitmap;
            }
            return contextBitmap ?? directoryBitmap ?? null;
        }

        if (selector.type === 'context') {
            return await this.#buildContextSelectorBitmap(selector.spec);
        }
        if (selector.type === 'directory') {
            return await this.#buildDirectorySelectorBitmap(selector.spec);
        }

        const selection = this.#resolveGenericTreeSelection(selector, '/', 'context');
        return selection.type === 'directory'
            ? await this.#buildDirectorySelectorBitmap(selection.spec)
            : await this.#buildContextSelectorBitmap(selection.spec);
    }

    async #buildContextSelectorBitmap(contextSpec, collectionKeys = null) {
        if (!contextSpec) {
            return null;
        }

        const { tree, collection, path } = this.#resolveTreeSelection('context', contextSpec, '/');
        const pathLayersArray = parseContextSpecForInsert(path);
        const recordKey = (id) => { if (collectionKeys && id != null) { collectionKeys.push(collection.makeKey(id)); } };
        let resultBitmap = null;
        let sawExplicitPath = false;
        let sawExistingPath = false;

        for (const pathLayers of pathLayersArray) {
            if (pathLayers.length === 1 && pathLayers[0] === '/') {
                sawExplicitPath = true;
                if (tree.rootLayer) { recordKey(tree.rootLayer.id); }
                const rootBitmap = await this.#getContextRootBitmap(tree, collection);
                if (rootBitmap && !rootBitmap.isEmpty) {
                    if (resultBitmap) {
                        resultBitmap.orInPlace(rootBitmap);
                    } else {
                        resultBitmap = rootBitmap;
                    }
                    sawExistingPath = true;
                }
                continue;
            }

            sawExplicitPath = true;
            const pathString = pathLayers.join('/');
            if (!tree.getLayerForPath(pathString)) {
                continue;
            }

            sawExistingPath = true;
            const layerIds = tree.resolveLayerIds(pathLayers);
            // After resolveLayerIds drops canvas leaves and root, an empty result
            // means the path effectively reduces to root (e.g. /<canvas-leaf>).
            // Fall back to the root layer bitmap so canvases anchored directly
            // under '/' return all docs at the root, not zero.
            let pathBitmap;
            if (layerIds.length === 0) {
                if (tree.rootLayer) { recordKey(tree.rootLayer.id); }
                pathBitmap = await this.#getContextRootBitmap(tree, collection);
            } else {
                for (const id of layerIds) { recordKey(id); }
                pathBitmap = await collection.AND(layerIds);
            }
            if (!pathBitmap || pathBitmap.isEmpty) {
                continue;
            }

            if (resultBitmap) {
                resultBitmap.orInPlace(pathBitmap);
            } else {
                resultBitmap = pathBitmap;
            }
        }

        if (!sawExplicitPath) {
            return null;
        }

        return sawExistingPath ? (resultBitmap || new RoaringBitmap32()) : new RoaringBitmap32();
    }

    async #getContextRootBitmap(tree, collection) {
        if (!tree?.rootLayer) {
            return new RoaringBitmap32();
        }
        return await collection.OR([tree.rootLayer.id]);
    }

    async #buildDirectorySelectorBitmap(directorySpec, collectionKeys = null) {
        if (!directorySpec) {
            return null;
        }

        const { tree, collection, path } = this.#resolveTreeSelection('directory', directorySpec, '/');
        const directoryPaths = Array.isArray(path) ? path.filter(Boolean) : [path].filter(Boolean);
        if (directoryPaths.length === 0) {
            return null;
        }

        // Node-exact by default (folder listings); recursive widens to the whole
        // subtree (searches — docs tick only their leaf node, so a node-exact
        // scope at an ancestor folder would match nothing).
        const recursive = directorySpec?.recursive === true;

        let resultBitmap = null;
        let sawExistingPath = false;
        for (const directoryPath of directoryPaths) {
            if (!tree.pathExists(directoryPath)) {
                continue;
            }

            sawExistingPath = true;
            // find() reads exactly the path's own node bitmap (non-recursive) — the
            // same node a doc inserted at this path ticks. Record the consulted
            // collection keys so a write to this scope precisely invalidates the operand.
            if (collectionKeys) {
                for (const nodeId of tree.getNodeIdsForPath(directoryPath, { recursive })) {
                    collectionKeys.push(collection.makeKey(nodeId));
                }
            }
            const directoryBitmap = recursive
                ? await tree.findRecursive(directoryPath)
                : await tree.find(directoryPath);
            if (!directoryBitmap || directoryBitmap.isEmpty) {
                continue;
            }

            if (resultBitmap) {
                resultBitmap.orInPlace(directoryBitmap);
            } else {
                resultBitmap = directoryBitmap;
            }
        }

        return sawExistingPath ? (resultBitmap || new RoaringBitmap32()) : new RoaringBitmap32();
    }

    async #buildFeaturesBitmap(features) {
        const normalizedFeatures = this.#normalizeQueryFeatures(features);
        if (!normalizedFeatures) {
            return null;
        }

        const { allOf, anyOf, noneOf } = normalizedFeatures;
        if (allOf.length === 0 && anyOf.length === 0 && noneOf.length === 0) {
            return null;
        }

        let featureBitmap = null;
        if (allOf.length > 0) {
            featureBitmap = await this.bitmapIndex.AND(allOf);
        }

        if (anyOf.length > 0) {
            const anyBitmap = await this.bitmapIndex.OR(anyOf);
            if (featureBitmap) {
                featureBitmap.andInPlace(anyBitmap);
            } else {
                featureBitmap = anyBitmap;
            }
        }

        if (noneOf.length > 0) {
            if (!featureBitmap) {
                featureBitmap = await this.#buildAllDocumentsBitmap();
            }
            const noneBitmap = await this.bitmapIndex.OR(noneOf);
            if (noneBitmap && !noneBitmap.isEmpty) {
                featureBitmap.andNotInPlace(noneBitmap);
            }
        }

        return featureBitmap || new RoaringBitmap32();
    }

    async #buildAllDocumentsBitmap() {
        const ids = [];
        for await (const { key } of this.documents.getRange()) {
            const id = Number(key);
            if (Number.isInteger(id) && id > 0) {
                ids.push(id);
            }
        }
        return new RoaringBitmap32(ids);
    }

    /**
     * Rebuild feature bitmaps from document data. Scans all documents and ensures
     * each document's schema is indexed in the feature bitmap collection.
     */
    /**
     * Safely parse an array of raw documents, skipping corrupted entries instead of crashing.
     */
    #safeParseDocuments(docs) {
        const result = [];
        for (const doc of docs) {
            try {
                result.push(parseInitializeDocument(doc));
            } catch (e) {
                debug(`safeParseDocuments: Skipping corrupted document (id=${doc?.id ?? 'unknown'}): ${e.message}`);
            }
        }
        return result;
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
            const docs = this.#safeParseDocuments(await this.documents.getMany(slice));

            await this.#withDeferredMembership(async () => {
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
            const docs = this.#safeParseDocuments(await this.documents.getMany(slice));

            await this.#withDeferredMembership(async () => {
                for (const doc of docs) {
                    counts.scanned++;
                    const keys = mimeBitmapKeys(doc);
                    if (keys.length) {
                        await this.#applyMembership('tick', doc.id, keys);
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
        if (!this.#vectorIndex) {
            throw new Error('Dense vector store not available (semantic disabled or not ready)');
        }
        const space = opts.space || 'text';
        const embeddableSchemas = (Array.isArray(opts.schemas) && opts.schemas.length)
            ? opts.schemas
            : Array.from(this.#semanticConfig.embeddableSchemas);
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
