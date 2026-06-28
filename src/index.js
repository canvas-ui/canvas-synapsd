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
import Embedder from './semantic/Embedder.js';
import EmbeddingQueue from './semantic/EmbeddingQueue.js';

// Views / Abstractions
import ContextTree from './views/ContextTree.js';
import DirectoryTree from './views/DirectoryTree.js';

// Extracted utilities
import { parseContextSpecForInsert, parseBitmapArray } from './utils/parsing.js';
import { parseFilters, applyTimelineFilter } from './utils/filters.js';
import { parseSpec } from './utils/spec.js';
import { parseDocumentData, initializeDocument, parseInitializeDocument } from './utils/document.js';
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
    #vectorIndex;
    #embedder;
    #embeddingQueue;
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
        // search degrade gracefully to lexical). cacheDir is fastembed's model
        // store; defaults under the workspace lance dir, but a shared
        // canvas-server store can be passed to avoid an N×model footprint.
        const sem = options.semantic || {};
        this.#semanticConfig = {
            enabled: sem.enabled !== false,
            model: sem.model || 'bge-small-en-v1.5',
            dim: sem.dim || 384,
            maxLength: sem.maxLength || 512,
            cacheDir: sem.cacheDir || path.join(this.#rootPath, 'lance', 'models'),
            // JSON abstractions the server can read + embed itself. Everything
            // else (blobs/media) relies on app-provided vectors.
            embeddableSchemas: new Set(sem.embeddableSchemas || ['data/abstraction/note']),
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

        out.semantic = {
            enabled: true,
            model: this.#semanticConfig.model,
            dim: this.#semanticConfig.dim,
            cacheDir: this.#semanticConfig.cacheDir,
            embeddableSchemas: [...this.#semanticConfig.embeddableSchemas],
            vector: this.#vectorIndex ? await this.#vectorIndex.stats().catch(e => ({ ready: false, error: e.message })) : { ready: false },
            embedder: this.#embedder ? this.#embedder.status() : { workerSpawned: false },
            queue: this.#embeddingQueue
                ? { pending: this.#embeddingQueue.size, draining: this.#embeddingQueue.isDraining }
                : null,
        };
        return out;
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
                    this.#vectorIndex = new VectorIndex({
                        rootPath: path.join(this.#rootPath, 'lance'),
                        dim: this.#semanticConfig.dim,
                        bitmapIndex: this.bitmapIndex,
                    });
                    await this.#vectorIndex.initialize();

                    this.#embedder = new Embedder({
                        model: this.#semanticConfig.model,
                        dim: this.#semanticConfig.dim,
                        maxLength: this.#semanticConfig.maxLength,
                        cacheDir: this.#semanticConfig.cacheDir,
                    });

                    this.#embeddingQueue = new EmbeddingQueue({
                        embedder: this.#embedder,
                        vectorIndex: this.#vectorIndex,
                        documentsStore: this.documents,
                        parseDoc: parseInitializeDocument,
                    });
                    this.#embeddingQueue.on('error', ({ docId, error }) => debug(`embed queue: doc ${docId}: ${error}`));

                    // Resume: enqueue embeddable docs missing from the vectors bitmap.
                    await this.#backfillVectors();
                } catch (e) {
                    debug(`Semantic vector stack init failed (continuing fts-only): ${e.message}`);
                    this.#vectorIndex = null;
                    this.#embeddingQueue = null;
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
            // Tear down the embedding worker thread (and stop the queue).
            if (this.#embeddingQueue) { this.#embeddingQueue.stop(); }
            if (this.#embedder) { try { await this.#embedder.stop(); } catch (_) { } }
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

                const entry = { parsed, existing: !!existing, isUpdate, prevChecksums, prevLocations, prevTimelineState, docFeatures };
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
                }
            });

        } catch (error) {
            throw new Error(`putMany transaction failed: ${error.message}`);
        }

        // ── Phase 3: Lance (best-effort, single batch add) ───────────────

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

        // ── Phase 3.5: Dense vectors (async, server-embeddable docs) ─────
        // Skipped under skipLance so bulk importers control timing; they
        // re-drive via indexDocumentsInLance (which also enqueues).
        if (!skipLance) {
            this.#enqueueEmbeddable(prepared.map(p => p.parsed));
        }

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
            this.emit(EVENTS.DOCUMENT_INSERTED, createEvent(EVENTS.DOCUMENT_INSERTED, {
                ids: insertedIds,
                count: insertedIds.length,
                batch: true,
                context: contextSpec,
                directory: directorySpec,
            }));
        }
        if (updatedIds.length > 0) {
            this.emit(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, {
                ids: updatedIds,
                count: updatedIds.length,
                batch: true,
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
        // Deferred-lance importers route embedding here too.
        this.#enqueueEmbeddable(documents);
    }

    async optimizeLance() {
        return await this.#lanceIndex.optimize();
    }

    /**
     * Optimize + (re)build the dense-vector index. Best-effort; safe to call
     * after a bulk import to compact fragments and build the ANN index.
     */
    async optimizeVectors() {
        if (!this.#vectorIndex) { return null; }
        await this.#vectorIndex.optimize();
        return await this.#vectorIndex.ensureVectorIndex();
    }

    /** Wait for the async embedding queue to drain (test/import helper). */
    async drainEmbeddingQueue() {
        if (this.#embeddingQueue) { await this.#embeddingQueue.drained(); }
    }

    /** A JSON abstraction the server can read and embed itself (vs app-provided vectors). */
    #isServerEmbeddable(doc) {
        return !!doc && this.#semanticConfig.embeddableSchemas.has(doc.schema);
    }

    /** Enqueue server-embeddable docs for async vector indexing. No-op when disabled. */
    #enqueueEmbeddable(parsedDocs) {
        if (!this.#embeddingQueue) { return; }
        for (const doc of parsedDocs) {
            if (this.#isServerEmbeddable(doc)) { this.#embeddingQueue.enqueue(doc.id); }
        }
    }

    /**
     * Store app-provided chunk vectors for a document (the non-JSON / media path —
     * server doesn't decode blobs, the client computes and ships vectors).
     * @param {number} docId
     * @param {string} schema
     * @param {string} updatedAt
     * @param {{chunkId:number, text?:string, vector:number[]}[]} chunks
     */
    async storeDocumentEmbeddings(docId, schema, updatedAt, chunks) {
        if (!this.#vectorIndex) { return false; }
        await this.#vectorIndex.upsertChunks(docId, schema, updatedAt, chunks);
        return true;
    }

    /** Enqueue embeddable docs absent from the vectors bitmap (startup resume). */
    async #backfillVectors() {
        const schemas = Array.from(this.#semanticConfig.embeddableSchemas);
        if (schemas.length === 0) { return; }
        const embeddable = await this.bitmapIndex.OR(normalizeBitmapKeys(schemas));
        if (!embeddable || embeddable.isEmpty) { return; }
        const done = await this.bitmapIndex.getBitmap('internal/lance/vectors', false);
        if (done) { embeddable.andNotInPlace(done); }
        const ids = embeddable.toArray();
        if (ids.length > 0) {
            debug(`vector backfill: enqueuing ${ids.length} unembedded docs`);
            this.#embeddingQueue.enqueueMany(ids);
        }
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

        // Emit events for all successfully linked docs
        const treeType = contextSpec ? 'context' : (directorySpec ? 'directory' : null);
        const treeSpec = contextSpec ?? directorySpec;
        for (const { index, id, docFeatures } of toProcess) {
            result.successful.push({ index, id });
            try {
                if (treeType && treeSpec) {
                    const { tree } = this.#resolveTreeSelection(treeType, treeSpec, treeType === 'context' ? '/' : null);
                    tree.emit(EVENTS.TREE_DOCUMENT_INSERTED, createEvent(EVENTS.TREE_DOCUMENT_INSERTED, {
                        documentId: id,
                        contextSpec,
                        directorySpec,
                        source: 'tree',
                    }));
                }
                this.emit(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, {
                    id,
                    memberships: { context: contextSpec, directory: directorySpec, features: docFeatures },
                }));
            } catch (eventError) {
                debug(`linkMany: Failed to emit events for doc ${id}: ${eventError.message}`);
            }
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
        if (this.#vectorIndex) {
            try {
                const vecClean = await this.#vectorIndex.deleteMany(deletedIds);
                lanceClean = lanceClean && vecClean;
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
            if (ids.length === 1) {
                this.emit(EVENTS.DOCUMENT_DELETED, createEvent(EVENTS.DOCUMENT_DELETED, { id: ids[0] }));
            } else {
                this.emit(EVENTS.DOCUMENT_DELETED_BATCH, createEvent(EVENTS.DOCUMENT_DELETED_BATCH, { ids }));
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
        if (this.#isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            // Preserve an explicit null context (consistent with #updateOne /
            // putMany / link): a directory-only insert into /.incoming should NOT
            // tick the context root — see #resolveDocumentMembershipKeys, which
            // skips root for incoming directory paths when contextSpec is falsy.
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
            emitEvent = opts.emitEvent ?? emitEvent;
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
            });
        } catch (error) {
            throw new Error('Error inserting document atomically: ' + error.message);
        }

        // Best-effort Lance upsert
        try { await this.#lanceIndex.upsert(parseInitializeDocument(parsedDocument)); } catch (_) { }
        this.#enqueueEmbeddable([parsedDocument]);

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
            }));
        }

        return parsedDocument.id;
    }

    async #linkOne(docId, contextSpec = { path: '/' }, featureBitmapArray = [], emitEvent = true) {
        if (!docId) { throw new Error('Document id required'); }

        let directorySpec = null;
        if (this.#isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
            emitEvent = opts.emitEvent ?? emitEvent;
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
        const prefix = collection.prefix;
        const paths = [];

        for (const layerKey of layerKeys) {
            if (!layerKey.startsWith(prefix)) {
                continue;
            }
            const nodeId = layerKey.slice(prefix.length);
            const path = await tree.getPathByNodeId(nodeId);
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
        const prefix = collection.prefix;
        const paths = [];

        for (const layerKey of layerKeys) {
            if (!layerKey.startsWith(prefix)) {
                continue;
            }
            const layerId = layerKey.slice(prefix.length);
            const path = tree.getPathByLayerId(layerId);
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

        const prefix = tree.type === 'directory'
            ? this.#directoryBitmapCollectionForTree(tree.id).prefix
            : this.#contextBitmapCollectionForTree(tree.id).prefix;
        const layerKeys = await this.#synapses.listSynapses(id);
        return layerKeys.some((layerKey) => layerKey.startsWith(prefix));
    }

    // ========================================
    // Read surface: resolveCandidates + rank
    // ========================================
    //
    // The public read API is list() + query(). Both are thin callers of one seam:
    //   resolveCandidates(spec) -> { bitmap, keys }   paths ∩ features ∩ filters
    //   rank(bitmap, match, opts) -> page             match=null slices, else fts/vector/hybrid
    // The db stays stateless: `keys` lets a session invalidate precisely, but
    // nothing is cached here.

    async resolveCandidates(rawSpec = {}) {
        return await this.#resolveParsed(parseSpec(rawSpec));
    }

    async #resolveParsed(parsed) {
        const { paths, features, filters } = parsed;
        const keys = [];
        let bitmap = null;
        let constrained = false;

        const includeBitmap = await this.#buildPathsBitmap(paths.in, keys);
        if (includeBitmap) {
            bitmap = includeBitmap;
            constrained = true;
        }

        const featureBitmap = await this.#buildFeaturesBitmap(features);
        if (featureBitmap) {
            keys.push(...features.allOf, ...features.anyOf, ...features.noneOf);
            if (bitmap) { bitmap.andInPlace(featureBitmap); } else { bitmap = featureBitmap; }
            constrained = true;
        }

        if (filters.length > 0) {
            const { bitmapFilters, timelineFilters } = parseFilters(filters);
            if (bitmapFilters.length > 0) {
                const filterKeys = normalizeBitmapKeys(bitmapFilters);
                keys.push(...filterKeys);
                const filterBitmap = await this.bitmapIndex.AND(filterKeys);
                if (bitmap) { bitmap.andInPlace(filterBitmap); } else { bitmap = filterBitmap; }
                constrained = true;
            }
            if (timelineFilters.length > 0) {
                const timelineBitmap = await this.#combineTimelineFilters(timelineFilters);
                keys.push(...timelineFilters.map((f) => `t:${f.name}`));
                if (bitmap) { bitmap.andInPlace(timelineBitmap); } else { bitmap = timelineBitmap; }
                constrained = true;
            }
        }

        if (paths.not.length > 0) {
            const excludeBitmap = await this.#buildPathsBitmap(paths.not, keys);
            if (excludeBitmap && !excludeBitmap.isEmpty) {
                const base = bitmap || await this.#buildAllDocumentsBitmap();
                base.andNotInPlace(excludeBitmap);
                bitmap = base;
                constrained = true;
            }
        }

        return { bitmap: constrained ? (bitmap || new RoaringBitmap32()) : null, keys };
    }

    // Union bitmap for a set of {type, path} entries; null when there are none.
    async #buildPathsBitmap(entries = [], keys = []) {
        if (!Array.isArray(entries) || entries.length === 0) { return null; }
        let result = null;
        for (const { type, path, tree } of entries) {
            keys.push(`${type}:${path}`);
            const selector = tree ? { tree, path } : { path };
            const bm = type === 'directory'
                ? await this.#buildDirectorySelectorBitmap(selector)
                : await this.#buildContextSelectorBitmap(selector);
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

            if (bitmap === null) {
                const totalCount = await this.documents.getCount();
                const pagedDocs = [];
                let seen = 0;
                for await (const { value } of this.documents.getRange()) {
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

        // fts (BM25) | vector (kNN) | hybrid (RRF); vector/hybrid degrade to fts
        // when the dense stack is unavailable.
        let mode = (options.mode || 'hybrid').toLowerCase();
        if ((mode === 'vector' || mode === 'hybrid') && (!this.#vectorIndex || !this.#vectorIndex.isReady)) {
            debug(`rank: mode '${mode}' requested but vector index not ready; falling back to fts`);
            mode = 'fts';
        }
        if (mode === 'fts' && (!this.#lanceIndex || !this.#lanceIndex.isReady)) {
            const empty = this.#emptyResult();
            empty.error = 'FTS not initialized';
            return empty;
        }

        const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : 50;
        const offset = Math.max(0, Number.isFinite(options.offset) ? Number(options.offset) : 0);

        if (bitmap !== null && bitmap.isEmpty) { return this.#emptyResult(); }
        const scopedIds = bitmap ? bitmap.toArray() : [];

        let pageIds, totalCount, error;
        if (mode === 'vector' || mode === 'hybrid') {
            let queryVector = null;
            try {
                queryVector = await this.#embedder.embedQuery(queryString);
            } catch (e) {
                debug(`rank: query embedding failed (${e.message}); falling back to fts`);
            }
            if (!queryVector) {
                ({ pageIds, totalCount, error } = await this.#lanceIndex.ftsQuery(queryString, scopedIds, { limit, offset }));
            } else if (mode === 'hybrid') {
                ({ pageIds, totalCount, error } = await this.#vectorIndex.hybridSearch(queryVector, queryString, scopedIds, { limit, offset }));
            } else {
                ({ pageIds, totalCount, error } = await this.#vectorIndex.vectorSearch(queryVector, scopedIds, { limit, offset }));
            }
        } else {
            ({ pageIds, totalCount, error } = await this.#lanceIndex.ftsQuery(queryString, scopedIds, { limit, offset }));
        }

        const docs = pageIds.length > 0 ? await this.documents.getMany(pageIds) : [];
        const result = this.#safeParseDocuments(docs);
        result.count = result.length;
        result.totalCount = totalCount;
        result.error = error;
        return result;
    }

    #emptyResult() {
        const empty = [];
        empty.count = 0;
        empty.totalCount = 0;
        empty.error = null;
        return empty;
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

    async #updateOne(docIdentifier, updateData = null, contextSpec = null, featureBitmapArray = []) {
        if (!docIdentifier) { throw new Error('Document identifier required'); }
        if (typeof docIdentifier !== 'number') { throw new Error('Document identifier must be a numeric ID'); }
        if (!Array.isArray(featureBitmapArray)) { featureBitmapArray = [featureBitmapArray].filter(Boolean); }

        // Canonical update signature accepts a selector/options object.
        let directorySpec = null;
        if (this.#isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
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
            });

            this.emit(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, { id: updatedDocument.id, document: updatedDocument }));

            // Best-effort Lance upsert
            try {
                await this.#lanceIndex.upsert(parseInitializeDocument(updatedDocument));
            } catch (e) {
                debug(`put/update: Lance upsert failed for ${updatedDocument.id}: ${e.message}`);
            }
            // Content changed → re-embed (queue is idempotent; replaces chunks).
            this.#enqueueEmbeddable([updatedDocument]);

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
        if (this.#isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
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
            }));
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
            if (this.#vectorIndex) {
                try {
                    const vecClean = await this.#vectorIndex.deleteDoc(docId);
                    lanceClean = lanceClean && vecClean;
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
                this.emit(EVENTS.DOCUMENT_DELETED, createEvent(EVENTS.DOCUMENT_DELETED, { id: docId }));
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
            await this.createTree('incoming', 'directory', { isDefault: true });
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
                bitmapCollection: this.#directoryBitmapCollectionForTree(meta.id),
            })
            : new ContextTree({
                dataStore,
                db: this,
                treeId: meta.id,
                treeName: meta.name,
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
            ['context', 'directory', 'features', 'attributes', 'emitEvent'].some((key) => Object.prototype.hasOwnProperty.call(value, key))
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
        };
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

            if (!contextSpec && dirs.some((dirPath) => !this.#isIncomingDirectoryPath(dirPath))) {
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
        for (const { op, docId, keys } of buffer) {
            try {
                if (op === 'tick') {
                    await this.bitmapIndex.tickMany(keys, docId);
                } else {
                    await this.bitmapIndex.untickMany(keys, docId);
                }
            } catch (error) {
                // Committed doc may now lack/keep a bitmap membership it should
                // not — recoverable by reindexing from the synapse reverse index.
                debug(`Post-commit bitmap ${op} failed for doc ${docId}: ${error.message}`);
            }
        }
    }

    /** Buffer a bitmap membership op if a deferred-membership tx is active, else apply now. */
    async #applyMembership(op, docId, keys) {
        if (this.#membershipBuffer) {
            this.#membershipBuffer.push({ op, docId, keys });
            return;
        }
        if (op === 'tick') {
            await this.bitmapIndex.tickMany(keys, docId);
        } else {
            await this.bitmapIndex.untickMany(keys, docId);
        }
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

    async #buildContextSelectorBitmap(contextSpec) {
        if (!contextSpec) {
            return null;
        }

        const { tree, collection, path } = this.#resolveTreeSelection('context', contextSpec, '/');
        const pathLayersArray = parseContextSpecForInsert(path);
        let resultBitmap = null;
        let sawExplicitPath = false;
        let sawExistingPath = false;

        for (const pathLayers of pathLayersArray) {
            if (pathLayers.length === 1 && pathLayers[0] === '/') {
                sawExplicitPath = true;
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
                pathBitmap = await this.#getContextRootBitmap(tree, collection);
            } else {
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

    async #buildDirectorySelectorBitmap(directorySpec) {
        if (!directorySpec) {
            return null;
        }

        const { tree, path } = this.#resolveTreeSelection('directory', directorySpec, '/');
        const directoryPaths = Array.isArray(path) ? path.filter(Boolean) : [path].filter(Boolean);
        if (directoryPaths.length === 0) {
            return null;
        }

        let resultBitmap = null;
        let sawExistingPath = false;
        for (const directoryPath of directoryPaths) {
            if (!tree.pathExists(directoryPath)) {
                continue;
            }

            sawExistingPath = true;
            const directoryBitmap = await tree.find(directoryPath);
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

    #isIncomingDirectoryPath(path) {
        const normalized = String(path || '/').trim().replace(/\/+/g, '/').replace(/\/$/, '') || '/';
        return normalized === '/.incoming' || normalized.startsWith('/.incoming/');
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
