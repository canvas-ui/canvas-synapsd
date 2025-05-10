'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import fs from 'fs';
import path from 'path';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd');

// DB Backend
import Db from './backends/lmdb/index.js';

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
    #dbBackend = 'lmdb';
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

    constructor(options = {
        backupOnOpen: false,
        backupOnClose: true,
        compression: true,
        eventEmitterOptions: {},
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

        debug('Database path:', this.#rootPath);
        this.#db = new Db({
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

        // TODO: FTS index
        // TODO: Vector index

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
            timestampIndexSize: this.#timestampIndex.getCount(),
            // TODO: Refactor this away
            deletedDocumentsCount: this.deletedDocumentsBitmap.size,
            actionBitmaps: {
                created: this.actionBitmaps.created.size,
                updated: this.actionBitmaps.updated.size,
                deleted: this.actionBitmaps.deleted.size,
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
            this.emit('before-shutdown');
            // Close index backends
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
            parsedDocument.id = storedDocument.id;
            parsedDocument.createdAt = storedDocument.createdAt;
        } else {
            debug(`insertDocument: Document not found by checksum ${primaryChecksum}, generating new document ID.`);
            parsedDocument.id = await this.#generateDocumentID();
        }

        // Validate the final state before saving
        parsedDocument.validate();
        debug(`insertDocument: Document validated successfully. ID: ${parsedDocument.id}`);

        // Insert document into the main datasets
        try {
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

        } catch (error) {
            throw new Error('Error inserting document into main datasets: ' + error.message);
        }

        // Ensure context tree paths exist for the *target* context
        if (!this.tree.insertPath(contextBitmaps.join('/'))) { // Use the parsed context array
            throw new Error(`insertDocument: Failed to ensure context path '${contextBitmaps.join('/')}' in tree.`);
        }
        debug(`insertDocument: Context path '${contextBitmaps.join('/')}' ensured in tree.`);

        // Update context bitmaps
        if (!this.contextBitmapCollection.tickMany(contextBitmaps, parsedDocument.id)) {
            throw new Error(`insertDocument: Failed to update context bitmaps for document ${parsedDocument.id}`);
        }
        debug(`insertDocument: Context bitmaps updated for document ${parsedDocument.id}.`);

        // Update feature bitmaps
        if (!featureBitmaps.includes(parsedDocument.schema)) {
            featureBitmaps.push(parsedDocument.schema);
            debug(`insertDocument: Added document schema '${parsedDocument.schema}' to feature array.`);
        }

        if (!this.bitmapIndex.tickMany(featureBitmaps, parsedDocument.id)) {
            throw new Error(`insertDocument: Failed to update feature bitmaps for document ${parsedDocument.id}`);
        }
        debug(`insertDocument: Feature bitmaps updated for document ${parsedDocument.id}.`);

        // Send document ID to the embedding vector worker queue
        // TODO: Implement sending document ID to the embedding vector worker queue

        // Avoid emitting if we update multiple documents in a batch operation(e.g., insertDocumentArray)
        if (emitEvent) { this.emit('document:inserted', { id: parsedDocument.id, document: parsedDocument }); }
        debug(`insertDocument: Successfully inserted document ID: ${parsedDocument.id}`);

        return parsedDocument.id;
    }

    async insertDocumentArray(docArray, contextSpec = '/', featureBitmapArray = []) {
        if (!Array.isArray(docArray)) { docArray = [docArray]; }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }

        // Collect errors
        let errors = [];
        let successfulInsertions = [];

        // Insert documents
        // TODO: Insert with a batch operation
        for (let i = 0; i < docArray.length; i++) {
            const doc = docArray[i];
            try {
                const id = await this.insertDocument(doc, contextSpec, featureBitmapArray, false);
                successfulInsertions.push({ index: i, id: id });
                debug(`insertDocumentArray: Successfully inserted document at index ${i}, ID: ${id}`);
            } catch (error) {
                debug(`insertDocumentArray: Error inserting document at index ${i}: ${error.message}`);
                errors.push({
                    index: i,
                    error: error.message || 'Unknown error',
                    doc: doc
                });
            }
        }

        debug(`insertDocumentArray: Inserted ${successfulInsertions.length} of ${docArray.length} documents`);
        if (errors.length > 0) {
            debug(`insertDocumentArray: Failed to insert ${errors.length} documents`);
        }

        return errors;
    }

    async hasDocument(id, contextSpec, featureBitmapArrayInput) {
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

    async hasDocumentByChecksum(checksum, contextSpec, featureBitmapArray) {
        if (!checksum) { throw new Error('Checksum required'); }

        const id = await this.#checksumIndex.checksumStringToId(checksum);
        if (!id) { return false; }

        return await this.hasDocument(id, contextSpec, featureBitmapArray);
    }

    // Legacy API, now alias for findDocuments,
    // TODO: Implement for metedata retrieval only
    async listDocuments(contextSpec = '/', featureBitmapArray = [], filterArray = [], options = { parse: true }) {
        return await this.findDocuments(contextSpec, featureBitmapArray, filterArray, options);
    }

    async findDocuments(contextSpec = '/', featureBitmapArray = [], filterArray = [], options = { parse: true }) {
        const contextBitmapArray = this.#parseContextSpec(contextSpec);
        if (!Array.isArray(featureBitmapArray) && typeof featureBitmapArray === 'string') { featureBitmapArray = [featureBitmapArray]; }
        if (!Array.isArray(filterArray) && typeof filterArray === 'string') { filterArray = [filterArray]; }
        debug(`Listing documents with contextArray: ${contextBitmapArray}, features: ${featureBitmapArray}, filters: ${filterArray}`);

        // Start with null, will hold RoaringBitmap32 instance if filters are applied
        let resultBitmap = null;
        // Flag to track if any filters actually modified the initial empty bitmap
        let filtersApplied = false;

        // Apply context filters if provided
        if (contextBitmapArray.length > 0) {
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

        // Apply additional filters if provided
        if (filterArray.length > 0) {
            const filterBitmap = await this.bitmapIndex.AND(filterArray);
            if (filtersApplied) {
                resultBitmap.andInPlace(filterBitmap);
            } else {
                resultBitmap = filterBitmap;
                filtersApplied = true; // Modified by AND
            }
        }

        // Convert the final bitmap result (which might be null) to an ID array
        const finalDocumentIds = resultBitmap ? resultBitmap.toArray() : [];

        // Case 1: No filters were effectively applied (bitmap is still initial empty state).
        // We check filtersApplied flag instead of array lengths now.
        if (!filtersApplied) {
            // Changed from listEntries to getRange for consistency
            // TODO: Add limit support directly to getRange if possible
            const documents = [];
            for await (const { key, value } of this.documents.getRange()) {
                documents.push(value);
            }
            return options.limit ? documents.slice(0, options.limit) : documents;
        }

        // Case 2: Filters were applied, but the resulting bitmap is null (e.g., ANDing non-existent keys) or empty.
        if (finalDocumentIds.length === 0) {
            debug('findDocuments: Resulting bitmap is null or empty after applying filters. Returning [].');
            return []; // Return empty array, not all documents
        }

        // Convert bitmap to array of document IDs
        const documentIds = finalDocumentIds;
        if (options.limit) {
            documentIds = documentIds.slice(0, options.limit);
        }

        //
        const documents = await this.documents.getMany(documentIds);
        if (options.limit) {
            documents = documents.slice(0, options.limit);
        }

        if (options.parse) {
            let initializedDocuments = [];
            for (const doc of documents) {
                initializedDocuments.push(this.#parseInitializeDocument(doc));
            }
            return initializedDocuments;
        } else {
            return documents;
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
            debug(`updateDocument: No update data provided, only updating document memberships`);
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
        let updatedDocument = storedDocument.update(updateData);
        debug(`updateDocument: Document updated in memory, validating...`);

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
            this.emit('document:updated', { id: updatedDocument.id, document: updatedDocument });
            debug(`updateDocument: Successfully updated document ID: ${updatedDocument.id}`);

            return updatedDocument.id;
        } catch (error) {
            debug(`updateDocument: Error during update: ${error.message}`);
            throw error;
        }
    }

    async updateDocumentArray(docArray, contextSpec = null, featureBitmapArray = []) {
        if (!Array.isArray(docArray)) { docArray = [docArray]; }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }

        // Collect errors
        let errors = [];

        // Update documents
        // TODO: Update with a batch operation
        for (const doc of docArray) {
            try {
                await this.updateDocument(doc, contextSpec, featureBitmapArray);
            } catch (error) {
                errors.push(error); // doc.id may not be set yet
            }
        }

        return errors;
    }

    // Removes documents from context and/or feature bitmaps
    async removeDocument(docId, contextSpec = '/', featureBitmapArray = []) {
        if (!docId) { throw new Error('Document id required'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }

        const contextBitmapArray = this.#parseContextSpec(contextSpec);

        // Remove document will only remove the document from the supplied bitmaps
        // It will not delete the document from the database.
        try {
            if (contextBitmapArray.length > 0) {
                await this.contextBitmapCollection.untickMany(contextBitmapArray, docId);
            }
            if (featureBitmapArray.length > 0) {
                await this.bitmapIndex.untickMany(featureBitmapArray, docId);
            }

            // If the operations completed without throwing, return the ID.
            // This signals the removal *attempt* was successful.
            this.emit('document:removed', { id: docId, contextArray: contextSpec, featureArray: featureBitmapArray });
            return docId;

        } catch (error) {
            // Catch unexpected errors (DB connection, etc.)
            debug(`Error during removeDocument for ID ${docId}: ${error.message}`);
            // Re-throw the error so callers know something went wrong
            throw error;
        }
    }

    async removeDocumentArray(docIdArray, contextSpec = '/', featureBitmapArray = []) {
        if (!Array.isArray(docIdArray)) { docIdArray = [docIdArray]; }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }

        // Collect errors
        let errors = [];

        // TODO: Implement batch operation
        for (const id of docIdArray) {
            try {
                await this.removeDocument(id, contextSpec, featureBitmapArray);
            } catch (error) {
                errors[id] = error;
            }
        }

        return errors;
    }

    // Deletes documents from all bitmaps and the main dataset
    async deleteDocument(docId) {
        if (!docId) { throw new Error('Document id required'); }
        if (!await this.documents.has(docId)) { return false; }
        debug(`deleteDocument: Document with ID "${docId}" found, deleting..`);

        try {
            // Get document before deletion
            const documentData = await this.documents.get(docId);
            const document = this.#parseDocumentData(documentData);
            debug('deleteDocument > Document: ', document);

            // Delete document from database
            await this.documents.delete(docId);

            // Delete document from all bitmaps
            await this.bitmapIndex.untickAll(docId);

            // Delete document checksums from inverted index
            await this.#checksumIndex.deleteArray(document.checksumArray);

            // Add document ID to deleted documents bitmap
            await this.deletedDocumentsBitmap.tick(docId);

            // Timestamp index
            await this.#timestampIndex.insert('deleted', document.updatedAt, docId);

            debug(`Document with ID "${docId}" deleted`);
            this.emit('document:deleted', { id: docId });
            return true;
        } catch (error) {
            debug(`Error deleting document ${docId}: `, error);
            return false;
        }
    }

    async deleteDocumentArray(docIdArray) {
        if (!Array.isArray(docIdArray)) { docIdArray = [docIdArray]; }

        // Collect errors
        let errors = [];

        // TODO: Implement batch operation
        for (const id of docIdArray) {
            try {
                await this.deleteDocument(id);
            } catch (error) {
                errors.push(error); // doc.id may not be set yet
            }
        }

        return errors;
    }

    /**
     * Convenience methods
     */

    async getDocument(docId, options = { parse: true }) {
        if (!docId) { throw new Error('Document id required'); }
        if (options.parse) {
            return await this.getDocumentById(docId);
        } else {
            return await this.documents.get(docId);
        }
    }

    /**
     * Get a document by ID and return a properly instantiated document object
     * @param {string|number} id - Document ID
     * @returns {BaseDocument|null} Document instance or null if not found
     */
    async getDocumentById(id, options = { parse: true }) {
        if (!id) { throw new Error('Document id required'); }
        debug(`getById: Searching for document with ID ${id}`);
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
        if (!Array.isArray(idArray)) { idArray = [idArray]; }

        const documents = await this.documents.getMany(idArray);
        if (options.limit) {
            documents = documents.slice(0, options.limit);
        }

        if (options.parse) {
            const initializedDocuments = [];
            for (const doc of documents) {
                initializedDocuments.push(this.#parseInitializeDocument(doc));
            }
            return initializedDocuments;
        }

        return documents;
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

        // Return the document instance
        return await this.getDocumentById(id, options);
    }

    /**
     * Get multiple documents by checksum string and return properly instantiated document objects
     * @param {Array<string>} checksumStringArray - Array of checksum strings
     * @returns {Array<BaseDocument>} Array of document instances
     */
    async getDocumentsByChecksumStringArray(checksumStringArray, options = { parse: true }) {
        if (!Array.isArray(checksumStringArray)) { checksumStringArray = [checksumStringArray]; }

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

        // Use getDocumentsByIdArray which now properly instantiates document objects
        return await this.getDocumentsByIdArray(ids, options);
    }

    async setDocumentArrayFeatures(docIdArray, featureBitmapArray) {
        if (!docIdArray) { throw new Error('Document ID array required'); }
        if (!Array.isArray(docIdArray)) {
            docIdArray = [docIdArray];
        }
        if (!featureBitmapArray) { throw new Error('Feature bitmap array required'); }
        if (!Array.isArray(featureBitmapArray)) {
            featureBitmapArray = [featureBitmapArray];
        }

        for (const docId of docIdArray) {
            if (!docId) {
                console.warn('setDocumentArrayFeatures: Skipping invalid document ID.');
                continue;
            }
            // Update the document's feature bitmaps
            await this.bitmapIndex.tickMany(featureBitmapArray, docId);
        }
    }

    async unsetDocumentArrayFeatures(docIdArray, featureBitmapArray) {
        if (!docIdArray) { throw new Error('Document ID array required'); }
        if (!Array.isArray(docIdArray)) {
            docIdArray = [docIdArray];
        }
        if (!featureBitmapArray) { throw new Error('Feature bitmap array required'); }
        if (!Array.isArray(featureBitmapArray)) {
            featureBitmapArray = [featureBitmapArray];
        }

        for (const docId of docIdArray) {
            if (!docId) {
                console.warn('unsetDocumentArrayFeatures: Skipping invalid document ID.');
                continue;
            }
            // Update the document's feature bitmaps
            await this.bitmapIndex.untickMany(featureBitmapArray, docId);
        }
    }

    /**
     * Query methods
     */

    async query(query, contextBitmapArray = [], featureBitmapArray = [], filterArray = [], metadataOnly = false) {
        if (typeof query !== 'string') { throw new Error('Query must be a string'); }
        if (!Array.isArray(contextBitmapArray)) { throw new Error('Context array must be an array'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }
        if (!Array.isArray(filterArray)) { throw new Error('Filter array must be an array'); }

        debug('Query not implemented yet');
        throw new Error('Query method not implemented yet');
    }

    async ftsQuery(query, contextBitmapArray = [], featureBitmapArray = [], filterArray = [], metadataOnly = false) {
        if (typeof query !== 'string') { throw new Error('Query must be a string'); }
        if (!Array.isArray(contextBitmapArray)) { throw new Error('Context array must be an array'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }
        if (!Array.isArray(filterArray)) { throw new Error('Filter array must be an array'); }

        debug('FTS Query not implemented yet');
        throw new Error('FTS Query method not implemented yet');
    }

    /**
     * Utils
     */

    async dumpDocuments(dstDir, contextSpec = null, featureBitmapArray = [], filterArray = []) {
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
        if (!contextSpec || contextSpec == '' || contextSpec == '/' || contextSpec == null) {
            return ['/'];
        }

        const processString = (str) => {
            if (!str) return ['/'];
            if (str === '/') return ['/'];
            // Split the string and filter empty elements
            const parts = str.split('/').map(part => part.trim()).filter(Boolean);
            // Ensure '/' is at the beginning
            return ['/', ...parts];
        };

        if (Array.isArray(contextSpec)) {
            const result = contextSpec.flatMap(processString);
            // Remove duplicate '/' if they exist
            const uniqueResult = Array.from(new Set(result));
            // Ensure '/' is at the beginning (moving it if needed)
            if (uniqueResult.includes('/')) {
                uniqueResult.splice(uniqueResult.indexOf('/'), 1);
            }
            return uniqueResult.length ? ['/', ...uniqueResult] : ['/'];
        }

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
            throw new Error('Parsed document data must have a schema and data property.');
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

    async #documentCount() {
        const count = await this.documents.getStats().entryCount; // await this.documents.getCount();
        debug(`#documentCount: ${count}`);
        return count;
    }

    async #generateDocumentID() {
        try {
            // Try to get a recycled ID first
            const recycledId = this.#popDeletedId();
            if (recycledId !== null) {
                debug(`Using recycled document ID: ${recycledId}`);
                return recycledId;
            }

            // Generate a new ID based on the document count
            let count = await this.#documentCount();
            debug(`Document count: ${count}`);
            // Ensure count is a number
            count = typeof count === 'number' ? count : 0;
            const newId = INTERNAL_BITMAP_ID_MAX + count + 1;
            debug(`Generated new document ID: ${newId}`);
            console.log(`Generated new document ID: ${newId}`);
            return newId;
        } catch (error) {
            debug(`Error generating document ID: ${error.message}`);
            throw error;
        }
    }

    /**
     * Safely get a recycled ID from the deletedDocuments bitmap
     * @returns {number|null} A numeric ID or null if none available
     * @private
     */
    #popDeletedId() {
        try {
            if (!this.deletedDocumentsBitmap || this.deletedDocumentsBitmap.isEmpty) {
                return null;
            }

            // Get the minimum ID from the deleted documents bitmap
            const minId = this.deletedDocumentsBitmap.minimum();

            // Ensure it's a valid number
            if (typeof minId !== 'number' || isNaN(minId) || !Number.isInteger(minId) || minId <= 0) {
                debug(`Invalid minimum ID in deletedDocuments: ${minId}`);
                return null;
            }

            // Remove this ID from the bitmap
            // Lets do this after insertion only
            //this.deletedDocumentsBitmap.remove(minId);

            return minId;
        } catch (error) {
            debug(`Error popping deleted ID: ${error.message}`);
            return null;
        }
    }

}

export default SynapsD;


