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
import { parseContextSpecForInsert, parseContextSpecForQuery, parseBitmapArray } from './utils/parsing.js';
import { parseFilters, applyDatetimeFilter } from './utils/filters.js';
import { parseDocumentData, initializeDocument, parseInitializeDocument, generateDocumentID } from './utils/document.js';
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

            // TODO: Remove after all instances have been reindexed (added 2026-02-17)
            await this.reindexFeatures();

            this.emit('started');
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

        this.emit('tree.created', { treeId: meta.id, treeName: meta.name, treeType: meta.type });
        return meta;
    }

    async destroyTree(nameOrId) {
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
        this.emit('tree.deleted', { treeId: meta.id, treeName: meta.name, treeType: meta.type });
        return true;
    }

    async renameTree(nameOrId, newName) {
        const meta = this.#resolveTreeMeta(nameOrId);
        if (!meta) { throw new Error(`Tree not found: ${nameOrId}`); }
        if (this.getTree(newName)) { throw new Error(`Tree already exists: ${newName}`); }
        meta.name = String(newName).trim();
        meta.updatedAt = new Date().toISOString();
        await this.#internalStore.put(this.#treeMetaKey(meta.id), meta);
        this.emit('tree.renamed', { treeId: meta.id, treeName: meta.name, treeType: meta.type });
        return meta;
    }

    async stop() { return this.shutdown(); }

    async shutdown() {
        debug('Shutting down SynapsD');
        try {
            this.#status = 'shutting down';
            this.emit('beforeShutdown');
            // Close index backends
            // LanceDB uses filesystem-based storage; no explicit close needed.
            // Close database backend
            await this.#db.close();

            this.#status = 'shutdown';
            this.emit('shutdown');

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

    async put(record, memberships = {}) {
        const features = memberships.attributes?.allOf
            ?? memberships.attributes
            ?? memberships.features
            ?? [];

        const spec = {
            context: memberships.context ?? { path: '/' },
            directory: memberships.directory ?? null,
            features,
            emitEvent: memberships.emitEvent,
        };

        if (typeof record === 'number' || (typeof record === 'string' && /^\d+$/.test(record))) {
            const id = typeof record === 'number' ? record : parseInt(record, 10);
            return await this.#updateOne(id, null, spec);
        }

        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw new Error('Record object or numeric document id is required');
        }

        if (record.id !== undefined && record.id !== null) {
            const existing = await this.#getById(record.id);
            if (existing) {
                return await this.#updateOne(record.id, record, spec);
            }
        }

        return await this.#putOne(record, spec);
    }

    async has(id, spec = {}) {
        if (!id) { throw new Error('Document id required'); }
        const features = spec.attributes?.allOf
            ?? spec.attributes
            ?? spec.features
            ?? [];
        return await this.#hasOne(id, spec.context ?? { path: '/' }, features);
    }

    async unlink(id, membershipsOrSpec = {}, options = {}) {
        if (!id) { throw new Error('Document id required'); }
        const features = membershipsOrSpec.attributes?.allOf
            ?? membershipsOrSpec.attributes
            ?? membershipsOrSpec.features
            ?? [];
        return await this.#unlinkOne(
            id,
            membershipsOrSpec.context ?? { path: '/' },
            features,
            options,
        );
    }

    async delete(id, options = {}) {
        if (!id) { throw new Error('Document id required'); }
        return await this.#deleteOne(id, options);
    }

    async putMany(records, memberships = {}) {
        const features = memberships.attributes?.allOf
            ?? memberships.attributes
            ?? memberships.features
            ?? [];
        const contextSpec = memberships.context ?? { path: '/' };
        if (!Array.isArray(records)) {
            throw new Error('Document array must be an array');
        }
        if (!Array.isArray(features)) {
            throw new Error('Feature array must be an array');
        }

        debug(`putMany: Attempting to store ${records.length} records`);
        const storedIds = [];
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            try {
                const id = await this.put(record, {
                    context: contextSpec,
                    attributes: { allOf: features },
                    emitEvent: false,
                });
                storedIds.push(id);
            } catch (error) {
                const contextualError = new Error(`Failed to store record at index ${i}: ${error.message}`);
                contextualError.cause = error;
                contextualError.failedItem = record;
                contextualError.failedIndex = i;
                throw contextualError;
            }
        }

        if (storedIds.length > 0 && this.getDefaultContextTree()) {
            try {
                this.#resolveTreeSelection('context', contextSpec, '/').tree.emit('tree.document.inserted.batch', {
                    documentIds: storedIds,
                    contextSpec,
                    layerNames: [],
                    timestamp: new Date().toISOString(),
                });
            } catch (treeError) {
                debug(`putMany: Failed to emit tree batch event, error: ${treeError.message}`);
            }
        }

        return storedIds;
    }

    async unlinkMany(ids, membershipsOrSpec = {}, options = {}) {
        const features = membershipsOrSpec.attributes?.allOf
            ?? membershipsOrSpec.attributes
            ?? membershipsOrSpec.features
            ?? [];
        const contextSpec = membershipsOrSpec.context ?? { path: '/' };

        if (!Array.isArray(ids)) {
            throw new Error('Document ID array must be an array');
        }
        if (!Array.isArray(features)) {
            throw new Error('Feature array must be an array');
        }
        if (typeof options !== 'object') { options = { recursive: false }; }

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
                const removedId = await this.unlink(id, {
                    context: contextSpec,
                    attributes: { allOf: features },
                }, options);
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

        // Support inserting by existing document ID to add context/feature memberships
        if (typeof document === 'number' || (typeof document === 'string' && /^\d+$/.test(document))) {
            const docId = typeof document === 'number' ? document : parseInt(document, 10);
            return await this.#updateOne(docId, null, contextSpec, featureBitmapArray);
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
            contextTree.emit('tree.document.inserted', {
                documentId: parsedDocument.id,
                contextSpec,
                directorySpec,
                timestamp: new Date().toISOString(),
            });
            this.emit('document.inserted', { id: parsedDocument.id, document: parsedDocument });
        }

        return parsedDocument.id;
    }

    async #hasOne(id, contextSpec = { path: '/' }, featureBitmapArrayInput) {
        if (!id) { throw new Error('Document id required'); }

        if (!await this.documents.has(id)) {
            debug(`hasDocument: Document with ID "${id}" not found in the main 'documents' store.`);
            return false;
        }

        // If the caller did not provide any specific context or feature filters,
        // then existence in the main document store is sufficient.
        const rawContextSpec = contextSpec && typeof contextSpec === 'object' && !Array.isArray(contextSpec)
            ? (contextSpec.path ?? contextSpec.context ?? null)
            : contextSpec;
        const { tree: contextTree, collection: contextCollection } = this.#resolveTreeSelection('context', contextSpec, '/');
        const noContextFilterWanted = rawContextSpec === undefined || rawContextSpec === null || rawContextSpec.length === 0;
        const noFeatureFilterWanted = featureBitmapArrayInput === undefined || featureBitmapArrayInput === null || featureBitmapArrayInput.length === 0;

        if (noContextFilterWanted && noFeatureFilterWanted) {
            debug(`hasDocument: Document ID "${id}" exists in store, and no specific filters were provided by the caller.`);
            return true;
        }

        // At least one filter criterion was provided or will be defaulted if only one part of the filter was given.
        const effectiveContextSpec = noContextFilterWanted ? '/' : rawContextSpec;
        const effectiveFeatureArray = noFeatureFilterWanted ? [] : featureBitmapArrayInput;

        const parsedContextKeys = parseContextSpecForQuery(effectiveContextSpec);
        const hasExplicitRootContext = effectiveContextSpec === '/';
        const hasExplicitContextPath = !hasExplicitRootContext && !noContextFilterWanted;
        if (hasExplicitContextPath && !contextTree.getLayerForPath(effectiveContextSpec)) {
            debug(`hasDocument: Doc ${id} - explicit context path "${effectiveContextSpec}" does not exist.`);
            return false;
        }
        const parsedFeatureKeys = parseBitmapArray(effectiveFeatureArray).filter(Boolean);

        let resultBitmap = null;
        let contextFilterApplied = false;

        // Apply context filter if caller actually wanted one OR if it defaulted to '/' but features are also specified.
        if (!noContextFilterWanted || (noContextFilterWanted && !noFeatureFilterWanted)) {
            // Resolve context layer names to ULIDs (root '/' is skipped, yielding [] for root-only queries)
            const contextLayerIds = contextTree.resolveLayerIds(parsedContextKeys);
            if (contextLayerIds.length === 0) {
                // Root-only context — no bitmap filter to apply
            } else {
                resultBitmap = await contextCollection.AND(contextLayerIds);
                contextFilterApplied = true;
            }
            // If context filter results in null/empty, and it was a specific request, then fail early.
            if (!resultBitmap || resultBitmap.isEmpty) {
                if (!noContextFilterWanted && !hasExplicitRootContext) {
                    debug(`hasDocument: Doc ${id} - explicit context filter ${JSON.stringify(parsedContextKeys)} yielded no results.`);
                    return false;
                }
            }
        }

        if (!noFeatureFilterWanted && parsedFeatureKeys.length > 0) {
            const featureOpBitmap = await this.#buildFeatureBitmap(parsedFeatureKeys);
            if (!featureOpBitmap || featureOpBitmap.isEmpty) {
                debug(`hasDocument: Doc ${id} - explicit feature filter ${JSON.stringify(parsedFeatureKeys)} yielded no results.`);
                return false; // Feature filter must yield results if specified
            }

            if (contextFilterApplied && resultBitmap) {
                resultBitmap.andInPlace(featureOpBitmap);
            } else {
                resultBitmap = featureOpBitmap; // RoaringBitmap32.or(new RoaringBitmap32(), featureOpBitmap) for a new instance if needed
            }
        } else if (contextFilterApplied && (!resultBitmap || resultBitmap.isEmpty) && !noContextFilterWanted) {
            // If context filter was applied (explicitly), was the only filter, and yielded no results.
            debug(`hasDocument: Doc ${id} - explicit context filter (as only filter) ${JSON.stringify(parsedContextKeys)} yielded no results.`);
            return false;
        }

        // If resultBitmap is null here, it means no filters were effectively run that produced a bitmap
        // (e.g. context was default '/' and no features). In this case, existence is enough (already checked).
        // However, if filters *were* run, resultBitmap must exist.
        if (noContextFilterWanted && noFeatureFilterWanted) {
            // This should have been caught by the top check, but as a safeguard:
            return true;
        }

        if (resultBitmap) {
            return resultBitmap.has(id);
        }
        return hasExplicitRootContext ? true : false;
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

    async find(spec = {}) {
        let {
            contextSpec,
            attributes,
            filterArray,
            excludeContextSpecs,
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

        const rawContextSpec = contextSpec && typeof contextSpec === 'object' && !Array.isArray(contextSpec)
            ? (contextSpec.path ?? contextSpec.context ?? null)
            : contextSpec;
        const { tree: contextTree, collection: contextCollection } = this.#resolveTreeSelection('context', contextSpec ?? { path: '/' }, '/');
        const contextBitmapArray = parseContextSpecForQuery(rawContextSpec);
        const hasExplicitContextPath = rawContextSpec !== null && rawContextSpec !== undefined && rawContextSpec !== '/';
        if (!Array.isArray(filterArray) && typeof filterArray === 'string') { filterArray = [filterArray]; }
        debug(`Listing documents with contextArray: ${contextBitmapArray}, attributes: ${JSON.stringify(attributes)}, filters: ${filterArray}, limit: ${limit}, offset: ${offset}`);

        try {
            // Start with null, will hold RoaringBitmap32 instance if filters are applied
            let resultBitmap = null;
            // Flag to track if any filters actually modified the initial empty bitmap
            let filtersApplied = false;

            // Apply context filters only if contextSpec was explicitly provided
            if (hasExplicitContextPath && !contextTree.getLayerForPath(rawContextSpec)) {
                const emptyArray = [];
                emptyArray.count = 0;
                emptyArray.totalCount = 0;
                emptyArray.error = null;
                return emptyArray;
            }

            if (rawContextSpec !== null && rawContextSpec !== undefined && contextBitmapArray.length > 0) {
                const contextLayerIds = contextTree.resolveLayerIds(contextBitmapArray);
                if (contextLayerIds.length > 0) {
                    resultBitmap = await contextCollection.AND(contextLayerIds);
                    filtersApplied = true;
                }
            }

            // Apply bitmap-backed attribute filters if provided
            const attributeBitmap = await this.#buildAttributesBitmap(attributes);
            if (attributeBitmap) {
                if (filtersApplied && resultBitmap) {
                    resultBitmap.andInPlace(attributeBitmap);
                } else {
                    resultBitmap = attributeBitmap;
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
                    debug(`findDocuments: Count discrepancy detected. Database count: ${totalCount}, Actual retrievable documents: ${seen}, Returned: ${pagedDocs.length}`);
                }

                const resultArray = parseDocuments ? this.#safeParseDocuments(pagedDocs) : pagedDocs;
                // Attach metadata for compatibility
                resultArray.count = resultArray.length; // Number of documents actually returned (after filtering corrupted)
                resultArray.totalCount = totalCount;    // Total number of documents available
                resultArray.error = null;
                return resultArray;
            }

            // Case 2: Filters were applied, but the resulting bitmap is null or empty
            if (finalDocumentIds.length === 0) {
                debug('findDocuments: Resulting bitmap is null or empty after applying filters.');
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
            // Attach metadata for compatibility
            resultArray.count = resultArray.length; // Number of documents actually returned (after filtering corrupted)
            resultArray.totalCount = totalCount;  // Total number of documents available
            resultArray.error = null;
            return resultArray;

        } catch (error) {
            debug(`Error in findDocuments: ${error.message}`);
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
            contextSpec,
            attributes,
            filterArray,
            excludeContextSpecs,
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
        const rawContextSpec = contextSpec && typeof contextSpec === 'object' && !Array.isArray(contextSpec)
            ? (contextSpec.path ?? contextSpec.context ?? null)
            : contextSpec;
        const { tree: contextTree, collection: contextCollection } = this.#resolveTreeSelection('context', contextSpec ?? { path: '/' }, '/');
        const contextBitmapArray = parseContextSpecForQuery(rawContextSpec);

        if (rawContextSpec !== null && rawContextSpec !== undefined && rawContextSpec !== '/' && !contextTree.getLayerForPath(rawContextSpec)) {
            const empty = [];
            empty.count = 0;
            empty.totalCount = 0;
            empty.error = null;
            return empty;
        }

        if (contextBitmapArray.length > 0) {
            const contextLayerIds = contextTree.resolveLayerIds(contextBitmapArray);
            if (contextLayerIds.length > 0) {
                candidateBitmap = await contextCollection.AND(contextLayerIds);
                filtersApplied = true;
            }
        }

        const attributeBitmap = await this.#buildAttributesBitmap(attributes);
        if (attributeBitmap) {
            if (filtersApplied && candidateBitmap) {
                candidateBitmap.andInPlace(attributeBitmap);
            } else {
                candidateBitmap = attributeBitmap;
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

        if (filtersApplied && candidateIds.length > 0) {
            const docs = await this.documents.getMany(candidateIds);
            const parsedDocs = this.#safeParseDocuments(docs);
            return await this.#lanceIndex.ftsQuery(queryString, candidateIds, parsedDocs, { limit, offset });
        }

        const docs = [];
        for await (const { value } of this.documents.getRange()) {
            docs.push(value);
        }
        const parsedDocs = this.#safeParseDocuments(docs);
        return await this.#lanceIndex.ftsQuery(queryString, [], parsedDocs, { limit, offset });
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

            this.emit('document.updated', { id: updatedDocument.id, document: updatedDocument });

            // Best-effort Lance upsert
            try {
                await this.#lanceIndex.upsert(parseInitializeDocument(updatedDocument));
            } catch (e) {
                debug(`updateDocument: Lance upsert failed for ${updatedDocument.id}: ${e.message}`);
            }

            return updatedDocument.id;
        } catch (error) {
            debug(`updateDocument: Error during update: ${error.message}`);
            throw error;
        }
    }

    // Removes documents from context and/or feature bitmaps
    async #unlinkOne(docId, contextSpec = { path: '/' }, featureBitmapArray = [], options = { recursive: false }) {
        if (!docId) { throw new Error('Document id required'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }
        if (typeof options !== 'object') { options = { recursive: false }; }

        const { tree: contextTree, collection: contextCollection, path: normalizedContextSpec } = this.#resolveTreeSelection('context', contextSpec, '/');

        // Parse context into array of independent path-layer-arrays
        const pathLayersArray = parseContextSpecForInsert(normalizedContextSpec);

        // Collect all layers to remove from across all paths
        const allLayersToRemove = [];

        for (const pathLayers of pathLayersArray) {
            // Check if we're trying to remove from root context only
            if (pathLayers.length === 1 && pathLayers[0] === '/') {
                throw new Error('Cannot remove document from root context "/". Use deleteDocument to permanently delete documents.');
            }

            // Remove root "/" from the array if it exists alongside other contexts
            // We should never untick documents from the root context via removeDocument
            let filteredLayers = pathLayers.filter(context => context !== '/');

            // After filtering, we need at least one context to operate on
            if (filteredLayers.length === 0) {
                throw new Error('Cannot remove document from root context "/". Use deleteDocument to permanently delete documents.');
            }

            // Handle recursive vs non-recursive removal
            if (!options.recursive) {
                // Non-recursive: remove from leaf context only (last element in the path)
                const leafContext = filteredLayers[filteredLayers.length - 1];
                allLayersToRemove.push(leafContext);
                debug(`removeDocument: Non-recursive removal from leaf context only: ${leafContext}`);
            } else {
                // Recursive: remove from all contexts in the hierarchy (current behavior)
                allLayersToRemove.push(...filteredLayers);
                debug(`removeDocument: Recursive removal from all contexts: ${filteredLayers.join(', ')}`);
            }
        }

        debug(`removeDocument: Removing document ${docId} from contexts: ${allLayersToRemove.join(', ')}`);

        // Remove document will only remove the document from the supplied bitmaps
        // It will not delete the document from the database.
        try {
            const layersToRemove = [];

            if (allLayersToRemove.length > 0) {
                // Resolve layer names to ULIDs for bitmap keying
                const layerIds = contextTree.resolveLayerIds(allLayersToRemove);
                const normalizedContexts = layerIds.map((layerId) => contextCollection.makeKey(layerId));
                layersToRemove.push(...normalizedContexts);
            }
            if (featureBitmapArray.length > 0) {
                layersToRemove.push(...featureBitmapArray);
            }

            if (layersToRemove.length > 0) {
                await this.#synapses.removeSynapses(docId, layersToRemove);
                debug(`removeDocument: Removed doc ${docId} from ${layersToRemove.length} layers via Synapses`);
            }

            // If the operations completed without throwing, return the ID.
            // This signals the removal *attempt* was successful.
            this.emit('document.removed', { id: docId, contextArray: allLayersToRemove, featureArray: featureBitmapArray, recursive: options.recursive });
            return docId;

        } catch (error) {
            // Catch unexpected errors (DB connection, etc.)
            debug(`Error during removeDocument for ID ${docId}: ${error.message}`);
            // Re-throw the error so callers know something went wrong
            throw error;
        }
    }

    // Deletes documents from all bitmaps and the main dataset
    async #deleteOne(docId, options = {}) {
        if (!docId) { throw new Error('Document id required'); }
        const { emitEvent = true } = options;
        debug(`deleteDocument: Document with ID "${docId}" found (or context check passed), proceeding to delete..`);

        let document = null;
        let transactionSuccess = false;

        try {
            // Get document before deletion (outside transaction to check existence)
            const documentData = await this.documents.get(docId);
            if (!documentData) {
                debug(`deleteDocument: Document with ID "${docId}" not found`);
                return false;
            }
            document = parseDocumentData(documentData);
            debug('deleteDocument > Document: ', document);

            // Wrap all critical database operations in a single transaction for atomicity
            await this.#db.transaction(async () => {
                // Delete document from main database
                await this.documents.delete(docId);
                debug(`deleteDocument: Document ${docId} deleted from main store`);

                // Delete document from all bitmaps AND Reverse Index via Synapses
                // await this.bitmapIndex.untickAll(docId);
                await this.#synapses.clearSynapses(docId);
                debug(`deleteDocument: Document ${docId} removed from all bitmaps and Synapses index`);

                // Remove document from timestamp indices (created, updated)
                await this.#timestampIndex.remove(null, docId);
                debug(`deleteDocument: Document ${docId} removed from timestamp indices`);

                // Delete document checksums from inverted index
                await this.#checksumIndex.deleteArray(document.checksumArray);
                debug(`deleteDocument: Checksums for document ${docId} deleted from index`);

                // Add document ID to deleted documents bitmap
                await this.deletedDocumentsBitmap.tick(docId);
                debug(`deleteDocument: Document ${docId} added to deleted documents bitmap`);

                // Update timestamp index
                await this.#timestampIndex.insert('deleted', document.updatedAt || new Date().toISOString(), docId);
                debug(`deleteDocument: Timestamp for document ${docId} updated in index`);
            });

            transactionSuccess = true;
            debug(`deleteDocument: All database operations completed atomically for document ID: ${docId}`);

        } catch (error) {
            debug(`deleteDocument: Transaction failed for document ID: ${docId}, error: ${error.message}`);
            // If transaction failed, ensure we don't attempt Lance cleanup
            transactionSuccess = false;
            throw new Error(`Failed to delete document atomically: ${error.message}`);
        }

        // Best-effort Lance delete (outside transaction since it's a separate system)
        if (transactionSuccess) {
            try {
                await this.#lanceIndex.delete(docId);
                debug(`deleteDocument: LanceDB cleanup completed for document ${docId}`);
            } catch (e) {
                debug(`deleteDocument: Lance delete failed for ${docId}: ${e.message}`);
                // Don't fail the entire operation if Lance cleanup fails
            }

            if (emitEvent) {
                this.emit('document.deleted', { id: docId });
            }
            debug(`deleteDocument: Successfully deleted document ID: ${docId}`);
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

    async hasByChecksumString(checksumString, spec = {}) {
        if (!checksumString) { throw new Error('Checksum string required'); }
        const id = await this.#checksumIndex.checksumStringToId(checksumString);
        if (!id) { return false; }
        return await this.has(id, spec);
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
            attributes: { allOf: parseBitmapArray(featureBitmapArray).filter(Boolean) },
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
        if (tree.__synapsdTreeEventsBound) {
            return;
        }
        tree.__synapsdTreeEventsBound = true;
        const db = this;
        tree.on('**', function (payload = {}) {
            const eventName = this.event;
            if (!eventName) { return; }
            const nextPayload = payload && typeof payload === 'object'
                ? { ...payload }
                : { value: payload };
            nextPayload.treeId = meta.id;
            nextPayload.treeName = meta.name;
            nextPayload.treeType = meta.type;
            if (!nextPayload.source) {
                nextPayload.source = 'tree';
            }
            db.emit(eventName, nextPayload);
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
            ['context', 'directory', 'features', 'emitEvent'].some((key) => Object.prototype.hasOwnProperty.call(value, key))
        );
    }

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
            context,
            contextSpec,
            directory = null,
            attributes = null,
            filters = null,
            filterArray = [],
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

        if (directory !== null && directory !== undefined) {
            throw new Error('find(): directory queries are not implemented yet');
        }

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

        return {
            contextSpec: context ?? contextSpec ?? null,
            attributes: this.#normalizeAttributes(attributes),
            filterArray: normalizedFilterArray,
            excludeContextSpecs: normalizedExcludeContextSpecs,
            options: {
                ...baseOptions,
                ...(parse !== undefined ? { parse } : {}),
                ...(limit !== undefined ? { limit } : {}),
                ...(offset !== undefined ? { offset } : {}),
                ...(page !== undefined ? { page } : {}),
            },
        };
    }

    #normalizeAttributes(attributes) {
        if (!attributes) {
            return null;
        }

        if (Array.isArray(attributes)) {
            return {
                allOf: attributes.filter(Boolean),
                anyOf: [],
                noneOf: [],
            };
        }

        if (typeof attributes !== 'object') {
            throw new Error('find(): attributes must be an array or object');
        }

        return {
            allOf: parseBitmapArray(attributes.allOf ?? []).filter(Boolean),
            anyOf: parseBitmapArray(attributes.anyOf ?? []).filter(Boolean),
            noneOf: parseBitmapArray(attributes.noneOf ?? []).filter(Boolean),
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

    async #buildAttributesBitmap(attributes) {
        const normalizedAttributes = this.#normalizeAttributes(attributes);
        if (!normalizedAttributes) {
            return null;
        }

        const { allOf, anyOf, noneOf } = normalizedAttributes;
        if (allOf.length === 0 && anyOf.length === 0 && noneOf.length === 0) {
            return null;
        }

        let attributeBitmap = null;

        if (allOf.length > 0) {
            attributeBitmap = await this.bitmapIndex.AND(allOf);
        }

        if (anyOf.length > 0) {
            const anyBitmap = await this.bitmapIndex.OR(anyOf);
            if (attributeBitmap) {
                attributeBitmap.andInPlace(anyBitmap);
            } else {
                attributeBitmap = anyBitmap;
            }
        }

        if (noneOf.length > 0) {
            if (!attributeBitmap) {
                attributeBitmap = await this.#buildAllDocumentsBitmap();
            }
            const noneBitmap = await this.bitmapIndex.OR(noneOf);
            if (noneBitmap && !noneBitmap.isEmpty) {
                attributeBitmap.andNotInPlace(noneBitmap);
            }
        }

        return attributeBitmap || new RoaringBitmap32();
    }

    async #buildFeatureBitmap(featureBitmapArray) {
        const featureKeys = parseBitmapArray(featureBitmapArray).filter(Boolean);
        if (featureKeys.length === 0) {
            return null;
        }

        const positiveKeys = featureKeys.filter(key => !key.startsWith('!'));
        const negativeKeys = featureKeys.filter(key => key.startsWith('!')).map(key => key.slice(1));

        let featureBitmap = null;
        if (positiveKeys.length > 0) {
            featureBitmap = await this.bitmapIndex.AND(positiveKeys);
        } else {
            featureBitmap = await this.#buildAllDocumentsBitmap();
        }

        if (negativeKeys.length > 0 && featureBitmap && !featureBitmap.isEmpty) {
            const negativeBitmap = await this.bitmapIndex.OR(negativeKeys);
            if (negativeBitmap && !negativeBitmap.isEmpty) {
                featureBitmap.andNotInPlace(negativeBitmap);
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

    #normalizeExcludeContextSpecs(value) {
        const contextSpecs = Array.isArray(value) ? value : [value];
        return contextSpecs
            .filter((contextSpec) => typeof contextSpec === 'string' && contextSpec.trim().length > 0)
            .map((contextSpec) => contextSpec.trim())
            .filter((contextSpec, index, array) => array.indexOf(contextSpec) === index);
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

    /**
     * Rebuild feature bitmaps from document data. Scans all documents and ensures
     * each document's schema is indexed in the feature bitmap collection.
     */
    async reindexFeatures() {
        if (!this.isRunning()) { throw new Error('Database is not running'); }
        let indexed = 0;
        for await (const { key, value } of this.documents.getRange()) {
            try {
                const doc = parseInitializeDocument(value);
                if (doc.schema) {
                    await this.bitmapIndex.tick(doc.schema, key);
                    indexed++;
                }
            } catch (e) {
                debug(`reindexFeatures: Skipping doc ${key}: ${e.message}`);
            }
        }
        debug(`reindexFeatures: Indexed ${indexed} documents`);
        return indexed;
    }

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




