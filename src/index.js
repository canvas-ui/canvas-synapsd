'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import fs from 'fs';
import path from 'path';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd');

// Errors
import { ValidationError, NotFoundError, DuplicateError, DatabaseError, ArgumentError } from './utils/errors.js';

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
//import FtsIndex from './indexes/fts/index.js';
//import VectorIndex from './indexes/vector/index.js';
import * as lancedb from '@lancedb/lancedb';

// Views / Abstractions
import ContextTree from './views/tree/index.js';

// Constants
const INTERNAL_BITMAP_ID_MIN = 0;
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

    // Tree Abstraction
    #tree;
    #treeLayers;

    // Bitmap Indexes
    #bitmapStore;   // Bitmap store
    #bitmapCache;   // In-memory cache for bitmap storage

    // Inverted Indexes
    #checksumIndex;
    #timestampIndex;

    // Collections
    #collections;

    // LanceDB
    #lanceDb;
    #lanceTable;
    #lanceRootPath;
    #lanceFtsBitmapKey = 'internal/lance/fts';

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

        /**
         * Inverted indexes
         */

        this.#checksumIndex = new ChecksumIndex(this.#db.createDataset('checksums'));
        this.#timestampIndex = null;

        /**
         * Collections Map (TODO: Implement an easy-to-use collection abstraction)
         */

        this.#collections = new Map();

        /**
         * Tree Abstraction
         */

        // Instantiate Context Tree view
        this.#tree = new ContextTree({
            dataStore: this.#internalStore,
            db: this, // Pass the SynapsD instance for document operations
        });

        this.#treeLayers = null;

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

    // We need to simplify this growing mammoth interface with some delegation kung-fu
    get db() { return this.#db; } // For testing only
    get tree() { return this.#tree; } // db.tree.insertPath()
    get jsonTree() { return this.#tree.buildJsonTree(); } // db.tree.layers.renameLayer()

    // Inverted indexes
    get checksumIndex() { return this.#checksumIndex; }
    get timestampIndex() { return this.#timestampIndex; }

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
                this.#db.createDataset('timestamps'),
                this.actionBitmaps,
            );

            // Initialize LanceDB under workspace root (rootPath/lance)
            await this.#initLance();
            await this.#backfillLance(1000);

            // Ensure FTS membership bitmap exists
            await this.bitmapIndex.createBitmap(this.#lanceFtsBitmapKey);

            // Initialize context tree
            await this.#tree.initialize();
            this.#treeLayers = this.#tree.layers;
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

        // Support inserting by existing document ID to add context/feature memberships without resending the document
        if (typeof document === 'number' || (typeof document === 'string' && /^\d+$/.test(document))) {
            const docId = typeof document === 'number' ? document : parseInt(document, 10);
            // Delegate to updateDocument with null updateData to only adjust memberships
            return await this.updateDocument(docId, null, contextSpec, featureBitmapArray);
        }

        // Parse bitmaps into arrays(context can be a path or a array of context layers)
        const contextBitmaps = this.#parseContextSpec(contextSpec);
        const featureBitmaps = this.#parseBitmapArray(featureBitmapArray);
        debug(`insertDocument: Attempting to insert document with contextArray: ${contextBitmaps}, featureArray: ${featureBitmaps}`);

        // Parse the document
        let parsedDocument;
        if (isDocumentInstance(document)) {
            parsedDocument = document;
        } else {
            parsedDocument = this.#parseInitializeDocument(document);
        }

        // This will throw and we do not need to handle anything at this point
        // so no need for any try/catch kung-fu here
        parsedDocument.validateData();

        // Lets check if we are dealing with an update or a new document
        const primaryChecksum = parsedDocument.getPrimaryChecksum();
        const storedDocument = await this.getDocumentByChecksumString(primaryChecksum);

        if (storedDocument) {
            debug(`insertDocument: Document found by checksum ${primaryChecksum}, setting existing document ID: ${storedDocument.id}`);
            // Preserve the existing document ID
            parsedDocument.id = storedDocument.id;
            // Only carry over timestamps if they exist on the stored document to avoid
            // introducing undefined values that would fail schema validation in some environments
            if (storedDocument.createdAt) { parsedDocument.createdAt = storedDocument.createdAt; }
            if (storedDocument.updatedAt) { parsedDocument.updatedAt = storedDocument.updatedAt; }
        } else {
            debug(`insertDocument: Document not found by checksum ${primaryChecksum}, generating new document ID.`);
            parsedDocument.id = this.#generateDocumentID();
        }

        // Validate the final state before saving
        parsedDocument.validate();
        debug(`insertDocument: Document validated successfully. ID: ${parsedDocument.id}`);

        // Wrap all database operations in a single transaction for atomicity
        try {
            await this.#db.transaction(async () => {
                // Main documents dataset
                await this.documents.put(parsedDocument.id, parsedDocument);
                debug(`insertDocument: Document ${parsedDocument.id} saved to 'documents' dataset.`);

                // Inverted indexes: Checksums
                await this.#checksumIndex.insertArray(parsedDocument.checksumArray, parsedDocument.id);
                debug(`insertDocument: Checksums for document ${parsedDocument.id} added to index.`);

                // Inverted indexes: Timestamps
                await this.#timestampIndex.insert('created', parsedDocument.createdAt || new Date().toISOString(), parsedDocument.id);
                await this.#timestampIndex.insert('updated', parsedDocument.updatedAt, parsedDocument.id);
                debug(`insertDocument: Timestamps for document ${parsedDocument.id} added.`);

                // Ensure context tree paths exist for the *target* context
                const insertPathResult = await this.tree.insertPath(contextBitmaps.join('/'));
                if (!insertPathResult || insertPathResult.error) {
                    throw new Error(`insertDocument: Failed to ensure context path '${contextBitmaps.join('/')}' in tree.`);
                }
                debug(`insertDocument: Context path '${contextBitmaps.join('/')}' ensured in tree.`);

                // Update context bitmaps
                const contextResult = await this.contextBitmapCollection.tickMany(contextBitmaps, parsedDocument.id);
                if (!contextResult) {
                    throw new Error(`insertDocument: Failed to update context bitmaps for document ${parsedDocument.id}`);
                }
                debug(`insertDocument: Context bitmaps updated for document ${parsedDocument.id}.`);

                // Update feature bitmaps
                if (!featureBitmaps.includes(parsedDocument.schema)) {
                    featureBitmaps.push(parsedDocument.schema);
                    debug(`insertDocument: Added document schema '${parsedDocument.schema}' to feature array.`);
                }

                const featureResult = await this.bitmapIndex.tickMany(featureBitmaps, parsedDocument.id);
                if (!featureResult) {
                    throw new Error(`insertDocument: Failed to update feature bitmaps for document ${parsedDocument.id}`);
                }
                debug(`insertDocument: Feature bitmaps updated for document ${parsedDocument.id}.`);
            });

            debug(`insertDocument: All operations completed atomically for document ID: ${parsedDocument.id}`);
        } catch (error) {
            debug(`insertDocument: Transaction failed for document ID: ${parsedDocument.id}, error: ${error.message}`);
            throw new Error('Error inserting document atomically: ' + error.message);
        }

        // Upsert into LanceDB (best-effort, non-fatal)
        try {
            // Ensure document is fully initialized with methods before Lance indexing
            const docForLance = this.#parseInitializeDocument(parsedDocument);
            await this.#upsertLanceDocument(docForLance);
        } catch (e) {
            debug(`insertDocument: Lance upsert failed for ${parsedDocument.id}: ${e.message}`);
        }

        // Emit tree event with contextSpec for workspace mode auto-opening support
        // This ensures that tree.document.inserted events are emitted with the original contextSpec
        if (emitEvent && this.tree) {
            try {
                // Emit the tree event directly since we've already inserted the document
                debug(`insertDocument: Emitting tree event for document ID: ${parsedDocument.id} at contextSpec: ${contextSpec}`);

                this.tree.emit('tree.document.inserted', {
                    documentId: parsedDocument.id,
                    contextSpec: contextSpec,
                    layerNames: [], // Simple implementation for now - layerNames is not critical for tab auto-opening
                    timestamp: new Date().toISOString(),
                });

                debug(`insertDocument: Tree event emitted for document ID: ${parsedDocument.id}`);
            } catch (treeError) {
                debug(`insertDocument: Failed to emit tree event for document ID: ${parsedDocument.id}, error: ${treeError.message}`);
                // Don't fail the insert if tree event emission fails
            }
        }

        // TODO: Send document ID to the embedding vector worker queue
        // TODO: Implement actual batch/transactional operation in the backend if possible

        // Avoid emitting if we update multiple documents in a batch operation(e.g., insertDocumentArray)
        if (emitEvent) { this.emit('document.inserted', { id: parsedDocument.id, document: parsedDocument }); }
        debug(`insertDocument: Successfully inserted document ID: ${parsedDocument.id}`);

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

        const parsedContextKeys = this.#parseContextSpec(effectiveContextSpec);
        const parsedFeatureKeys = this.#parseBitmapArray(effectiveFeatureArray);

        let resultBitmap = null;
        let contextFilterApplied = false;

        // Apply context filter if caller actually wanted one OR if it defaulted to '/' but features are also specified.
        if (!noContextFilterWanted || (noContextFilterWanted && !noFeatureFilterWanted) ) {
            // This condition means: apply context filter if context was specified,
            // OR if context was not specified (defaulting to '/') BUT features were specified.
            resultBitmap = await this.contextBitmapCollection.AND(parsedContextKeys);
            contextFilterApplied = true;
            // If context filter results in null/empty, and it was a specific request, then fail early.
            if (!resultBitmap || resultBitmap.isEmpty) {
                if (!noContextFilterWanted) { // only fail early if context was explicitly requested and yielded no results
                    debug(`hasDocument: Doc ${id} - explicit context filter ${JSON.stringify(parsedContextKeys)} yielded no results.`);
                    return false;
                }
            }
        }

        if (!noFeatureFilterWanted && parsedFeatureKeys.length > 0) {
            const featureOpBitmap = await this.bitmapIndex.OR(parsedFeatureKeys);
            if (!featureOpBitmap || featureOpBitmap.isEmpty) {
                debug(`hasDocument: Doc ${id} - explicit feature filter ${JSON.stringify(parsedFeatureKeys)} yielded no results.`);
                return false; // Feature filter must yield results if specified
            }

            if (contextFilterApplied && resultBitmap) {
                resultBitmap.andInPlace(featureOpBitmap);
            } else {
                resultBitmap = featureOpBitmap; // RoaringBitmap32.or(new RoaringBitmap32(), featureOpBitmap) for a new instance if needed
            }
        } else if (contextFilterApplied && (!resultBitmap || resultBitmap.isEmpty   ) && !noContextFilterWanted) {
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

        // Only parse contextSpec if it was explicitly provided (not null/undefined)
        const contextBitmapArray = contextSpec !== null && contextSpec !== undefined ? this.#parseContextSpec(contextSpec) : [];
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
                resultBitmap = await this.contextBitmapCollection.AND(contextBitmapArray);
                filtersApplied = true; // AND result assigned
            }

            // Apply feature filters if provided
            if (featureBitmapArray.length > 0) {
                const featureBitmap = await this.bitmapIndex.OR(featureBitmapArray);
                if (filtersApplied) { // Check if resultBitmap holds a meaningful value
                    resultBitmap.andInPlace(featureBitmap);
                } else {
                    resultBitmap = featureBitmap;
                    filtersApplied = true; // OR result assigned
                }
            }

            // Apply additional filters (bitmaps and datetime filters)
            if (filterArray.length > 0) {
                const { bitmapFilters, datetimeFilters } = this.#parseFilters(filterArray);

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
                    const datetimeBitmap = await this.#applyDatetimeFilter(datetimeFilter);
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

                const resultArray = parseDocuments ? pagedDocs.map(doc => this.#parseInitializeDocument(doc)) : pagedDocs;
                // Attach metadata for compatibility
                resultArray.count = pagedDocs.length; // Number of documents actually returned
                resultArray.totalCount = totalCount;   // Total number of documents available
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
            const resultArray = parseDocuments ? documents.map(doc => this.#parseInitializeDocument(doc)) : documents;
            // Attach metadata for compatibility
            resultArray.count = documents.length; // Number of documents actually returned
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
        if (!Array.isArray(featureBitmapArray)) { featureBitmapArray = [featureBitmapArray].filter(Boolean); }

        // Ensure docIdentifier is a numeric ID
        if (typeof docIdentifier !== 'number') {
            throw new Error('Document identifier must be a numeric ID');
        }

        const docId = docIdentifier;
        debug(`updateDocument: Attempting to update document with ID: ${docId}`);

        // Parse context into array
        const contextBitmaps = this.#parseContextSpec(contextSpec);
        const featureBitmaps = this.#parseBitmapArray(featureBitmapArray);
        debug(`updateDocument: Context bitmaps: ${contextBitmaps}, Feature bitmaps: ${featureBitmaps}`);

        // Get the stored document
        const storedDocument = await this.getDocumentById(docId);
        if (!storedDocument) {
            throw new Error(`Document with ID "${docId}" not found`);
        }
        debug(`updateDocument: Found existing document with ID: ${docId}`);

        // If no update data provided, we're only updating context/feature memberships
        if (updateData === null) {
            debug('updateDocument: No update data provided, only updating document memberships');
            // Use the stored document as our updated document
            updateData = storedDocument;
        } else if (typeof updateData === 'object' && !isDocumentInstance(updateData)) {
            // Parse and initialize update data if it's not already a document instance
            try {
                updateData = this.#parseInitializeDocument(updateData);
                debug(`updateDocument: Parsed update data, schema: ${updateData.schema}`);
            } catch (error) {
                throw new Error(`Invalid update data: ${error.message}`);
            }
        }

        // Perform the update using the document's update method
        const updatedDocument = storedDocument.update(updateData);
        debug('updateDocument: Document updated in memory, validating...');

        // Validate updated document
        updatedDocument.validate();

        // Ensure context tree paths exist
        if (contextBitmaps.length > 0) {
            this.tree.insertPath(contextBitmaps.join('/'));
            debug(`updateDocument: Ensured context path '${contextBitmaps.join('/')}' exists in tree`);
        }

        try {
            // Update main document store
            await this.documents.put(updatedDocument.id, updatedDocument);

            // Update checksum indexes
            await this.#checksumIndex.deleteArray(storedDocument.checksumArray);
            await this.#checksumIndex.insertArray(updatedDocument.checksumArray, updatedDocument.id);

            // Update timestamps
            await this.#timestampIndex.insert('updated', updatedDocument.updatedAt, updatedDocument.id);

            // Update context bitmaps
            await this.contextBitmapCollection.tickMany(contextBitmaps, updatedDocument.id);

            // Ensure schema is included in features
            if (!featureBitmaps.includes(updatedDocument.schema)) {
                featureBitmaps.push(updatedDocument.schema);
            }

            // Update feature bitmaps
            await this.bitmapIndex.tickMany(featureBitmaps, updatedDocument.id);

            // Emit event
            this.emit('document.updated', { id: updatedDocument.id, document: updatedDocument });
            debug(`updateDocument: Successfully updated document ID: ${updatedDocument.id}`);

            // Best-effort Lance upsert
            try {
                // Ensure document is fully initialized with methods before Lance indexing
                const docForLance = this.#parseInitializeDocument(updatedDocument);
                await this.#upsertLanceDocument(docForLance);
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

        const contextBitmapArray = this.#parseContextSpec(contextSpec);

        // Check if we're trying to remove from root context only
        if (contextBitmapArray.length === 1 && contextBitmapArray[0] === '/') {
            throw new Error('Cannot remove document from root context "/". Use deleteDocument to permanently delete documents.');
        }

        // Remove root "/" from the array if it exists alongside other contexts
        // We should never untick documents from the root context via removeDocument
        let filteredContextArray = contextBitmapArray.filter(context => context !== '/');

        // After filtering, we need at least one context to operate on
        if (filteredContextArray.length === 0) {
            throw new Error('Cannot remove document from root context "/". Use deleteDocument to permanently delete documents.');
        }

        // Handle recursive vs non-recursive removal
        if (!options.recursive) {
            // Non-recursive: remove from leaf context only (last element in the path)
            const leafContext = filteredContextArray[filteredContextArray.length - 1];
            filteredContextArray = [leafContext];
            debug(`removeDocument: Non-recursive removal from leaf context only: ${leafContext}`);
        } else {
            // Recursive: remove from all contexts in the hierarchy (current behavior)
            debug(`removeDocument: Recursive removal from all contexts: ${filteredContextArray.join(', ')}`);
        }

        debug(`removeDocument: Removing document ${docId} from contexts: ${filteredContextArray.join(', ')}`);

        // Remove document will only remove the document from the supplied bitmaps
        // It will not delete the document from the database.
        try {
            if (filteredContextArray.length > 0) {
                await this.contextBitmapCollection.untickMany(filteredContextArray, docId);
            }
            if (featureBitmapArray.length > 0) {
                await this.bitmapIndex.untickMany(featureBitmapArray, docId);
            }

            // If the operations completed without throwing, return the ID.
            // This signals the removal *attempt* was successful.
            this.emit('document.removed', { id: docId, contextArray: filteredContextArray, featureArray: featureBitmapArray, recursive: options.recursive });
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
            document = this.#parseDocumentData(documentData);
            debug('deleteDocument > Document: ', document);

            // Wrap all critical database operations in a single transaction for atomicity
            await this.#db.transaction(async () => {
                // Delete document from main database
                await this.documents.delete(docId);
                debug(`deleteDocument: Document ${docId} deleted from main store`);

                // Delete document from all bitmaps
                await this.bitmapIndex.untickAll(docId);
                debug(`deleteDocument: Document ${docId} removed from all bitmaps`);

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
                await this.#deleteLanceDocument(docId);
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
        return options.parse ? this.#parseInitializeDocument(rawDocData) : rawDocData;
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
                data: options.parse ? limitedDocs.map(doc => this.#parseInitializeDocument(doc)) : limitedDocs,
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

    async query(queryString, contextSpec = null, featureBitmapArray = [], filterArray = [], options = { parse: true }) {
        if (typeof queryString !== 'string') {
            throw new ArgumentError('Query must be a string', 'query');
        }

        return await this.ftsQuery(queryString, contextSpec, featureBitmapArray, filterArray, options);
    }

    async ftsQuery(queryString, contextSpec = null, featureBitmapArray = [], filterArray = [], options = { parse: true, limit: 50, offset: 0 }) {
        if (!this.#lanceTable) {
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
        const contextBitmapArray = contextSpec !== null && contextSpec !== undefined ? this.#parseContextSpec(contextSpec) : [];

        if (contextSpec !== null && contextSpec !== undefined && contextBitmapArray.length > 0) {
            candidateBitmap = await this.contextBitmapCollection.AND(contextBitmapArray);
            filtersApplied = true;
        }
        if (Array.isArray(featureBitmapArray) && featureBitmapArray.length > 0) {
            const featureBitmap = await this.bitmapIndex.OR(featureBitmapArray);
            if (filtersApplied && candidateBitmap) { candidateBitmap.andInPlace(featureBitmap); } else { candidateBitmap = featureBitmap; filtersApplied = true; }
        }

        // Parse and apply filters (including datetime)
        if (Array.isArray(filterArray) && filterArray.length > 0) {
            const { bitmapFilters, datetimeFilters } = this.#parseFilters(filterArray);

            // Apply bitmap filters
            if (bitmapFilters.length > 0) {
                const extraFilter = await this.bitmapIndex.AND(bitmapFilters);
                if (filtersApplied && candidateBitmap) { candidateBitmap.andInPlace(extraFilter); } else { candidateBitmap = extraFilter; filtersApplied = true; }
            }

            // Apply datetime filters
            for (const datetimeFilter of datetimeFilters) {
                const datetimeBitmap = await this.#applyDatetimeFilter(datetimeFilter);
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
        // MVP: use local FTS scoring over candidate IDs for deterministic results
        if (filtersApplied && candidateIds.length > 0) {
            return await this.#localFtsFallback(queryString, candidateIds, { limit, offset, parse: parseDocuments });
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
            doc = this.#parseInitializeDocument(doc);

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

    #parseContextSpec(contextSpec) {
        debug('#parseContextSpec: Received contextSpec:', contextSpec);

        // Handle null/undefined/empty cases
        if (!contextSpec || contextSpec === '') {
            return ['/'];
        }

        // Process a single path string to create layer contexts
        const processString = (str) => {
            if (str === '/') {return ['/'];}

            // Split the string and filter empty elements
            const parts = str.split('/').map(part => part.trim()).filter(Boolean);
            if (parts.length === 0) {return ['/'];}

            // Create layer contexts: ['/', 'foo', 'bar', 'baz']
            return ['/', ...parts];
        };

        // Handle array input
        if (Array.isArray(contextSpec)) {
            // Flatten the array and filter out empty/null values
            const flattened = contextSpec.flat().filter(Boolean);
            if (flattened.length === 0) {
                return ['/'];
            }

            // Process each path and collect unique layer contexts
            const allContexts = new Set(['/']); // Always include root
            flattened.forEach(path => {
                const contexts = processString(path);
                contexts.forEach(context => allContexts.add(context));
            });

            return Array.from(allContexts);
        }

        // Handle string input
        if (typeof contextSpec === 'string') {
            return processString(contextSpec);
        }

        throw new Error('Invalid contextSpec: Must be a path string or an array of strings.');
    }

    #parseBitmapArray(bitmapArray) {
        if (!Array.isArray(bitmapArray)) { bitmapArray = [bitmapArray]; }
        return bitmapArray;
    }

    /**
     * Parse filterArray into bitmap filters and datetime filters
     * Supports both string-based and object-based filter formats
     * @private
     */
    #parseFilters(filterArray) {
        const bitmapFilters = [];
        const datetimeFilters = [];

        for (const filter of filterArray) {
            // Object-based filter
            if (typeof filter === 'object' && filter !== null && filter.type === 'datetime') {
                datetimeFilters.push(filter);
            }
            // String-based datetime filter
            else if (typeof filter === 'string' && filter.startsWith('datetime:')) {
                const parsed = this.#parseDatetimeFilterString(filter);
                if (parsed) {
                    datetimeFilters.push(parsed);
                }
            }
            // Regular bitmap filter
            else {
                bitmapFilters.push(filter);
            }
        }

        return { bitmapFilters, datetimeFilters };
    }

    /**
     * Parse string-based datetime filter into object format
     * Formats:
     *   datetime:ACTION:TIMEFRAME (e.g., datetime:updated:today)
     *   datetime:ACTION:range:START:END (e.g., datetime:created:range:2023-10-01:2023-10-31)
     * @private
     */
    #parseDatetimeFilterString(filterString) {
        const parts = filterString.split(':');

        if (parts.length < 3) {
            debug(`Invalid datetime filter format: ${filterString}`);
            return null;
        }

        const [, action, specType, ...rest] = parts;

        // Validate action
        if (!['created', 'updated', 'deleted'].includes(action)) {
            debug(`Invalid datetime action: ${action}`);
            return null;
        }

        // Range filter: datetime:updated:range:2023-10-01:2023-10-31
        if (specType === 'range' && rest.length === 2) {
            return {
                type: 'datetime',
                action,
                range: { start: rest[0], end: rest[1] }
            };
        }

        // Timeframe filter: datetime:updated:today
        const validTimeframes = ['today', 'yesterday', 'thisWeek', 'thisMonth', 'thisYear'];
        if (validTimeframes.includes(specType)) {
            return {
                type: 'datetime',
                action,
                timeframe: specType
            };
        }

        debug(`Invalid datetime filter spec: ${filterString}`);
        return null;
    }

    /**
     * Apply datetime filter and return bitmap of matching document IDs
     * @private
     */
    async #applyDatetimeFilter(filter) {
        if (!this.#timestampIndex) {
            debug('Timestamp index not initialized, skipping datetime filter');
            return null;
        }

        try {
            const action = filter.action;
            let ids = [];

            // Timeframe-based filter
            if (filter.timeframe) {
                ids = await this.#timestampIndex.findByTimeframe(filter.timeframe, action);
                debug(`Datetime filter (${action}:${filter.timeframe}) matched ${ids.length} documents`);
            }
            // Range-based filter
            else if (filter.range) {
                ids = await this.#timestampIndex.findByRangeAndAction(action, filter.range.start, filter.range.end);
                debug(`Datetime filter (${action}:${filter.range.start} to ${filter.range.end}) matched ${ids.length} documents`);
            }

            // Convert to RoaringBitmap32
            if (ids.length > 0) {
                const roaring = await import('roaring');
                const { RoaringBitmap32 } = roaring.default || roaring;
                return new RoaringBitmap32(ids);
            }

            return null;
        } catch (error) {
            debug(`Error applying datetime filter: ${error.message}`);
            return null;
        }
    }

    async #initLance() {
        try {
            this.#lanceRootPath = path.join(this.#rootPath, 'lance');
            if (!fs.existsSync(this.#lanceRootPath)) {
                fs.mkdirSync(this.#lanceRootPath, { recursive: true });
            }
            this.#lanceDb = await lancedb.connect(this.#lanceRootPath);
            try {
                this.#lanceTable = await this.#lanceDb.openTable('documents');
            } catch (e) {
                // Create table with schema
                const sampleRow = {
                    id: 0,
                    schema: 'sample',
                    updatedAt: new Date().toISOString(),
                    fts_text: 'sample text',
                };
                await this.#lanceDb.createTable('documents', [sampleRow]);
                this.#lanceTable = await this.#lanceDb.openTable('documents');
                // Remove the sample row
                await this.#lanceTable.delete('id = 0');
            }
            // Ensure BM25 index on fts_text exists
            await this.#ensureLanceFtsIndex();
        } catch (error) {
            debug(`LanceDB initialization failed: ${error.message}`);
            // Non-fatal: allow DB to run without FTS
            this.#lanceDb = null;
            this.#lanceTable = null;
        }
    }

    async #upsertLanceDocument(doc) {
        if (!this.#lanceTable || !doc || !doc.id) { return; }
        const ftsArray = typeof doc.generateFtsData === 'function' ? doc.generateFtsData() : null;
        const ftsText = Array.isArray(ftsArray) ? ftsArray.join('\n') : '';
        const row = {
            id: doc.id,
            schema: doc.schema,
            updatedAt: doc.updatedAt,
            fts_text: ftsText,
        };
        // Emulate upsert by deleting existing id then adding
        try { await this.#lanceTable.delete?.(`id = ${doc.id}`); } catch (_) {}
        await this.#lanceTable.add([row]);
        // Mark as FTS-indexed in bitmap
        try { await this.bitmapIndex.tick(this.#lanceFtsBitmapKey, doc.id); } catch (_) {}
    }

    async #deleteLanceDocument(docId) {
        if (!this.#lanceTable || !docId) { return; }
        await this.#lanceTable.delete?.(`id = ${docId}`);
        try { await this.bitmapIndex.untick(this.#lanceFtsBitmapKey, docId); } catch (_) { /* ignore */ }
    }

    async #ensureLanceFtsIndex() {
        if (!this.#lanceTable) { return; }
        try {
            await this.#lanceTable.createIndex?.({ type: 'BM25', columns: ['fts_text'] });
        } catch (_) { /* ignore if already exists */ }
    }

    async #localFtsFallback(queryString, candidateIds, opts = { limit: 50, offset: 0, parse: true }) {
        const limit = Math.max(0, Number(opts.limit ?? 50));
        const offset = Math.max(0, Number(opts.offset ?? 0));
        const parseDocs = opts.parse !== false;

        const docs = await this.documents.getMany(candidateIds);
        const tokens = String(queryString).toLowerCase().split(/\s+/).filter(Boolean);
        const scored = [];

        for (const raw of docs) {
            const doc = parseDocs ? this.#parseInitializeDocument(raw) : raw;
            const parts = (typeof doc.generateFtsData === 'function' ? doc.generateFtsData() : []) || [];
            const text = parts.join('\n').toLowerCase();
            let score = 0;
            for (const token of tokens) { if (text.includes(token)) { score++; } }
            // AND logic: only include documents where ALL tokens match
            if (score === tokens.length) { scored.push({ id: doc.id, score, doc }); }
        }

        scored.sort((a, b) => b.score - a.score || a.id - b.id);
        const sliced = limit === 0 ? scored : scored.slice(offset, offset + limit);
        const result = sliced.map(s => s.doc);
        result.count = result.length;
        result.totalCount = scored.length;
        result.error = null;
        return result;
    }

    async #backfillLance(limit = 2000) {
        try {
            if (!this.#lanceTable) { return; }

            // Get bitmaps for all documents and processed documents
            const allDocsBitmap = await this.bitmapIndex.getBitmap('context/', false);
            const processedBitmap = await this.bitmapIndex.getBitmap(this.#lanceFtsBitmapKey, false);

            if (!allDocsBitmap || allDocsBitmap.isEmpty) {
                debug('#backfillLance: no documents found in context bitmap');
                return;
            }

            // Calculate unprocessed documents using bitmap difference
            let unprocessedBitmap = allDocsBitmap.clone();
            if (processedBitmap && !processedBitmap.isEmpty) {
                unprocessedBitmap.andNotInPlace(processedBitmap); // Remove processed docs
            }

            if (unprocessedBitmap.isEmpty) {
                debug('#backfillLance: all documents already processed');
                return;
            }

            // Convert to array and limit the processing
            const unprocessedIds = unprocessedBitmap.toArray();
            const idsToProcess = limit > 0 ? unprocessedIds.slice(0, limit) : unprocessedIds;

            debug(`#backfillLance: found ${unprocessedIds.length} unprocessed documents, processing ${idsToProcess.length}`);

            let processed = 0;
            for (const docId of idsToProcess) {
                try {
                    const docData = await this.documents.get(docId);
                    if (docData) {
                        const doc = this.#parseInitializeDocument(docData);
                        await this.#upsertLanceDocument(doc);
                        processed++;
                    }
                } catch (e) {
                    debug(`#backfillLance: failed to upsert doc ${docId}: ${e.message}`);
                }
            }

            debug(`#backfillLance: backfilled ${processed} documents into Lance FTS`);
        } catch (e) {
            debug(`#backfillLance: error ${e.message}`);
        }
    }

    /**
     * Parse a document data object
     * @param {String|Object} documentData - Document data as string or object
     * @returns {Object} Parsed document data object (JSON parsed if string)
     * @private
     */
    #parseDocumentData(documentData) {
        debug('#parseDocumentData: Received data type:', typeof documentData);
        if (!documentData) { throw new Error('Document data required'); }

        let parsedData;

        if (typeof documentData === 'string') {
            try {
                debug('#parseDocumentData: Parsing JSON string.');
                parsedData = JSON.parse(documentData);
                debug('#parseDocumentData: JSON parsed successfully.');
            } catch (error) {
                debug(`#parseDocumentData: Error parsing JSON string: ${error.message}`);
                throw new Error(`Invalid JSON data provided: ${error.message}`);
            }
        } else if (typeof documentData === 'object' && documentData !== null) {
            parsedData = documentData;
        } else {
            debug('#parseDocumentData: Error - Input data is not a string or object:', typeof documentData);
            throw new Error(`Invalid document data type: Expected string or object, got ${typeof documentData}`);
        }

        // Basic sanity check for schema and data properties after potential parsing
        if (!parsedData.schema || parsedData.data === undefined) {
            throw new Error('Parsed document data must have a schema and data property.', parsedData);
        }

        debug('#parseDocumentData: Returning parsed data.');
        return parsedData;
    }

    /**
     * Initialize a document (without validation)
     * @param {Object} documentData - Document data object
     * @returns {BaseDocument} Initialized document instance
     * @private
     */
    #initializeDocument(documentData) {
        debug('#initializeDocument: Initializing document. Input type:', typeof documentData, 'Is instance:', isDocumentInstance(documentData));
        if (!documentData || typeof documentData !== 'object') {
            throw new Error('Document data required for initialization (must be an object)');
        }

        let doc;

        // Case 1: Already a document instance
        if (isDocumentInstance(documentData)) {
            debug('#initializeDocument: Input is already a Document instance, returning it.');
            doc = documentData;

        // Case 2: A plain data object that conforms to the basic document structure
        } else if (isDocumentData(documentData)) {
            debug(`#initializeDocument: Input is a plain data object. Schema: ${documentData.schema}`);
            // Get the schema class for the document
            const Schema = this.getSchema(documentData.schema); // This throws if schema not found
            if (!Schema) { /* Redundant due to getSchema throwing, but belts and suspenders */ throw new Error(`Schema ${documentData.schema} not found`); }
            debug(`#initializeDocument: Found Schema class for ${documentData.schema}.`);

            // Create a document instance *from* the data using the specific class's factory
            doc = Schema.fromData(documentData); // This handles setting defaults, validates before returning
            debug(`#initializeDocument: Created new Document instance from data, CreatedAt: ${doc.createdAt}. running vaidation..`);

        } else {
            debug('#initializeDocument: Error - Input is not a Document instance or plain data object.');
            throw new Error('Invalid document data type: Expected Document instance or plain data object.');

        }

        debug(`#initializeDocument: Initialization complete. Returning document instance, Schema: ${doc.schema}`);
        return doc;
    }

    /**
     * Parse and initialize a document
     * @param {Object} document - Document data or instance to parse
     * @returns {BaseDocument} Initialized document instance
     * @private
     */
    #parseInitializeDocument(documentData) {
        debug('#parseInitializeDocument: Starting parse and initialization.');
        if (!documentData) {
            debug('#parseInitializeDocument: Error - Input document data is required.');
            throw new Error('Document data required');
        }

        let parsedData;
        let initializedDoc;

        try {
            // Step 1: Parse the input (handles strings, ensures basic object structure)
            parsedData = this.#parseDocumentData(documentData);
            debug('#parseInitializeDocument: Document parsed successfully.');

            // Step 2: Initialize the document (creates instance if needed, validates, generates checksums)
            initializedDoc = this.#initializeDocument(parsedData);
            debug('#parseInitializeDocument: Document initialized successfully.');

        } catch (error) {
            // Catch errors from either #parseDocumentData or #initializeDocument
            debug(`#parseInitializeDocument: Failed during parse/initialize chain: ${error.message}`);
            throw new Error(`Failed to parse and initialize document: ${error.message}`);
        }

        debug('#parseInitializeDocument: Parse and initialization complete. Returning document instance.');
        return initializedDoc; // Return the fully validated and initialized BaseDocument instance
    }

    #generateDocumentID() {
        try {
            const counterKey = 'internal/document-id-counter';

            // Use synchronous transaction for atomic ID generation
            return this.#internalStore.transactionSync(() => {
                // Get current counter within transaction
                let currentCounter = this.#internalStore.get(counterKey);

                // Initialize counter if it doesn't exist
                if (currentCounter === undefined || currentCounter === null) {
                    // Start from INTERNAL_BITMAP_ID_MAX to avoid conflicts with internal bitmaps
                    currentCounter = INTERNAL_BITMAP_ID_MAX;
                    debug(`Initializing document ID counter to: ${currentCounter}`);
                }

                // Increment counter
                const newId = currentCounter + 1;

                // Update counter atomically within transaction
                this.#internalStore.putSync(counterKey, newId);

                debug(`Generated document ID: ${newId}`);
                return newId;
            });
        } catch (error) {
            debug(`Error generating document ID: ${error.message}`);
            throw error;
        }
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




