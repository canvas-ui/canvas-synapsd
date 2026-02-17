'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import fs from 'fs';
import path from 'path';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd');

// Errors
import { ArgumentError } from './utils/errors.js';

// DB Backends
import BackendFactory from './backends/index.js';

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
import ContextTree from './views/tree/index.js';
import DirectoryTree from './views/tree/DirectoryTree.js';

// Extracted utilities
import { parseContextSpecForInsert, parseContextSpecForQuery, parseBitmapArray } from './utils/parsing.js';
import { parseFilters, applyDatetimeFilter } from './utils/filters.js';
import { parseDocumentData, initializeDocument, parseInitializeDocument, generateDocumentID } from './utils/document.js';

// Constants
const INTERNAL_BITMAP_ID_MAX = 100000;

/**
 * Simplified SynapsD class
 */

class SynapsD extends EventEmitter {

    // Database Backend
    #dbBackend = 'lmdb';  // Default backend type
    #rootPath;  // Root path of the database
    #db;        // Database backend instance

    // Internal KV store
    #internalStore;

    // Runtime
    #status;

    // Tree Abstractions
    #tree;
    #directoryTree;

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
        backend: 'lmdb',  // Default backend type
        // TODO: Add per dataset versioning support to the underlying db backend!
    }) {
        super(options.eventEmitterOptions);
        debug('Initializing SynapsD');
        debug('DB Options:', options);

        // Runtime
        this.#status = 'initializing';

        // Initialize database backend
        this.#rootPath = options.rootPath ?? options.path;
        if (!this.#rootPath) { throw new Error('Database path required'); }

        // Set backend type
        this.#dbBackend = options.backend || 'lmdb';

        // Validate backend type
        if (!BackendFactory.isValidBackendType(this.#dbBackend)) {
            throw new Error(`Invalid backend type: ${this.#dbBackend}. Available backends: ${BackendFactory.getAvailableBackends().join(', ')}`);
        }

        debug('Database path:', this.#rootPath);
        debug('Backend type:', this.#dbBackend);

        // Create backend instance using factory
        this.#db = BackendFactory.createBackend(this.#dbBackend, {
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

        // Bitmap Collections
        this.contextBitmapCollection = this.bitmapIndex.createCollection('context');
        this.featureBitmapCollection = this.bitmapIndex.createCollection('feature');

        /**
         * Inverted indexes
         */

        this.#checksumIndex = new ChecksumIndex(this.#db.createDataset('checksums'));
        this.#timestampIndex = null;

        /**
         * Tree Abstractions
         */

        // Context Tree (AND semantics - shared layers)
        this.#tree = new ContextTree({
            dataStore: this.#internalStore,
            db: this,
        });

        // Directory Tree (VFS semantics - unique path bitmaps)
        this.#directoryTree = new DirectoryTree(this.bitmapIndex);

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
    get tree() { return this.#tree; }
    get contextTree() { return this.#tree; } // Alias
    get directoryTree() { return this.#directoryTree; }
    get jsonTree() { return this.#tree.buildJsonTree(); }

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

            // Initialize context tree
            await this.#tree.initialize();

            // Migrate bitmap keys from legacy format (one-time, idempotent)
            await this.#migrateBitmapKeys();

            // Set status
            this.#status = 'running';

            this.emit('started');
            debug('SynapsD started');
        } catch (error) {
            this.#status = 'error';
            debug('SynapsD database error during startup: ', error);
            throw error;
        }
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

    async insertDocument(document, contextSpec = '/', featureBitmapArray = [], emitEvent = true) {
        if (!document) { throw new Error('Document is required'); }

        // Support options object: insertDocument(doc, { context, directory, features })
        let directorySpec = null;
        if (typeof contextSpec === 'object' && contextSpec !== null && !Array.isArray(contextSpec)) {
            const opts = contextSpec;
            contextSpec = opts.context ?? '/';
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
            emitEvent = opts.emitEvent ?? emitEvent;
        }

        // Support inserting by existing document ID to add context/feature memberships
        if (typeof document === 'number' || (typeof document === 'string' && /^\d+$/.test(document))) {
            const docId = typeof document === 'number' ? document : parseInt(document, 10);
            return await this.updateDocument(docId, null, contextSpec, featureBitmapArray);
        }

        const featureBitmaps = parseBitmapArray(featureBitmapArray);
        const parsedDocument = isDocumentInstance(document) ? document : parseInitializeDocument(document);
        parsedDocument.validateData();

        // Dedup by checksum
        const primaryChecksum = parsedDocument.getPrimaryChecksum();
        const storedDocument = await this.getDocumentByChecksumString(primaryChecksum);

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
            this.tree.emit('tree.document.inserted', {
                documentId: parsedDocument.id,
                contextSpec,
                directorySpec,
                timestamp: new Date().toISOString(),
            });
            this.emit('document.inserted', { id: parsedDocument.id, document: parsedDocument });
        }

        return parsedDocument.id;
    }

    async insertDocumentArray(docArray, contextSpec = '/', featureBitmapArray = []) {
        if (!Array.isArray(docArray)) {
            throw new Error('Document array must be an array');
        }
        if (!Array.isArray(featureBitmapArray)) {
            throw new Error('Feature array must be an array');
        }
        debug(`insertDocumentArray: Attempting to insert ${docArray.length} documents with contextSpec: ${contextSpec} and featureBitmapArray: ${featureBitmapArray}`);

        const insertedIds = [];
        // TODO: Implement actual batch/transactional operation in the backend if possible
        for (let i = 0; i < docArray.length; i++) {
            const doc = docArray[i];
            try {
                // Pass emitEvent = false to prevent multiple events
                const id = await this.insertDocument(doc, contextSpec, featureBitmapArray, false);
                insertedIds.push(id);
                debug(`insertDocumentArray: Successfully inserted document at index ${i}, ID: ${id}`);
            } catch (error) {
                debug(`insertDocumentArray: Error inserting document at index ${i} (ID: ${doc.id ?? 'N/A'}). Aborting batch. Error: ${error.message}`);
                // Re-throw the error to stop the batch operation immediately
                // Add context about the failed item - create a new error instead of modifying the existing one
                const contextualError = new Error(`Failed to insert document at index ${i}: ${error.message}`);
                contextualError.cause = error; // Preserve original error
                contextualError.failedItem = doc;
                contextualError.failedIndex = i;
                throw contextualError;
            }
        }

        // If loop completes, all documents were inserted successfully
        debug(`insertDocumentArray: Successfully inserted all ${insertedIds.length} documents.`);

        // Emit tree event for batch insertion with contextSpec for workspace mode auto-opening support
        if (insertedIds.length > 0 && this.tree) {
            try {
                debug(`insertDocumentArray: Emitting tree batch event for ${insertedIds.length} documents at contextSpec: ${contextSpec}`);

                this.tree.emit('tree.document.inserted.batch', {
                    documentIds: insertedIds,
                    contextSpec: contextSpec,
                    layerNames: [], // Simple implementation for now - layerNames is not critical for tab auto-opening
                    timestamp: new Date().toISOString(),
                });

                debug(`insertDocumentArray: Tree batch event emitted for ${insertedIds.length} documents`);
            } catch (treeError) {
                debug(`insertDocumentArray: Failed to emit tree batch event, error: ${treeError.message}`);
                // Don't fail the insert if tree event emission fails
            }
        }

        // Emit a single event for the batch success if needed (optional)
        // this.emit('document:inserted:batch', { ids: insertedIds, count: insertedIds.length });
        return insertedIds; // Return array of IDs on full success
    }

    async hasDocument(id, contextSpec = '/', featureBitmapArrayInput) {
        if (!id) { throw new Error('Document id required'); }

        if (!await this.documents.has(id)) {
            debug(`hasDocument: Document with ID "${id}" not found in the main 'documents' store.`);
            return false;
        }

        // If the caller did not provide any specific context or feature filters,
        // then existence in the main document store is sufficient.
        const noContextFilterWanted = contextSpec === undefined || contextSpec === null || contextSpec.length === 0;
        const noFeatureFilterWanted = featureBitmapArrayInput === undefined || featureBitmapArrayInput === null || featureBitmapArrayInput.length === 0;

        if (noContextFilterWanted && noFeatureFilterWanted) {
            debug(`hasDocument: Document ID "${id}" exists in store, and no specific filters were provided by the caller.`);
            return true;
        }

        // At least one filter criterion was provided or will be defaulted if only one part of the filter was given.
        const effectiveContextSpec = noContextFilterWanted ? '/' : contextSpec;
        const effectiveFeatureArray = noFeatureFilterWanted ? [] : featureBitmapArrayInput;

        const parsedContextKeys = parseContextSpecForQuery(effectiveContextSpec);
        const parsedFeatureKeys = parseBitmapArray(effectiveFeatureArray);

        let resultBitmap = null;
        let contextFilterApplied = false;

        // Apply context filter if caller actually wanted one OR if it defaulted to '/' but features are also specified.
        if (!noContextFilterWanted || (noContextFilterWanted && !noFeatureFilterWanted)) {
            // Resolve context layer names to ULIDs (root '/' is skipped, yielding [] for root-only queries)
            const contextLayerIds = this.tree.resolveLayerIds(parsedContextKeys);
            if (contextLayerIds.length === 0) {
                // Root-only context — no bitmap filter to apply
            } else {
                resultBitmap = await this.contextBitmapCollection.AND(contextLayerIds);
                contextFilterApplied = true;
            }
            // If context filter results in null/empty, and it was a specific request, then fail early.
            if (!resultBitmap || resultBitmap.isEmpty) {
                if (!noContextFilterWanted) { // only fail early if context was explicitly requested and yielded no results
                    debug(`hasDocument: Doc ${id} - explicit context filter ${JSON.stringify(parsedContextKeys)} yielded no results.`);
                    return false;
                }
            }
        }

        if (!noFeatureFilterWanted && parsedFeatureKeys.length > 0) {
            const featureOpBitmap = await this.featureBitmapCollection.OR(parsedFeatureKeys);
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

        return resultBitmap ? resultBitmap.has(id) : false;
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

    async hasDocumentByChecksum(checksum, contextSpec = '/', featureBitmapArray) {
        if (!checksum) { throw new Error('Checksum required'); }

        const id = await this.#checksumIndex.checksumStringToId(checksum);
        if (!id) { return false; }

        return await this.hasDocument(id, contextSpec, featureBitmapArray);
    }

    // Legacy API, now alias for findDocuments,
    // TODO: Implement for metedata retrieval only
    async listDocuments(contextSpec = null, featureBitmapArray = [], filterArray = [], options = { parse: true }) {
        return await this.findDocuments(contextSpec, featureBitmapArray, filterArray, options);
    }

    async findDocuments(contextSpec = null, featureBitmapArray = [], filterArray = [], options = { parse: true }) {
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

        // Parse contextSpec for query (single path only, or null/undefined)
        const contextBitmapArray = parseContextSpecForQuery(contextSpec);
        if (!Array.isArray(featureBitmapArray) && typeof featureBitmapArray === 'string') { featureBitmapArray = [featureBitmapArray]; }
        if (!Array.isArray(filterArray) && typeof filterArray === 'string') { filterArray = [filterArray]; }
        debug(`Listing documents with contextArray: ${contextBitmapArray}, features: ${featureBitmapArray}, filters: ${filterArray}, limit: ${limit}, offset: ${offset}`);

        try {
            // Start with null, will hold RoaringBitmap32 instance if filters are applied
            let resultBitmap = null;
            // Flag to track if any filters actually modified the initial empty bitmap
            let filtersApplied = false;

            // Apply context filters only if contextSpec was explicitly provided
            if (contextSpec !== null && contextSpec !== undefined && contextBitmapArray.length > 0) {
                const contextLayerIds = this.tree.resolveLayerIds(contextBitmapArray);
                if (contextLayerIds.length > 0) {
                    resultBitmap = await this.contextBitmapCollection.AND(contextLayerIds);
                    filtersApplied = true;
                }
            }

            // Apply feature filters if provided (via collection for namespace safety)
            if (featureBitmapArray.length > 0) {
                const featureBitmap = await this.featureBitmapCollection.OR(featureBitmapArray);
                if (filtersApplied) {
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

    async updateDocument(docIdentifier, updateData = null, contextSpec = null, featureBitmapArray = []) {
        if (!docIdentifier) { throw new Error('Document identifier required'); }
        if (typeof docIdentifier !== 'number') { throw new Error('Document identifier must be a numeric ID'); }
        if (!Array.isArray(featureBitmapArray)) { featureBitmapArray = [featureBitmapArray].filter(Boolean); }

        // Support options object
        let directorySpec = null;
        if (typeof contextSpec === 'object' && contextSpec !== null && !Array.isArray(contextSpec)) {
            const opts = contextSpec;
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
        }

        const docId = docIdentifier;
        const featureBitmaps = parseBitmapArray(featureBitmapArray);

        const storedDocument = await this.getDocumentById(docId);
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

    async updateDocumentArray(docArray, contextSpec = null, featureBitmapArray = []) {
        if (!Array.isArray(docArray)) {
            throw new Error('Document array must be an array');
        }
        if (!Array.isArray(featureBitmapArray)) {
            throw new Error('Feature array must be an array');
        }
        debug(`updateDocumentArray: Attempting to update ${docArray.length} documents`);

        const updatedIds = [];
        // TODO: Implement actual batch/transactional operation
        for (let i = 0; i < docArray.length; i++) {
            const docUpdate = docArray[i]; // Assuming docArray contains { id, updateData } or just the full document to update
            if (!docUpdate || typeof docUpdate.id !== 'number') {
                // Add context about the failed item
                const error = new Error(`Invalid document data at index ${i}: Missing or invalid ID.`);
                error.failedItem = docUpdate;
                error.failedIndex = i;
                throw error;
            }
            try {
                // Assuming updateDocument returns the ID and handles its own event emission logic for individual updates
                // For batch, we might want to suppress individual events and emit one batch event
                const id = await this.updateDocument(docUpdate.id, docUpdate.data, contextSpec, featureBitmapArray);
                updatedIds.push(id);
                debug(`updateDocumentArray: Successfully updated document at index ${i}, ID: ${id}`);
            } catch (error) {
                debug(`updateDocumentArray: Error updating document at index ${i} (ID: ${docUpdate.id}). Aborting batch. Error: ${error.message}`);
                // Add context about the failed item
                error.message = `Failed to update document at index ${i} (ID: ${docUpdate.id}): ${error.message}`;
                error.failedItem = docUpdate;
                error.failedIndex = i;
                throw error;
            }
        }

        debug(`updateDocumentArray: Successfully updated all ${updatedIds.length} documents.`);
        // Emit a single event for the batch success if needed (optional)
        // this.emit('document:updated:batch', { ids: updatedIds, count: updatedIds.length });
        return updatedIds; // Return array of IDs on full success
    }

    // Removes documents from context and/or feature bitmaps
    async removeDocument(docId, contextSpec = '/', featureBitmapArray = [], options = { recursive: false }) {
        if (!docId) { throw new Error('Document id required'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }
        if (typeof options !== 'object') { options = { recursive: false }; }

        // Parse context into array of independent path-layer-arrays
        const pathLayersArray = parseContextSpecForInsert(contextSpec);

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
                const layerIds = this.tree.resolveLayerIds(allLayersToRemove);
                const normalizedContexts = layerIds.map(l => this.contextBitmapCollection.makeKey(l));
                layersToRemove.push(...normalizedContexts);
            }
            if (featureBitmapArray.length > 0) {
                const normalizedFeatures = featureBitmapArray.map(f => this.featureBitmapCollection.makeKey(f));
                layersToRemove.push(...normalizedFeatures);
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

    async removeDocumentArray(docIdArray, contextSpec = '/', featureBitmapArray = [], options = { recursive: false }) {
        if (!Array.isArray(docIdArray)) {
            throw new Error('Document ID array must be an array');
        }
        if (!Array.isArray(featureBitmapArray)) {
            throw new Error('Feature array must be an array');
        }
        if (typeof options !== 'object') { options = { recursive: false }; }
        debug(`removeDocumentArray: Attempting to remove ${docIdArray.length} documents from context/features (recursive: ${options.recursive})`);

        const result = {
            successful: [], // Array of { index: number, id: number }
            failed: [],    // Array of { index: number, id: number, error: string }
            count: docIdArray.length,
        };

        // TODO: Implement actual batch/transactional operation
        for (let i = 0; i < docIdArray.length; i++) {
            const id = docIdArray[i];
            if (typeof id !== 'number') {
                result.failed.push({
                    index: i,
                    id: id,
                    error: 'Invalid document ID: Must be a number.',
                });
                continue;
            }
            try {
                // removeDocument returns the ID on success, throws on failure
                const removedId = await this.removeDocument(id, contextSpec, featureBitmapArray, options);
                result.successful.push({ index: i, id: removedId });
                debug(`removeDocumentArray: Successfully removed document ID ${id} (index ${i}) from context/features.`);
            } catch (error) {
                // Errors during removeDocument (e.g., DB error) are collected
                debug(`removeDocumentArray: Error removing document at index ${i} (ID: ${id}). Error: ${error.message}`);
                result.failed.push({
                    index: i,
                    id: id,
                    error: error.message || 'Unknown error',
                });
            }
        }

        debug(`removeDocumentArray: Processed ${result.count} requests. Successful: ${result.successful.length}, Failed: ${result.failed.length}`);
        // Emit event based on outcome (optional)
        return result; // Return the detailed result object
    }

    // Deletes documents from all bitmaps and the main dataset
    async deleteDocument(docId) {
        if (!docId) { throw new Error('Document id required'); }
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

            // Emit success event
            this.emit('document.deleted', { id: docId });
            debug(`deleteDocument: Successfully deleted document ID: ${docId}`);
            return true;
        }

        return false;
    }

    async deleteDocumentArray(docIdArray) {
        if (!Array.isArray(docIdArray)) {
            throw new Error('Document ID array must be an array');
        }
        debug(`deleteDocumentArray: Attempting to delete ${docIdArray.length} documents`);

        const result = {
            successful: [], // Array of { index: number, id: number }
            failed: [],    // Array of { index: number, id: number, error: string }
            count: docIdArray.length,
        };

        // TODO: Implement actual batch/transactional operation
        for (let i = 0; i < docIdArray.length; i++) {
            const id = docIdArray[i];
            if (typeof id !== 'number') {
                result.failed.push({
                    index: i,
                    id: id,
                    error: 'Invalid document ID: Must be a number.',
                });
                continue; // Skip to the next ID
            }

            try {
                // deleteDocument returns true on success, false if not found (or not in context if spec was passed to it, but here we check context first)
                // Pass null for contextSpec to deleteDocument as we've already done the check for the array method.
                const success = await this.deleteDocument(id); // Context check already done for the array method
                if (success) {
                    result.successful.push({ index: i, id: id });
                    debug(`deleteDocumentArray: Successfully deleted document ID ${id} (index ${i}).`);
                } else {
                    // Document not found is considered a failure in this context for reporting,
                    // but doesn't stop the batch.
                    result.failed.push({
                        index: i,
                        id: id,
                        error: 'Document not found or already deleted',
                    });
                    debug(`deleteDocumentArray: Document not found or already deleted (ID: ${id}, index ${i}).`);
                }
            } catch (error) {
                debug(`deleteDocumentArray: Error deleting document at index ${i} (ID: ${id}). Error: ${error.message}`);
                result.failed.push({
                    index: i,
                    id: id,
                    error: error.message || 'Unknown error',
                });
            }
        }

        debug(`deleteDocumentArray: Processed ${result.count} requests. Successful: ${result.successful.length}, Failed: ${result.failed.length}`);
        // Emit event based on outcome (optional)
        // if (result.failed.length === 0) ... else ...
        return result; // Return the detailed result object
    }

    /**
     * Convenience methods
     */

    async getDocument(docId, contextSpec = '/', options = { parse: true }) {
        if (!docId) { throw new Error('Document id required'); }
        if (options.parse) {
            return await this.getDocumentById(docId);
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
    async getDocumentById(id, options = { parse: true }) {
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
    async getDocumentByChecksumString(checksumString, options = { parse: true }) {
        if (!checksumString) { throw new Error('Checksum string required'); }
        debug(`getDocumentByChecksumString: Searching for document with checksum ${checksumString}`);

        // Get document ID from checksum index
        const id = await this.#checksumIndex.checksumStringToId(checksumString);
        if (!id) { return null; }

        // Return the document instance, passing the contextSpec through
        return await this.getDocumentById(id, options);
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
                await this.featureBitmapCollection.tickMany(featureBitmapArray, id);
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
                await this.featureBitmapCollection.untickMany(featureBitmapArray, id);
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

    async query(queryString, contextSpec = null, featureBitmapArray = [], filterArray = [], options = { parse: true }) {
        if (typeof queryString !== 'string') {
            throw new ArgumentError('Query must be a string', 'query');
        }

        return await this.ftsQuery(queryString, contextSpec, featureBitmapArray, filterArray, options);
    }

    async ftsQuery(queryString, contextSpec = null, featureBitmapArray = [], filterArray = [], options = { parse: true, limit: 50, offset: 0 }) {
        if (!this.#lanceIndex || !this.#lanceIndex.isReady) {
            const empty = [];
            empty.count = 0;
            empty.totalCount = 0;
            empty.error = 'FTS not initialized';
            return empty;
        }

        // Normalize options
        const effectiveOptions = typeof options === 'object' && options !== null ? { ...options } : { parse: true };
        const parseDocuments = effectiveOptions.parse !== false;
        const limit = Number.isFinite(effectiveOptions.limit) ? Math.max(0, Number(effectiveOptions.limit)) : 50;
        const offset = Math.max(0, Number.isFinite(effectiveOptions.offset) ? Number(effectiveOptions.offset) : 0);

        // Build candidate set via bitmaps (context AND, features OR, filters AND)
        let candidateBitmap = null;
        let filtersApplied = false;
        const contextBitmapArray = parseContextSpecForQuery(contextSpec);

        if (contextBitmapArray.length > 0) {
            const contextLayerIds = this.tree.resolveLayerIds(contextBitmapArray);
            if (contextLayerIds.length > 0) {
                candidateBitmap = await this.contextBitmapCollection.AND(contextLayerIds);
                filtersApplied = true;
            }
        }
        if (Array.isArray(featureBitmapArray) && featureBitmapArray.length > 0) {
            const featureBitmap = await this.featureBitmapCollection.OR(featureBitmapArray);
            if (filtersApplied && candidateBitmap) { candidateBitmap.andInPlace(featureBitmap); } else { candidateBitmap = featureBitmap; filtersApplied = true; }
        }

        // Parse and apply filters (including datetime)
        if (Array.isArray(filterArray) && filterArray.length > 0) {
            const { bitmapFilters, datetimeFilters } = parseFilters(filterArray);

            // Apply bitmap filters
            if (bitmapFilters.length > 0) {
                const extraFilter = await this.bitmapIndex.AND(bitmapFilters);
                if (filtersApplied && candidateBitmap) { candidateBitmap.andInPlace(extraFilter); } else { candidateBitmap = extraFilter; filtersApplied = true; }
            }

            // Apply datetime filters
            for (const datetimeFilter of datetimeFilters) {
                const datetimeBitmap = await applyDatetimeFilter(datetimeFilter, this.#timestampIndex);
                if (datetimeBitmap) {
                    if (filtersApplied && candidateBitmap) {
                        candidateBitmap.andInPlace(datetimeBitmap);
                    } else {
                        candidateBitmap = datetimeBitmap;
                        filtersApplied = true;
                    }
                }
            }
        }

        const candidateIds = candidateBitmap ? candidateBitmap.toArray() : [];
        if (filtersApplied && candidateIds.length === 0) {
            const empty = [];
            empty.count = 0;
            empty.totalCount = 0;
            empty.error = null;
            return empty;
        }
        // Use local FTS scoring over candidate IDs for deterministic results
        if (filtersApplied && candidateIds.length > 0) {
            const docs = await this.documents.getMany(candidateIds);
            const parsedDocs = parseDocuments ? this.#safeParseDocuments(docs) : docs;
            return await this.#lanceIndex.ftsQuery(queryString, candidateIds, parsedDocs, { limit, offset });
        }

        // No filters: avoid scanning entire DB locally. Return empty for now.
        const emptyNoFilter = [];
        emptyNoFilter.count = 0;
        emptyNoFilter.totalCount = 0;
        emptyNoFilter.error = null;
        return emptyNoFilter;
    }

    /**
     * Utils
     */

    async dumpDocuments(dstDir, contextSpec = '/', featureBitmapArray = [], filterArray = []) {
        if (!dstDir) { throw new Error('Destination directory required'); }
        if (typeof dstDir !== 'string') { throw new Error('Destination directory must be a string'); }
        debug('Dumping DB documents to directory: ', dstDir);
        debug('Context spec: ', contextSpec);
        debug('Feature bitmaps: ', featureBitmapArray);

        // Ensure the destination directory exists
        if (!fs.existsSync(dstDir)) { fs.mkdirSync(dstDir, { recursive: true }); }

        // Get all documents from the documents dataset
        const documentArray = await this.findDocuments(contextSpec, featureBitmapArray, filterArray);
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

    /**
     * One-time idempotent migration: rename legacy bitmap keys to new format.
     *
     * Context bitmaps: context/<name>  →  context/layer/<ulid>
     *   Old code keyed context bitmaps by layer name; new code keys by layer ULID.
     *
     * Feature bitmaps: <prefix>/...  →  feature/<prefix>/...
     *   Old code stored features directly in bitmapIndex (e.g. data/abstraction/note);
     *   new code stores via featureBitmapCollection which prepends 'feature/'.
     */
    async #migrateBitmapKeys() {
        let migrated = 0;

        // --- Context bitmaps: name → ULID ---
        const layerKeys = await this.tree.layers;
        for (const layerKey of layerKeys) {
            const layer = this.tree.getLayerById(layerKey);
            if (!layer || layer.name === '/') continue;

            const oldKey = this.contextBitmapCollection.makeKey(layer.name);
            const newKey = this.contextBitmapCollection.makeKey(layer.id);
            if (oldKey === newKey) continue;

            if (this.bitmapIndex.hasBitmap(oldKey) && !this.bitmapIndex.hasBitmap(newKey)) {
                await this.bitmapIndex.renameBitmap(oldKey, newKey);
                migrated++;
            }
        }

        // --- Feature bitmaps: raw prefix → feature/ prefix ---
        // Old features lived at e.g. data/..., client/..., tag/...
        // New features live at feature/data/..., feature/client/..., feature/tag/...
        const featurePrefixes = ['data/', 'client/', 'tag/', 'custom/', 'nested/'];
        for (const prefix of featurePrefixes) {
            const keys = await this.bitmapIndex.listBitmaps(prefix);
            for (const oldKey of keys) {
                const newKey = `feature/${oldKey}`;
                if (!this.bitmapIndex.hasBitmap(newKey)) {
                    await this.bitmapIndex.renameBitmap(oldKey, newKey);
                    migrated++;
                }
            }
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
            const pathLayersArray = parseContextSpecForInsert(contextSpec);
            for (const pathLayers of pathLayersArray) {
                const pathString = pathLayers.join('/');
                await this.tree.insertPath(pathString);

                const layerIds = this.tree.resolveLayerIds(pathLayers);
                await this.contextBitmapCollection.tickMany(layerIds, docId);

                const normalizedLayers = layerIds.map(l => this.contextBitmapCollection.makeKey(l));
                allSynapseKeys.push(...normalizedLayers);
            }
        }

        // Directory tree: index document at directory path(s)
        if (directorySpec) {
            const dirs = Array.isArray(directorySpec) ? directorySpec : [directorySpec];
            const dirKeys = await this.#directoryTree.insertDocumentMany(docId, dirs);
            if (dirKeys && dirKeys.length > 0) {
                allSynapseKeys.push(...dirKeys);
            }
        }

        // Feature bitmaps (via collection for namespace safety)
        if (featureBitmaps && featureBitmaps.length > 0) {
            await this.featureBitmapCollection.tickMany(featureBitmaps, docId);
            const normalizedFeatures = featureBitmaps.map(f => this.featureBitmapCollection.makeKey(f));
            allSynapseKeys.push(...normalizedFeatures);
        }

        // Update Synapses reverse index
        if (allSynapseKeys.length > 0) {
            await this.#synapses.createSynapses(docId, allSynapseKeys);
        }
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




