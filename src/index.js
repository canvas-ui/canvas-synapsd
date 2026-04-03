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

// DB Backend
import LmdbBackend from './backends/lmdb/index.js';

// Schemas
import schemaRegistry from './schemas/SchemaRegistry.js';
import { isDocumentData, isDocumentInstance } from './schemas/SchemaRegistry.js';
import BaseDocument from './schemas/BaseDocument.js';

// Indexes
import BitmapIndex from './indexes/bitmaps/index.js';
import ChecksumIndex from './indexes/inverted/Checksum.js';
import TimestampIndex from './indexes/inverted/Timestamp.js';
import Synapses from './indexes/inverted/Synapses.js';
import LanceIndex from './indexes/lance/index.js';

// Views / Abstractions
import ContextTree from './views/ContextTree.js';
import DirectoryTree from './views/DirectoryTree.js';

// Extracted utilities
import { parseContextSpecForInsert, parseBitmapArray } from './utils/parsing.js';
import { parseFilters, applyDatetimeFilter } from './utils/filters.js';
import { parseDocumentData, initializeDocument, parseInitializeDocument, generateDocumentID, generateDocumentIDs } from './utils/document.js';
import PrefixedStore from './utils/PrefixedStore.js';

// Constants
const INTERNAL_BITMAP_ID_MAX = 100000;

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
    #timestampIndex;
    #synapses;

    // LanceDB
    #lanceIndex;

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
        this.#timestampIndex = null;

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
            timestampIndexSize: this.#timestampIndex ? this.#timestampIndex.getCount() : 0,
            // TODO: Refactor this away
            deletedDocumentsCount: this.deletedDocumentsBitmap ? this.deletedDocumentsBitmap.size : 0,
            actionBitmaps: this.actionBitmaps ? {
                created: this.actionBitmaps.created.size,
                updated: this.actionBitmaps.updated.size,
                deleted: this.actionBitmaps.deleted.size,
            } : {
                created: 0,
                updated: 0,
                deleted: 0,
            },
        };
    }

    get db() { return this.#db; } // For testing only

    // Inverted indexes
    get checksumIndex() { return this.#checksumIndex; }
    get timestampIndex() { return this.#timestampIndex; }
    get synapses() { return this.#synapses; }

    /**
     * Service methods
     */

    async start() {
        debug('Starting SynapsD');
        try {
            // Initialize action bitmaps
            this.actionBitmaps = {
                created: await this.bitmapIndex.createBitmap('internal/action/created'),
                updated: await this.bitmapIndex.createBitmap('internal/action/updated'),
                deleted: await this.bitmapIndex.createBitmap('internal/action/deleted'),
            };
            // Initialize deletedDocumentsBitmap here
            this.deletedDocumentsBitmap = await this.bitmapIndex.createBitmap('internal/gc/deleted');

            this.#timestampIndex = new TimestampIndex(
                this.bitmapIndex,
                this.actionBitmaps,
            );

            // Initialize Synapses inverted index
            this.#synapses = new Synapses(
                this.#db.createDataset('synapses'),
                this.bitmapIndex
            );

            // Initialize LanceDB under workspace root (rootPath/lance)
            this.#lanceIndex = new LanceIndex({
                rootPath: path.join(this.#rootPath, 'lance'),
                bitmapIndex: this.bitmapIndex,
            });
            await this.#lanceIndex.initialize();
            await this.#lanceIndex.backfill(this.bitmapIndex, this.documents, parseInitializeDocument, 1000);

            await this.#loadTreeRegistry();
            await this.#ensureDefaultTrees();

            // Migrate bitmap keys from legacy format (one-time, idempotent)
            await this.#migrateBitmapKeys();

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

    async put(document, treeSelector = null, features = [], options = {}) {
        const spec = this.#normalizeDocumentOperationSpec(treeSelector, features, options);

        if (!document || typeof document !== 'object' || Array.isArray(document)) {
            throw new Error('Document object is required');
        }

        if (document.id !== undefined && document.id !== null) {
            const existing = await this.#getById(document.id);
            if (existing) {
                return await this.#updateOne(document.id, document, spec);
            }
        }

        return await this.#putOne(document, spec);
    }

    async link(idOrIds, treeSelector = null, features = [], options = {}) {
        if (Array.isArray(idOrIds)) {
            return await this.linkMany(idOrIds, treeSelector, features, options);
        }
        if (!idOrIds) { throw new Error('Document id required'); }
        const spec = this.#normalizeDocumentOperationSpec(treeSelector, features, options);
        return await this.#linkOne(idOrIds, spec);
    }

    async has(id, treeSelector = null, features = []) {
        if (!id) { throw new Error('Document id required'); }
        const spec = this.#normalizeDocumentOperationSpec(treeSelector, features, {});
        return await this.#hasOne(id, spec);
    }

    async unlink(idOrIds, treeSelector = null, features = [], options = {}) {
        if (Array.isArray(idOrIds)) {
            return await this.unlinkMany(idOrIds, treeSelector, features, options);
        }
        if (!idOrIds) { throw new Error('Document id required'); }
        const spec = this.#normalizeDocumentOperationSpec(treeSelector, features, options);
        return await this.#unlinkOne(idOrIds, spec, options);
    }

    async delete(id, options = {}) {
        if (!id) { throw new Error('Document id required'); }
        return await this.#deleteOne(id, options);
    }

    async putMany(documents, treeSelector = null, features = [], options = {}) {
        const skipLance = options.skipLance === true;
        const deferredLanceBuffer = options.deferredLanceBuffer;

        const spec = this.#normalizeDocumentOperationSpec(treeSelector, features, options);
        if (!Array.isArray(documents)) {
            throw new Error('Document array must be an array');
        }
        if (documents.length === 0) { return []; }

        debug(`putMany: Attempting to store ${documents.length} documents`);

        // ── Phase 1: Parse, validate, dedup ──────────────────────────────

        let contextSpec = null;
        let directorySpec = null;
        if (this.#isDocumentOperationOptions(spec)) {
            contextSpec = spec.context ?? null;
            directorySpec = spec.directory ?? null;
        } else if (spec.path || spec.tree) {
            // Came from #normalizeDocumentOperationSpec — detect type
            contextSpec = spec;
        }

        const featureBitmaps = parseBitmapArray(spec.features || features);
        const prepared = [];

        for (let i = 0; i < documents.length; i++) {
            try {
                const doc = documents[i];
                const parsed = isDocumentInstance(doc) ? doc : parseInitializeDocument(doc);
                parsed.validateData();

                const primaryChecksum = parsed.getPrimaryChecksum();
                const existing = await this.getByChecksumString(primaryChecksum).catch(() => null);
                if (existing) {
                    parsed.id = existing.id;
                    if (existing.createdAt) { parsed.createdAt = existing.createdAt; }
                    if (existing.updatedAt) { parsed.updatedAt = existing.updatedAt; }
                }

                const docFeatures = [...featureBitmaps];
                if (!docFeatures.includes(parsed.schema)) {
                    docFeatures.push(parsed.schema);
                }

                prepared.push({ parsed, existing: !!existing, docFeatures });
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
            const ids = generateDocumentIDs(this.#internalStore, newDocs.length, INTERNAL_BITMAP_ID_MAX);
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

        // ── Phase 2: Batch write — bitmap ops deferred ───────────────────

        this.bitmapIndex.startBatch();

        try {
            await this.#db.transaction(async () => {
                for (const { parsed, docFeatures } of prepared) {
                    await this.documents.put(parsed.id, parsed);
                    await this.#checksumIndex.insertArray(parsed.checksumArray, parsed.id);
                    await this.#timestampIndex.insert('created', parsed.createdAt || new Date().toISOString(), parsed.id);
                    await this.#timestampIndex.insert('updated', parsed.updatedAt, parsed.id);
                    await this.#indexDocument(parsed.id, contextSpec, directorySpec, docFeatures);
                }
            });

            // Flush all deferred bitmap writes in one pass
            this.bitmapIndex.flushBatch();
        } catch (error) {
            // Discard deferred writes on failure
            this.bitmapIndex.flushBatch();
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

        // ── Phase 4: Events ──────────────────────────────────────────────

        const storedIds = prepared.map(p => p.parsed.id);

        if (storedIds.length > 0 && contextSpec) {
            try {
                const { tree: batchTree } = this.#resolveTreeSelection('context', contextSpec, '/');
                batchTree.emit(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, createEvent(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, {
                    documentIds: storedIds,
                    contextSpec,
                    layerNames: [],
                    source: 'tree',
                }));
            } catch (treeError) {
                debug(`putMany: Failed to emit tree batch event, error: ${treeError.message}`);
            }
        }

        this.emit(EVENTS.DOCUMENT_INSERTED, createEvent(EVENTS.DOCUMENT_INSERTED, {
            ids: storedIds,
            count: storedIds.length,
            batch: true,
        }));

        return storedIds;
    }

    /** Append parsed documents to the Lance FTS table (same payload as putMany phase 3). */
    async indexDocumentsInLance(documents) {
        if (!documents?.length) { return; }
        try {
            await this.#lanceIndex.addMany(documents);
        } catch (_) { }
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

                const docFeatures = [...featureBitmaps];
                if (!docFeatures.includes(parsed.schema)) {
                    docFeatures.push(parsed.schema);
                }

                const norm = this.#normalizeDocumentOperationSpec(
                    { tree: treeName, path: dirPath },
                    featureArray,
                    { emitEvent: false },
                );
                const directorySpec = norm.directory;
                if (!directorySpec) {
                    throw new Error(`putManyDirectoryPaths: expected directory tree (${treeName})`);
                }

                prepared.push({ parsed, docFeatures, directorySpec });
            } catch (error) {
                const contextualError = new Error(`Failed to prepare document at index ${i}: ${error.message}`);
                contextualError.cause = error;
                throw contextualError;
            }
        }

        if (prepared.length === 0) { return []; }

        const ids = generateDocumentIDs(this.#internalStore, prepared.length, INTERNAL_BITMAP_ID_MAX);
        for (let i = 0; i < prepared.length; i++) {
            prepared[i].parsed.id = ids[i];
        }

        for (let i = 0; i < prepared.length; i++) {
            prepared[i].parsed.validate();
        }

        this.bitmapIndex.startBatch();

        try {
            await this.#db.transaction(async () => {
                for (const { parsed, docFeatures, directorySpec } of prepared) {
                    await this.documents.put(parsed.id, parsed);
                    await this.#checksumIndex.insertArray(parsed.checksumArray, parsed.id);
                    await this.#timestampIndex.insert('created', parsed.createdAt || new Date().toISOString(), parsed.id);
                    await this.#timestampIndex.insert('updated', parsed.updatedAt, parsed.id);
                    await this.#indexDocument(parsed.id, null, directorySpec, docFeatures);
                }
            });

            this.bitmapIndex.flushBatch();
        } catch (error) {
            this.bitmapIndex.flushBatch();
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
            this.emit(EVENTS.DOCUMENT_INSERTED, createEvent(EVENTS.DOCUMENT_INSERTED, {
                ids: storedIds,
                count: storedIds.length,
                batch: true,
            }));
        }

        return storedIds;
    }

    async linkMany(ids, treeSelector = null, features = [], options = {}) {
        const spec = this.#normalizeDocumentOperationSpec(treeSelector, features, options);
        if (!Array.isArray(ids)) {
            throw new Error('Document ID array must be an array');
        }

        const result = {
            successful: [],
            failed: [],
            count: ids.length,
        };

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (typeof id !== 'number') {
                result.failed.push({ index: i, id, error: 'Invalid document ID: Must be a number.' });
                continue;
            }
            try {
                const linkedId = await this.link(id, spec);
                result.successful.push({ index: i, id: linkedId });
            } catch (error) {
                result.failed.push({ index: i, id, error: error.message || 'Unknown error' });
            }
        }

        return result;
    }

    async unlinkMany(ids, treeSelector = null, features = [], options = {}) {
        const spec = this.#normalizeDocumentOperationSpec(treeSelector, features, options);
        if (!Array.isArray(ids)) {
            throw new Error('Document ID array must be an array');
        }

        const result = {
            successful: [],
            failed: [],
            count: ids.length,
        };

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (typeof id !== 'number') {
                result.failed.push({ index: i, id, error: 'Invalid document ID: Must be a number.' });
                continue;
            }
            try {
                const removedId = await this.unlink(id, spec, options);
                result.successful.push({ index: i, id: removedId });
            } catch (error) {
                result.failed.push({ index: i, id, error: error.message || 'Unknown error' });
            }
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

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (typeof id !== 'number') {
                result.failed.push({ index: i, id, error: 'Invalid document ID: Must be a number.' });
                continue;
            }
            try {
                const success = await this.delete(id, options);
                if (success) {
                    result.successful.push({ index: i, id });
                } else {
                    result.failed.push({ index: i, id, error: 'Document not found or already deleted' });
                }
            } catch (error) {
                result.failed.push({ index: i, id, error: error.message || 'Unknown error' });
            }
        }

        return result;
    }

    async #putOne(document, contextSpec = { path: '/' }, featureBitmapArray = [], emitEvent = true) {
        if (!document) { throw new Error('Document is required'); }

        // Canonical document insert signature accepts a selector/options object.
        let directorySpec = null;
        if (this.#isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            contextSpec = opts.context ?? { path: '/' };
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
            parsedDocument.id = generateDocumentID(this.#internalStore, INTERNAL_BITMAP_ID_MAX);
        }

        parsedDocument.validate();

        // Ensure schema is in features
        if (!featureBitmaps.includes(parsedDocument.schema)) {
            featureBitmaps.push(parsedDocument.schema);
        }

        try {
            await this.#db.transaction(async () => {
                await this.documents.put(parsedDocument.id, parsedDocument);
                await this.#checksumIndex.insertArray(parsedDocument.checksumArray, parsedDocument.id);
                await this.#timestampIndex.insert('created', parsedDocument.createdAt || new Date().toISOString(), parsedDocument.id);
                await this.#timestampIndex.insert('updated', parsedDocument.updatedAt, parsedDocument.id);
                await this.#indexDocument(parsedDocument.id, contextSpec, directorySpec, featureBitmaps);
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
            this.emit(EVENTS.DOCUMENT_INSERTED, createEvent(EVENTS.DOCUMENT_INSERTED, { id: parsedDocument.id, document: parsedDocument }));
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

        await this.#indexDocument(numericId, contextSpec, directorySpec, featureBitmaps);

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

        const keys = await this.bitmapIndex.listBitmaps(prefix);
        const matchingKeys = [];

        for (const key of keys) {
            // We need to check if the ID exists in this bitmap
            // Optimization: check cache first? listBitmaps returns keys.
            // We have to load the bitmap to check.
            const bitmap = await this.bitmapIndex.getBitmap(key, false);
            if (bitmap && bitmap.has(id)) {
                matchingKeys.push(key);
            }
        }
        return matchingKeys;
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

    async find(spec = {}) {
        let {
            treeSelector,
            features,
            filterArray,
            excludeContextSpecs,
            excludeTreeSelectors,
            options,
        } = this.#normalizeFindSpec(spec);

        // Normalize options and pagination defaults
        const effectiveOptions = typeof options === 'object' && options !== null ? { ...options } : { parse: true };
        const parseDocuments = effectiveOptions.parse !== false;
        const providedLimit = Number.isFinite(effectiveOptions.limit) ? Number(effectiveOptions.limit) : undefined;
        const providedOffset = Number.isFinite(effectiveOptions.offset) ? Number(effectiveOptions.offset) : undefined;
        const providedPage = Number.isFinite(effectiveOptions.page) ? Number(effectiveOptions.page) : undefined;
        // If no explicit limit provided, don't apply any limit (return all documents)
        // If limit=0 explicitly provided, also don't apply any limit
        const limit = providedLimit !== undefined ? Math.max(0, providedLimit) : 0;
        const offset = Math.max(0, providedOffset !== undefined ? providedOffset : (providedPage && providedPage > 0 ? (providedPage - 1) * (limit || 100) : 0));

        if (!Array.isArray(filterArray) && typeof filterArray === 'string') { filterArray = [filterArray]; }
        debug(`Listing documents with treeSelector: ${JSON.stringify(treeSelector)}, features: ${JSON.stringify(features)}, filters: ${filterArray}, limit: ${limit}, offset: ${offset}`);

        try {
            // Start with null, will hold RoaringBitmap32 instance if filters are applied
            let resultBitmap = null;
            // Flag to track if any filters actually modified the initial empty bitmap
            let filtersApplied = false;

            const selectorBitmap = await this.#buildSelectorBitmap(treeSelector);
            if (selectorBitmap) {
                resultBitmap = selectorBitmap;
                filtersApplied = true;
            }

            const featureBitmap = await this.#buildFeaturesBitmap(features);
            if (featureBitmap) {
                if (filtersApplied && resultBitmap) {
                    resultBitmap.andInPlace(featureBitmap);
                } else {
                    resultBitmap = featureBitmap;
                    filtersApplied = true;
                }
            }

            // Apply additional filters (bitmaps and datetime filters)
            if (filterArray.length > 0) {
                const { bitmapFilters, datetimeFilters } = parseFilters(filterArray);

                // Apply bitmap filters
                if (bitmapFilters.length > 0) {
                    const filterBitmap = await this.bitmapIndex.AND(bitmapFilters);
                    if (filtersApplied) {
                        resultBitmap.andInPlace(filterBitmap);
                    } else {
                        resultBitmap = filterBitmap;
                        filtersApplied = true;
                    }
                }

                // Apply datetime filters
                for (const datetimeFilter of datetimeFilters) {
                    const datetimeBitmap = await applyDatetimeFilter(datetimeFilter, this.#timestampIndex);
                    if (datetimeBitmap) {
                        if (filtersApplied) {
                            resultBitmap.andInPlace(datetimeBitmap);
                        } else {
                            resultBitmap = datetimeBitmap;
                            filtersApplied = true;
                        }
                    }
                }
            }

            resultBitmap = await this.#applyExcludedContexts(resultBitmap, excludeContextSpecs);
            resultBitmap = await this.#applyExcludedTrees(resultBitmap, excludeTreeSelectors);
            if (resultBitmap) {
                filtersApplied = true;
            }

            // Convert the final bitmap result (which might be null) to an ID array
            const finalDocumentIds = resultBitmap ? resultBitmap.toArray() : [];

            // Case 1: No filters were effectively applied
            if (!filtersApplied) {
                const totalCount = await this.documents.getCount();

                // Iterate and collect the requested page window (or all documents if no limit)
                const pagedDocs = [];
                let seen = 0;
                for await (const { value } of this.documents.getRange()) {
                    if (seen++ < offset) { continue; }
                    pagedDocs.push(value);
                    if (limit > 0 && pagedDocs.length >= limit) { break; }
                }

                // Debug: Log the discrepancy if it exists
                if (limit > 0 && pagedDocs.length < limit && totalCount > pagedDocs.length) {
                    debug(`find: Count discrepancy detected. Database count: ${totalCount}, Actual retrievable documents: ${seen}, Returned: ${pagedDocs.length}`);
                }

                const resultArray = parseDocuments ? this.#safeParseDocuments(pagedDocs) : pagedDocs;
                // Attach count metadata on the returned array.
                resultArray.count = resultArray.length; // Number of documents actually returned (after filtering corrupted)
                resultArray.totalCount = totalCount;    // Total number of documents available
                resultArray.error = null;
                return resultArray;
            }

            // Case 2: Filters were applied, but the resulting bitmap is null or empty
            if (finalDocumentIds.length === 0) {
                debug('find: Resulting bitmap is null or empty after applying filters.');
                const emptyArray = [];
                emptyArray.count = 0;      // Number of documents returned (0)
                emptyArray.totalCount = 0; // Total available (0)
                emptyArray.error = null;
                return emptyArray;
            }

            // Convert bitmap to array of document IDs and apply pagination window
            const totalCount = finalDocumentIds.length;
            const slicedIds = limit === 0 ? finalDocumentIds : finalDocumentIds.slice(offset, offset + limit);

            // Get documents from database for the page
            const documents = await this.documents.getMany(slicedIds);
            const resultArray = parseDocuments ? this.#safeParseDocuments(documents) : documents;
            // Attach count metadata on the returned array.
            resultArray.count = resultArray.length; // Number of documents actually returned (after filtering corrupted)
            resultArray.totalCount = totalCount;  // Total number of documents available
            resultArray.error = null;
            return resultArray;

        } catch (error) {
            debug(`Error in find: ${error.message}`);
            const errorArray = [];
            errorArray.count = 0;      // Number of documents returned (0)
            errorArray.totalCount = 0; // Total available (unknown due to error)
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

        let {
            treeSelector,
            features,
            filterArray,
            excludeContextSpecs,
            excludeTreeSelectors,
            options,
        } = this.#normalizeFindSpec(spec);

        if (!this.#lanceIndex || !this.#lanceIndex.isReady) {
            const empty = [];
            empty.count = 0;
            empty.totalCount = 0;
            empty.error = 'FTS not initialized';
            return empty;
        }

        const effectiveOptions = typeof options === 'object' && options !== null ? { ...options } : { parse: true };
        const limit = Number.isFinite(effectiveOptions.limit) ? Math.max(0, Number(effectiveOptions.limit)) : 50;
        const offset = Math.max(0, Number.isFinite(effectiveOptions.offset) ? Number(effectiveOptions.offset) : 0);

        let candidateBitmap = null;
        let filtersApplied = false;

        const selectorBitmap = await this.#buildSelectorBitmap(treeSelector);
        if (selectorBitmap) {
            candidateBitmap = selectorBitmap;
            filtersApplied = true;
        }

        const featureBitmap = await this.#buildFeaturesBitmap(features);
        if (featureBitmap) {
            if (filtersApplied && candidateBitmap) {
                candidateBitmap.andInPlace(featureBitmap);
            } else {
                candidateBitmap = featureBitmap;
                filtersApplied = true;
            }
        }

        if (Array.isArray(filterArray) && filterArray.length > 0) {
            const { bitmapFilters, datetimeFilters } = parseFilters(filterArray);
            if (bitmapFilters.length > 0) {
                const extraFilter = await this.bitmapIndex.AND(bitmapFilters);
                if (filtersApplied && candidateBitmap) {
                    candidateBitmap.andInPlace(extraFilter);
                } else {
                    candidateBitmap = extraFilter;
                    filtersApplied = true;
                }
            }

            for (const datetimeFilter of datetimeFilters) {
                const datetimeBitmap = await applyDatetimeFilter(datetimeFilter, this.#timestampIndex);
                if (!datetimeBitmap) { continue; }
                if (filtersApplied && candidateBitmap) {
                    candidateBitmap.andInPlace(datetimeBitmap);
                } else {
                    candidateBitmap = datetimeBitmap;
                    filtersApplied = true;
                }
            }
        }

        candidateBitmap = await this.#applyExcludedContexts(candidateBitmap, excludeContextSpecs);
        candidateBitmap = await this.#applyExcludedTrees(candidateBitmap, excludeTreeSelectors);
        if (candidateBitmap) {
            filtersApplied = true;
        }

        const candidateIds = candidateBitmap ? candidateBitmap.toArray() : [];
        if (filtersApplied && candidateIds.length === 0) {
            const empty = [];
            empty.count = 0;
            empty.totalCount = 0;
            empty.error = null;
            return empty;
        }

        // BM25 search — pass candidateIds for post-filtering (empty = search all)
        const { pageIds, totalCount, error } = await this.#lanceIndex.ftsQuery(
            queryString,
            filtersApplied ? candidateIds : [],
            { limit, offset },
        );

        const docs = pageIds.length > 0 ? await this.documents.getMany(pageIds) : [];
        const result = this.#safeParseDocuments(docs);
        result.count = result.length;
        result.totalCount = totalCount;
        result.error = error;
        return result;
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

        // If no update data provided, we're only updating memberships
        if (updateData === null) {
            updateData = storedDocument;
        } else if (typeof updateData === 'object' && !isDocumentInstance(updateData)) {
            if (updateData.schema) {
                updateData = parseInitializeDocument(updateData);
            }
        }

        const updatedDocument = storedDocument.update(updateData);
        updatedDocument.validate();

        // Ensure schema is in features
        if (!featureBitmaps.includes(updatedDocument.schema)) {
            featureBitmaps.push(updatedDocument.schema);
        }

        try {
            await this.documents.put(updatedDocument.id, updatedDocument);
            await this.#checksumIndex.deleteArray(storedDocument.checksumArray);
            await this.#checksumIndex.insertArray(updatedDocument.checksumArray, updatedDocument.id);
            await this.#timestampIndex.insert('updated', updatedDocument.updatedAt, updatedDocument.id);

            // Index across all views using shared helper
            await this.#indexDocument(updatedDocument.id, contextSpec, directorySpec, featureBitmaps);

            this.emit(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, { id: updatedDocument.id, document: updatedDocument }));

            // Best-effort Lance upsert
            try {
                await this.#lanceIndex.upsert(parseInitializeDocument(updatedDocument));
            } catch (e) {
                debug(`put/update: Lance upsert failed for ${updatedDocument.id}: ${e.message}`);
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
        if (this.#isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
        }

        const featureKeys = parseBitmapArray(featureBitmapArray).filter(Boolean);
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
                await this.#synapses.removeSynapses(docId, Array.from(new Set(layersToRemove)));
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
            await this.#db.transaction(async () => {
                // Delete document from main database
                await this.documents.delete(docId);
                debug(`delete: Document ${docId} deleted from main store`);

                // Delete document from all bitmaps AND Reverse Index via Synapses
                // await this.bitmapIndex.untickAll(docId);
                await this.#synapses.clearSynapses(docId);
                debug(`delete: Document ${docId} removed from all bitmaps and Synapses index`);

                // Remove document from timestamp indices (created, updated)
                await this.#timestampIndex.remove(null, docId);
                debug(`delete: Document ${docId} removed from timestamp indices`);

                // Delete document checksums from inverted index
                await this.#checksumIndex.deleteArray(document.checksumArray);
                debug(`delete: Checksums for document ${docId} deleted from index`);

                // Add document ID to deleted documents bitmap
                await this.deletedDocumentsBitmap.tick(docId);
                debug(`delete: Document ${docId} added to deleted documents bitmap`);

                // Update timestamp index
                await this.#timestampIndex.insert('deleted', document.updatedAt || new Date().toISOString(), docId);
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
            try {
                await this.#lanceIndex.delete(docId);
                debug(`delete: LanceDB cleanup completed for document ${docId}`);
            } catch (e) {
                debug(`delete: Lance delete failed for ${docId}: ${e.message}`);
                // Don't fail the entire operation if Lance cleanup fails
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
            const ids = [];
            for (const checksum of checksumStringArray) {
                try {
                    const id = await this.#checksumIndex.checksumStringToId(checksum);
                    if (id) {
                        ids.push(id);
                    }
                } catch (error) {
                    debug(`Error getting ID for checksum ${checksum}: ${error.message}`);
                }
            }

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

        for (let i = 0; i < docIdArray.length; i++) {
            const id = docIdArray[i];
            if (typeof id !== 'number') {
                result.failed.push({ index: i, id: id, error: 'Invalid document ID: Must be a number.' });
                continue;
            }
            try {
                // tickMany doesn't explicitly return success/failure per ID easily,
                // but it should throw if the operation fails for the ID (e.g., DB error).
                // Assuming success if no error is thrown.
                await this.bitmapIndex.tickMany(featureBitmapArray, id);
                result.successful.push({ index: i, id: id });
                debug(`setDocumentArrayFeatures: Successfully set features for document ID ${id} (index ${i}).`);
            } catch (error) {
                debug(`setDocumentArrayFeatures: Error setting features for document ID ${id} (index ${i}). Error: ${error.message}`);
                result.failed.push({
                    index: i,
                    id: id,
                    error: error.message || 'Unknown error',
                });
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

        for (let i = 0; i < docIdArray.length; i++) {
            const id = docIdArray[i];
            if (typeof id !== 'number') {
                result.failed.push({ index: i, id: id, error: 'Invalid document ID: Must be a number.' });
                continue;
            }
            try {
                // untickMany, like tickMany, is assumed to throw on operational failure.
                await this.bitmapIndex.untickMany(featureBitmapArray, id);
                result.successful.push({ index: i, id: id });
                debug(`unsetDocumentArrayFeatures: Successfully unset features for document ID ${id} (index ${i}).`);
            } catch (error) {
                debug(`unsetDocumentArrayFeatures: Error unsetting features for document ID ${id} (index ${i}). Error: ${error.message}`);
                result.failed.push({
                    index: i,
                    id: id,
                    error: error.message || 'Unknown error',
                });
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
        const documentArray = await this.find({
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
            await this.createTree('context', 'context', { isDefault: true });
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
            return features.filter(Boolean);
        }
        if (typeof features === 'object') {
            return parseBitmapArray(features.allOf ?? features.features ?? []).filter(Boolean);
        }
        return [features].filter(Boolean);
    }

    #normalizeQueryFeatures(features) {
        if (!features) {
            return null;
        }

        if (Array.isArray(features)) {
            return {
                allOf: [],
                anyOf: features.filter(Boolean),
                noneOf: [],
            };
        }

        if (typeof features !== 'object') {
            throw new Error('find(): features must be an array or object');
        }

        return {
            allOf: parseBitmapArray(features.allOf ?? []).filter(Boolean),
            anyOf: parseBitmapArray(features.anyOf ?? []).filter(Boolean),
            noneOf: parseBitmapArray(features.noneOf ?? []).filter(Boolean),
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

    #normalizeDocumentOperationSpec(treeSelector = null, features = [], options = {}) {
        if (this.#isDocumentOperationOptions(treeSelector)) {
            const legacyFeatures = treeSelector.features
                ?? treeSelector.attributes?.allOf
                ?? treeSelector.attributes
                ?? [];
            return {
                context: treeSelector.context ?? { path: '/' },
                directory: treeSelector.directory ?? null,
                features: this.#normalizeWriteFeatures(legacyFeatures),
                emitEvent: treeSelector.emitEvent ?? options.emitEvent ?? true,
            };
        }

        if (
            features &&
            typeof features === 'object' &&
            !Array.isArray(features) &&
            Object.keys(options || {}).length === 0
        ) {
            options = features;
            features = [];
        }

        const selection = this.#resolveGenericTreeSelection(treeSelector, '/', 'context');
        return {
            context: selection.type === 'context' ? selection.spec : null,
            directory: selection.type === 'directory' ? selection.spec : null,
            features: this.#normalizeWriteFeatures(features),
            emitEvent: options.emitEvent ?? true,
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
        const allSynapseKeys = [];

        // Context tree: resolve layer names to ULIDs and tick bitmaps
        if (contextSpec) {
            const { tree: contextTree, collection, path: contextPath } = this.#resolveTreeSelection('context', contextSpec, '/');
            const pathLayersArray = parseContextSpecForInsert(contextPath);
            for (const pathLayers of pathLayersArray) {
                const pathString = pathLayers.join('/');
                await contextTree.insertPath(pathString);

                const layerIds = contextTree.resolveLayerIds(pathLayers);
                await collection.tickMany(layerIds, docId);

                const normalizedLayers = layerIds.map((layerId) => collection.makeKey(layerId));
                allSynapseKeys.push(...normalizedLayers);
            }
        }

        // Directory tree: index document at directory path(s)
        if (directorySpec) {
            const { tree: directoryTree, path: directoryPath } = this.#resolveTreeSelection('directory', directorySpec, null);
            const dirs = Array.isArray(directoryPath) ? directoryPath : [directoryPath];
            const dirKeys = await directoryTree.putMany(docId, dirs);
            if (dirKeys && dirKeys.length > 0) {
                allSynapseKeys.push(...dirKeys);
            }
        }

        // Feature bitmaps
        if (featureBitmaps && featureBitmaps.length > 0) {
            await this.bitmapIndex.tickMany(featureBitmaps, docId);
            allSynapseKeys.push(...featureBitmaps);
        }

        // Update Synapses reverse index
        if (allSynapseKeys.length > 0) {
            await this.#synapses.createSynapses(docId, allSynapseKeys, { syncBitmaps: false });
        }
    }

    #normalizeFindSpec(spec = {}) {
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
            throw new Error('find() expects a query spec object');
        }

        const {
            tree,
            path,
            context,
            contextSpec,
            directory = null,
            attributes = null,
            features = null,
            filters = null,
            filterArray = [],
            excludeTree,
            excludeTrees,
            excludeContext,
            excludeContextSpec,
            excludeContexts,
            excludeContextSpecs,
            options,
            parse,
            limit,
            offset,
            page,
        } = spec;

        const normalizedFilterArray = Array.isArray(filterArray) ? [...filterArray] : [filterArray].filter(Boolean);
        normalizedFilterArray.push(...this.#normalizeFiltersObject(filters));

        const baseOptions = typeof options === 'object' && options !== null ? { ...options } : {};
        const normalizedExcludeContextSpecs = this.#normalizeExcludeContextSpecs(
            excludeContextSpecs
            ?? excludeContexts
            ?? excludeContextSpec
            ?? excludeContext
            ?? baseOptions.excludeContextSpecs
            ?? baseOptions.excludeContexts
            ?? baseOptions.excludeContextSpec
            ?? baseOptions.excludeContext
        );
        delete baseOptions.excludeContextSpecs;
        delete baseOptions.excludeContexts;
        delete baseOptions.excludeContextSpec;
        delete baseOptions.excludeContext;
        const normalizedExcludeTreeSelectors = this.#normalizeExcludeTreeSelectors(
            excludeTrees
            ?? excludeTree
            ?? baseOptions.excludeTrees
            ?? baseOptions.excludeTree
        );
        delete baseOptions.excludeTrees;
        delete baseOptions.excludeTree;

        const selectorInput = tree !== undefined || path !== undefined
            ? { tree, path }
            : (directory ?? context ?? contextSpec ?? null);

        return {
            treeSelector: selectorInput == null ? null : this.#resolveGenericTreeSelection(selectorInput, '/', 'context'),
            features: this.#normalizeQueryFeatures(features ?? attributes),
            filterArray: normalizedFilterArray,
            excludeContextSpecs: normalizedExcludeContextSpecs,
            excludeTreeSelectors: normalizedExcludeTreeSelectors,
            options: {
                ...baseOptions,
                ...(parse !== undefined ? { parse } : {}),
                ...(limit !== undefined ? { limit } : {}),
                ...(offset !== undefined ? { offset } : {}),
                ...(page !== undefined ? { page } : {}),
            },
        };
    }

    #normalizeFiltersObject(filters) {
        if (!filters) {
            return [];
        }

        if (Array.isArray(filters)) {
            return filters.filter(Boolean);
        }

        if (typeof filters !== 'object') {
            throw new Error('find(): filters must be an array or object');
        }

        const normalizedFilters = [];
        const supportedKeys = new Set(['timeline']);

        for (const key of Object.keys(filters)) {
            if (!supportedKeys.has(key)) {
                throw new Error(`find(): unsupported filter "${key}"`);
            }
        }

        if (filters.timeline) {
            const timelineValues = Array.isArray(filters.timeline) ? filters.timeline : [filters.timeline];
            for (const timelineValue of timelineValues.filter(Boolean)) {
                normalizedFilters.push(`datetime:updated:${timelineValue}`);
            }
        }

        return normalizedFilters;
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

        return await this.#buildSelectorBitmap(this.#normalizeDocumentOperationSpec(selector, [], {}));
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
                const treeBitmap = await this.#buildContextTreeMembershipBitmap(tree);
                if (treeBitmap) {
                    if (resultBitmap) {
                        resultBitmap.orInPlace(treeBitmap);
                    } else {
                        resultBitmap = treeBitmap;
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
            if (layerIds.length === 0) {
                continue;
            }

            const pathBitmap = await collection.AND(layerIds);
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

    async #buildContextTreeMembershipBitmap(tree) {
        const collection = this.#contextBitmapCollectionForTree(tree.id);
        const layerIds = (await tree.layers).filter((layerId) => layerId && layerId !== tree.rootLayer?.id);
        if (layerIds.length === 0) {
            return new RoaringBitmap32();
        }
        return await collection.OR(layerIds);
    }

    async #buildTreeMembershipBitmap(treeSelector) {
        const selection = this.#resolveGenericTreeSelection(treeSelector, '/', 'context');
        if (selection.type === 'directory') {
            const rootBitmap = await selection.tree.find('/');
            const recursiveBitmap = await selection.tree.findRecursive('/');
            if (rootBitmap && recursiveBitmap) {
                rootBitmap.orInPlace(recursiveBitmap);
                return rootBitmap;
            }
            return rootBitmap ?? recursiveBitmap ?? new RoaringBitmap32();
        }
        return await this.#buildContextTreeMembershipBitmap(selection.tree);
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

    #normalizeExcludeContextSpecs(value) {
        const contextSpecs = Array.isArray(value) ? value : [value];
        return contextSpecs
            .filter((contextSpec) => typeof contextSpec === 'string' && contextSpec.trim().length > 0)
            .map((contextSpec) => contextSpec.trim())
            .filter((contextSpec, index, array) => array.indexOf(contextSpec) === index);
    }

    #normalizeExcludeTreeSelectors(value) {
        const selectors = Array.isArray(value) ? value : [value];
        return selectors.filter(Boolean);
    }

    async #buildExcludedContextBitmap(contextSpecs = []) {
        if (!Array.isArray(contextSpecs) || contextSpecs.length === 0) {
            return null;
        }

        const contextTree = this.getDefaultContextTree();
        const contextCollection = contextTree ? this.#contextBitmapCollectionForTree(contextTree.id) : null;
        if (!contextTree || !contextCollection) {
            return null;
        }

        let excludedBitmap = null;
        for (const contextSpec of contextSpecs) {
            if (!contextSpec || contextSpec === '/') {
                continue;
            }

            const layer = contextTree.getLayerForPath(contextSpec);
            if (!layer?.id) {
                continue;
            }

            const layerBitmap = await contextCollection.getBitmap(layer.id, false);
            if (!layerBitmap || layerBitmap.isEmpty) {
                continue;
            }

            if (!excludedBitmap) {
                excludedBitmap = layerBitmap.clone();
            } else {
                excludedBitmap.orInPlace(layerBitmap);
            }
        }

        return excludedBitmap;
    }

    async #applyExcludedContexts(bitmap, contextSpecs = []) {
        const excludedBitmap = await this.#buildExcludedContextBitmap(contextSpecs);
        if (!excludedBitmap || excludedBitmap.isEmpty) {
            return bitmap;
        }

        const nextBitmap = bitmap || await this.#buildAllDocumentsBitmap();
        if (!nextBitmap || nextBitmap.isEmpty) {
            return nextBitmap;
        }

        nextBitmap.andNotInPlace(excludedBitmap);
        return nextBitmap;
    }

    async #applyExcludedTrees(bitmap, treeSelectors = []) {
        if (!Array.isArray(treeSelectors) || treeSelectors.length === 0) {
            return bitmap;
        }

        let excludedBitmap = null;
        for (const treeSelector of treeSelectors) {
            const treeBitmap = await this.#buildTreeMembershipBitmap(treeSelector);
            if (!treeBitmap || treeBitmap.isEmpty) {
                continue;
            }

            if (!excludedBitmap) {
                excludedBitmap = treeBitmap;
            } else {
                excludedBitmap.orInPlace(treeBitmap);
            }
        }

        if (!excludedBitmap || excludedBitmap.isEmpty) {
            return bitmap;
        }

        const nextBitmap = bitmap || await this.#buildAllDocumentsBitmap();
        if (!nextBitmap || nextBitmap.isEmpty) {
            return nextBitmap;
        }

        nextBitmap.andNotInPlace(excludedBitmap);
        return nextBitmap;
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
