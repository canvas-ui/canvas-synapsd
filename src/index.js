'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import debugInstance from 'debug';
import fs from 'fs';
import path from 'path';
const debug = debugInstance('canvas:synapsd');

// DB Backend
import Db from './backends/lmdb/index.js';

// Schemas
import schemaRegistry from './schemas/SchemaRegistry.js';
import { isDocument, isDocumentInstance } from './schemas/SchemaRegistry.js';
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

        // Action bitmaps
        // TODO: Refactor || FIX!
        this.actionBitmaps = null;

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
         * Collections (TODO: Implement an easy-to-use collection abstraction)
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
    get layers() { return this.#treeLayers; } // db.tree.layers.renameLayer()
    get bitmaps() { return this.bitmapIndex; } // db.bitmaps.createBitmap()

    /**
     * Service methods
     */

    async start() {
        debug('Starting SynapsD');
        try {

            // Initialize deleted documents bitmap
            this.deletedDocumentsBitmap = await this.bitmapIndex.createBitmap('internal/gc/deleted');

            // Initialize action bitmaps (TODO: Refactor/Remove)
            this.actionBitmaps = {
                created: await this.bitmapIndex.createBitmap('internal/action/created'),
                updated: await this.bitmapIndex.createBitmap('internal/action/updated'),
                deleted: await this.bitmapIndex.createBitmap('internal/action/deleted'),
            };

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

    restart() {
        this.stop().then(() => this.start());
    }

    isRunning() { return this.#status === 'running'; }

    /**
     * Schema methods
     */

    getSchema(schemaId) { return schemaRegistry.getSchema(schemaId); }
    getDataSchema(schemaId) { return schemaRegistry.getDataSchema(schemaId); }
    hasSchema(schemaId) { return schemaRegistry.hasSchema(schemaId); }
    listSchemas() { return schemaRegistry.listSchemas(); }

    /**
     * Validation methods
     */

    validateDocument(document) {
        if (isDocumentInstance(document)) {
            return this.validateDocumentInstance(document);
        } else if (isDocument(document)) {
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

        try {
            // Get schema class and validate
            const SchemaClass = this.getSchema(document.schema);
            return SchemaClass.validateData(document);
        } catch (error) {
            debug('Data validation error for schema %s:', document.schema, error.message); // More specific debug
            return false;
        }
    }

    /**
     * CRUD methods
     */

    async insertDocument(document, contextSpec = '/', featureBitmapArray = []) {
        if (!document) { throw new Error('Document is required'); }
        if (!Array.isArray(featureBitmapArray)) { featureBitmapArray = [featureBitmapArray]; }
        debug(`insertDocument: Attempting to insert document with contextSpec: ${contextSpec}, features: [${featureBitmapArray.join(', ')}]`);

        let parsedDocument;
        try {
            parsedDocument = this.#parseInitializeDocument(document);
            debug(`insertDocument: Document parsed and initialized. Schema: ${parsedDocument.schema}, ID: ${parsedDocument.id ?? 'Not Set'}`);
        } catch (error) {
            debug(`insertDocument: Failed to parse or initialize document. Error: ${error.message}`);
            // Re-throw the specific parsing/initialization error
            throw new Error(`Failed to parse/initialize document: ${error.message}`);
        }

        const contextBitmapArray = this.#parseContextSpec(contextSpec);
        debug(`insertDocument: Context spec parsed: ${contextBitmapArray}`);

        // Checksum lookup needs to happen *after* parsing/initialization
        const storedDocument = await this.getByChecksumString(parsedDocument.checksumArray[0]);

        // If a checksum already exists, update the document
        if (storedDocument) {
            debug(`insertDocument: Document found by checksum ${parsedDocument.checksumArray[0]}, updating existing document ID: ${storedDocument.id}`);
            // Pass the *original* document data (or instance) and the FOUND storedDocument ID for update
            // NOTE: The updateDocument signature was changed in the previous edit attempt, let's adjust it here too.
            // It now expects (docIdToUpdate, updateData, contextSpec, featureBitmapArray)
            return this.updateDocument(storedDocument.id, document, contextSpec, featureBitmapArray);
        } else {
            debug(`insertDocument: Document not found by checksum ${parsedDocument.checksumArray[0]}, proceeding with new insertion.`);
        }

        // Checksum not found in the index, insert as a new document
        try {
            // Assign ID *only* if it wasn't pre-assigned (e.g., during parsing/init) AND checksum check failed
            if (!parsedDocument.id) {
                parsedDocument.id = this.#generateDocumentID();
                debug(`insertDocument: Generated new document ID: ${parsedDocument.id}`);
            } else {
                 debug(`insertDocument: Using pre-existing ID from parsed document: ${parsedDocument.id}`);
            }

            // Validate the final state before saving
            parsedDocument.validate(); // Validation should happen on the final instance
            debug(`insertDocument: Document validated successfully. ID: ${parsedDocument.id}`);

            // --- Database Operations ---
            await this.documents.put(parsedDocument.id, parsedDocument);
            debug(`insertDocument: Document ${parsedDocument.id} saved to 'documents' dataset.`);

            await this.#checksumIndex.insertArray(parsedDocument.checksumArray, parsedDocument.id);
            debug(`insertDocument: Checksums for document ${parsedDocument.id} added to index.`);

            await this.#timestampIndex.insert('created', parsedDocument.createdAt || new Date().toISOString(), parsedDocument.id);
            if (parsedDocument.updatedAt) {
                await this.#timestampIndex.insert('updated', parsedDocument.updatedAt, parsedDocument.id);
            }
            debug(`insertDocument: Timestamps for document ${parsedDocument.id} added.`);

            // --- Context Tree & Bitmap Updates ---
            this.tree.insertPath(contextBitmapArray.join('/')); // Use the parsed context array
            debug(`insertDocument: Context path '${contextBitmapArray.join('/')}' ensured in tree.`);

            for (const context of contextBitmapArray) {
                await this.contextBitmapCollection.tick(context, parsedDocument.id);
            }
            debug(`insertDocument: Document ${parsedDocument.id} added to context bitmaps: [${contextBitmapArray.join(', ')}]`);


            // If document.schema is not part of featureBitmapArray, add it
            if (!featureBitmapArray.includes(parsedDocument.schema)) {
                featureBitmapArray.push(parsedDocument.schema);
                debug(`insertDocument: Added document schema '${parsedDocument.schema}' to feature list.`);
            }

            for (const feature of featureBitmapArray) {
                await this.bitmapIndex.tick(feature, parsedDocument.id);
            }
            debug(`insertDocument: Document ${parsedDocument.id} added to feature bitmaps: [${featureBitmapArray.join(', ')}]`);
            // --- End Updates ---

            this.emit('documentInserted', { id: parsedDocument.id, document: parsedDocument });
            debug(`insertDocument: Successfully inserted document ID: ${parsedDocument.id}`);
            return parsedDocument.id;
        } catch (error) {
            // Catch errors during DB ops, validation, or indexing
            debug(`insertDocument: Error during insertion process for document (potential ID ${parsedDocument.id}): ${error.message}`, error);
            // Clean up potentially partially inserted data? (More complex, depends on desired atomicity)
            // For now, just re-throw the error after logging.
            throw error;
        }
    }

    async insertDocumentArray(docArray, contextSpec = '/', featureBitmapArray = []) {
        if (!Array.isArray(docArray)) { docArray = [docArray]; }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }

        // Collect errors
        const errors = {};

        // Insert documents
        // TODO: Insert with a batch operation
        for (const doc of docArray) {
            try {
                await this.insertDocument(doc, contextSpec, featureBitmapArray);
            } catch (error) {
                errors.push(error); // doc.id may not be set yet
            }
        }
        return errors;
    }

    async hasDocument(id, contextSpec = '/', featureBitmapArray = []) {
        if (!id) { throw new Error('Document id required'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }
        const contextBitmapArray = this.#parseContextSpec(contextSpec);

        // First check if the document exists in the database
        if (!await this.documents.has(id)) {
            debug(`Document with ID "${id}" not found in the database`);
            return false;
        }

        // If no context or feature filters, document exists
        if (contextBitmapArray.length === 0 && featureBitmapArray.length === 0) {
            return true;
        }

        // Apply context and feature filters
        const contextBitmap = contextBitmapArray.length > 0 ? await this.contextBitmapCollection.AND(contextBitmapArray) : null;
        const featureBitmap = featureBitmapArray.length > 0 ? await this.bitmapIndex.OR(featureBitmapArray) : null;

        // Check if the document matches the filters
        if (contextBitmap && featureBitmap) {
            contextBitmap.andInPlace(featureBitmap);
            return contextBitmap.has(id);
        } else if (contextBitmap) {
            return contextBitmap.has(id);
        } else if (featureBitmap) {
            return featureBitmap.has(id);
        } else {
            return true;
        }
    }

    async hasDocumentByChecksum(checksum, contextSpec = null, featureBitmapArray = []) {
        if (!checksum) { throw new Error('Checksum required'); }

        const id = await this.#checksumIndex.checksumStringToId(checksum);
        if (!id) { return false; }

        return await this.hasDocument(id, contextSpec, featureBitmapArray);
    }

    // Returns documents from the main dataset + context and/or feature bitmaps
    async listDocuments(contextSpec = null, featureBitmapArray = [], filterArray = [], options = { limit: null }) {
        const contextBitmapArray = this.#parseContextSpec(contextSpec);
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }
        if (!Array.isArray(filterArray)) { throw new Error('Filter array must be an array'); }
        debug(`Listing documents with contextSpec: ${contextSpec}, features: ${featureBitmapArray}, filters: ${filterArray}`);

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
            debug('listDocuments: Resulting bitmap is null or empty after applying filters. Returning [].');
            return []; // Return empty array, not all documents
        }

        // Convert bitmap to array of document IDs
        const documentIds = finalDocumentIds;

        // Changed: Get documents one by one to avoid undefined entries
        // TODO: Change to getMany as its faaaaaaaster!
        const documents = [];
        for (const id of documentIds) {
            // Use getById to ensure proper parsing and instantiation
            const doc = await this.getById(id);
            if (doc) {
                // console.log(`DEBUG: Retrieved for ID ${id}:`, typeof doc, doc); // Keep for now if needed
                documents.push(doc);
            }
        }

        // Apply limit if specified
        debug(`listDocuments: Returning ${documents.length} documents`);
        return options.limit ? documents.slice(0, options.limit) : documents;
    }

    // Updates documents in context and/or feature bitmaps
    async updateDocument(docIdentifier, updateDataOrContext = null, contextOrFeatures = null, featureArray = []) {
        let docIdToUpdate;
        let updateData;
        let contextSpec = null;
        let featureBitmapArray = [];

        // --- Argument Parsing ---
        // Case 1: updateDocument(id, updateData, contextSpec, featureBitmapArray)
        if ( (typeof docIdentifier === 'string' || typeof docIdentifier === 'number') &&
             updateDataOrContext !== null && typeof updateDataOrContext === 'object' &&
             (contextOrFeatures === null || typeof contextOrFeatures === 'string' || Array.isArray(contextOrFeatures)) &&
             Array.isArray(featureArray) ) {
            docIdToUpdate = docIdentifier;
            updateData = updateDataOrContext;
            contextSpec = contextOrFeatures;
            featureBitmapArray = featureArray;
             debug(`updateDocument (Case 1): ID=${docIdToUpdate}, Data Provided, Context=${contextSpec}, Features=[${featureBitmapArray.join(',')}]`);
        }
        // Case 2: updateDocument(id, updateData, contextSpec) - features default to []
        else if ( (typeof docIdentifier === 'string' || typeof docIdentifier === 'number') &&
                  updateDataOrContext !== null && typeof updateDataOrContext === 'object' &&
                  (contextOrFeatures === null || typeof contextOrFeatures === 'string' || Array.isArray(contextOrFeatures)) &&
                   featureArray.length === 0 && arguments.length <= 3) { // Check arguments length helps distinguish
            docIdToUpdate = docIdentifier;
            updateData = updateDataOrContext;
            contextSpec = contextOrFeatures;
            // featureBitmapArray defaults to []
             debug(`updateDocument (Case 2): ID=${docIdToUpdate}, Data Provided, Context=${contextSpec}, Features=Default`);
        }
        // Case 3: updateDocument(id, updateData) - context/features default
        else if ( (typeof docIdentifier === 'string' || typeof docIdentifier === 'number') &&
                   updateDataOrContext !== null && typeof updateDataOrContext === 'object' &&
                   arguments.length <= 2) {
            docIdToUpdate = docIdentifier;
            updateData = updateDataOrContext;
             // contextSpec defaults to null, featureBitmapArray defaults to []
             debug(`updateDocument (Case 3): ID=${docIdToUpdate}, Data Provided, Context/Features=Default`);
        }
         // Case 4: updateDocument(id, contextSpec, featureBitmapArray) - updateData needs fetching
         else if ( (typeof docIdentifier === 'string' || typeof docIdentifier === 'number') &&
                   (updateDataOrContext === null || typeof updateDataOrContext === 'string' || Array.isArray(updateDataOrContext)) &&
                   Array.isArray(contextOrFeatures) && arguments.length <= 3) {
             docIdToUpdate = docIdentifier;
             updateData = null; // Signal that data needs fetching
             contextSpec = updateDataOrContext;
             featureBitmapArray = contextOrFeatures;
             debug(`updateDocument (Case 4): ID=${docIdToUpdate}, Data needs fetch, Context=${contextSpec}, Features=[${featureBitmapArray.join(',')}]`);
         }
        // Case 5: updateDocument(id, contextSpec) - data fetch, features default
        else if ( (typeof docIdentifier === 'string' || typeof docIdentifier === 'number') &&
                  (updateDataOrContext === null || typeof updateDataOrContext === 'string' || Array.isArray(updateDataOrContext)) &&
                   arguments.length <= 2) {
             docIdToUpdate = docIdentifier;
             updateData = null; // Signal that data needs fetching
             contextSpec = updateDataOrContext;
             // featureBitmapArray defaults to []
             debug(`updateDocument (Case 5): ID=${docIdToUpdate}, Data needs fetch, Context=${contextSpec}, Features=Default`);
        }
        // Case 6: updateDocument(docObjectOrInstance, contextSpec, featureBitmapArray)
        else if (typeof docIdentifier === 'object' && docIdentifier !== null && (isDocument(docIdentifier) || isDocumentInstance(docIdentifier)) &&
                  (updateDataOrContext === null || typeof updateDataOrContext === 'string' || Array.isArray(updateDataOrContext)) &&
                  Array.isArray(contextOrFeatures) && arguments.length <= 3) {
             let tempParsed = this.#parseInitializeDocument(docIdentifier); // Parse first to get ID and validate structure
             if (!tempParsed.id) throw new Error('updateDocument: Document object/instance provided must have an ID.');
             docIdToUpdate = tempParsed.id;
             updateData = tempParsed; // Use the provided, parsed object as update data
             contextSpec = updateDataOrContext;
             featureBitmapArray = contextOrFeatures;
             debug(`updateDocument (Case 6): Doc Object Provided (ID=${docIdToUpdate}), Context=${contextSpec}, Features=[${featureBitmapArray.join(',')}]`);
        }
        // Case 7: updateDocument(docObjectOrInstance, contextSpec) - features default
         else if (typeof docIdentifier === 'object' && docIdentifier !== null && (isDocument(docIdentifier) || isDocumentInstance(docIdentifier)) &&
                  (updateDataOrContext === null || typeof updateDataOrContext === 'string' || Array.isArray(updateDataOrContext)) &&
                   arguments.length <= 2) {
             let tempParsed = this.#parseInitializeDocument(docIdentifier);
             if (!tempParsed.id) throw new Error('updateDocument: Document object/instance provided must have an ID.');
             docIdToUpdate = tempParsed.id;
             updateData = tempParsed;
             contextSpec = updateDataOrContext;
             // featureBitmapArray defaults to []
              debug(`updateDocument (Case 7): Doc Object Provided (ID=${docIdToUpdate}), Context=${contextSpec}, Features=Default`);
         }
        // Case 8: updateDocument(docObjectOrInstance) - context/features default
        else if (typeof docIdentifier === 'object' && docIdentifier !== null && (isDocument(docIdentifier) || isDocumentInstance(docIdentifier)) &&
                  arguments.length <= 1) {
            let tempParsed = this.#parseInitializeDocument(docIdentifier);
             if (!tempParsed.id) throw new Error('updateDocument: Document object/instance provided must have an ID.');
             docIdToUpdate = tempParsed.id;
             updateData = tempParsed;
            // contextSpec defaults to null, featureBitmapArray defaults to []
             debug(`updateDocument (Case 8): Doc Object Provided (ID=${docIdToUpdate}), Context/Features=Default`);
        }
        // Default/Error Case
        else {
             debug(`updateDocument: Invalid argument combination. docIdentifier type: ${typeof docIdentifier}, updateDataOrContext type: ${typeof updateDataOrContext}, contextOrFeatures type: ${typeof contextOrFeatures}, featureArray type: ${typeof featureArray}, args length: ${arguments.length}`);
            throw new Error('updateDocument: Invalid arguments. Provide ID + optional data/context/features, or a Document object + optional context/features.');
        }
        // --- End Argument Parsing ---

        // --- Validation & Fetching ---
        if (!docIdToUpdate) { throw new Error('updateDocument: Could not determine Document ID for update operation.'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array.'); } // Should be caught by arg parsing, but defensive check

        // Fetch data if it wasn't provided directly
        if (updateData === null) {
             debug(`updateDocument: Fetching existing document data for ID ${docIdToUpdate} as none was provided.`);
            updateData = await this.getById(docIdToUpdate); // Fetch existing data
            if (!updateData) {
                 throw new Error(`updateDocument: Cannot update. Document with ID "${docIdToUpdate}" not found.`);
            }
             debug(`updateDocument: Successfully fetched existing document data for ID ${docIdToUpdate}.`);
        } else {
             // If updateData *was* provided, ensure it's at least a parsed object
             // (If it came from Case 6/7/8, it's already an instance)
             if (!isDocumentInstance(updateData)) {
                 try {
                    // Use parseInitialize to ensure it's valid and has checksums etc.
                    // This is important if the input was just a plain data object.
                    updateData = this.#parseInitializeDocument(updateData);
                     debug(`updateDocument: Provided update data parsed and initialized. Schema: ${updateData.schema}`);
                 } catch (parseError) {
                     throw new Error(`updateDocument: Provided update data is invalid: ${parseError.message}`);
                 }
             }
        }


        const contextBitmapArray = this.#parseContextSpec(contextSpec);
        // Ensure context tree paths exist for the *target* context, even if updating
        if (contextBitmapArray.length > 0) {
            this.tree.insertPath(contextBitmapArray.join('/'));
            debug(`updateDocument: Ensured context path '${contextBitmapArray.join('/')}' exists in tree.`);
        }

        let updatedDocument = null;

        try {
            // --- Fetch Stored Instance ---
            // Get the currently stored document *instance* to compare against and perform the update on
            const storedDocumentInstance = await this.getById(docIdToUpdate);
            if (!storedDocumentInstance) {
                 // This should ideally be caught by the fetch check earlier if updateData was null,
                 // but it's a safety check if somehow ID exists but getById fails later.
                 throw new Error(`updateDocument: Stored document with ID ${docIdToUpdate} disappeared before update could proceed.`);
            }
             debug(`updateDocument: Fetched stored document instance for ID ${docIdToUpdate}. Schema: ${storedDocumentInstance.schema}`);

            // --- Perform Update ---
            // Perform the update using the instance's method.
            // updateData here is guaranteed to be a parsed/initialized document (either fetched or provided)
            updatedDocument = storedDocumentInstance.update(updateData); // Use the BaseDocument's update logic
            debug(`updateDocument: Document instance updated in memory. New checksums: [${updatedDocument.checksumArray.join(', ')}]`);


            // --- Validate and Save ---
            updatedDocument.validate(); // Validate the merged result
            debug(`updateDocument: Updated document ${updatedDocument.id} validated successfully.`);

            await this.documents.put(updatedDocument.id, updatedDocument); // Save the updated instance
             debug(`updateDocument: Updated document ${updatedDocument.id} saved to 'documents' dataset.`);

            // --- Update Checksum Index ---
            // Use checksums from the *original* stored instance for deletion
            await this.#checksumIndex.deleteArray(storedDocumentInstance.checksumArray);
            // Use checksums from the *newly updated* instance for insertion
            await this.#checksumIndex.insertArray(updatedDocument.checksumArray, updatedDocument.id);
            debug(`updateDocument: Checksum index updated for document ${updatedDocument.id}.`);

             // --- Update Timestamp Index ---
             // Always update the 'updated' timestamp on any update
            await this.#timestampIndex.insert('updated', updatedDocument.updatedAt, updatedDocument.id);
            debug(`updateDocument: 'updated' timestamp updated for document ${updatedDocument.id}.`);

        } catch (error) {
            debug(`updateDocument: Error during update process for document ID ${docIdToUpdate}: ${error.message}`, error);
            throw error; // Re-throw after logging
        }

        // --- Context & Feature Bitmap Updates ---
        // Apply context/feature ticks *after* successful data update
        if (contextBitmapArray.length > 0) {
            for (const context of contextBitmapArray) {
                await this.contextBitmapCollection.tick(context, updatedDocument.id);
            }
            debug(`updateDocument: Document ${updatedDocument.id} ticked in context bitmaps: [${contextBitmapArray.join(', ')}]`);
        }

        // Ensure schema is included in features
        if (!featureBitmapArray.includes(updatedDocument.schema)) {
            featureBitmapArray.push(updatedDocument.schema);
             debug(`updateDocument: Added schema '${updatedDocument.schema}' to feature list for update.`);
        }

        if (featureBitmapArray.length > 0) {
            for (const feature of featureBitmapArray) {
                await this.bitmapIndex.tick(feature, updatedDocument.id);
            }
            debug(`updateDocument: Document ${updatedDocument.id} ticked in feature bitmaps: [${featureBitmapArray.join(', ')}]`);
        }
        // --- End Updates ---

        this.emit('documentUpdated', { id: updatedDocument.id, document: updatedDocument });
        debug(`updateDocument: Successfully updated document ID: ${updatedDocument.id}`);
        return updatedDocument.id; // Return the ID of the updated document
    }

    async updateDocumentArray(docArray, contextSpec = null, featureBitmapArray = []) {
        if (!Array.isArray(docArray)) { docArray = [docArray]; }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }

        // Collect errors
        const errors = {};

        // Update documents
        // TODO: Update with a batch operation
        for (const doc of docArray) {
            try {
                await this.updateDocument(doc, contextSpec, featureBitmapArray);
            } catch (error) {
                errors[doc.id] = error;
            }
        }

        return errors;
    }

    // Removes documents from context and/or feature bitmaps
    async removeDocument(docId, contextSpec = null, featureBitmapArray = []) {
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
            return docId;

        } catch (error) {
            // Catch unexpected errors (DB connection, etc.)
            debug(`Error during removeDocument for ID ${docId}: ${error.message}`);
            // Re-throw the error so callers know something went wrong
            throw error;
        }
    }

    async removeDocumentArray(docIdArray, contextSpec = null, featureBitmapArray = []) {
        if (!Array.isArray(docIdArray)) { docIdArray = [docIdArray]; }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }

        // Collect errors
        const errors = {};

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
            const document = this.#parseDocument(documentData);
            debug('deleteDocument > Document: ', document);

            // Delete document from database
            await this.documents.delete(docId);

            // Delete document from all bitmaps
            await this.bitmapIndex.untickAll(docId);

            // Delete document checksums from inverted index
            await this.#checksumIndex.deleteArray(document.checksumArray);

            // Add document ID to deleted documents bitmap
            await this.deletedDocumentsBitmap.tick(docId);

            debug(`Document with ID "${docId}" deleted`);
            return true;
        } catch (error) {
            debug(`Error deleting document ${docId}: `, error);
            return false;
        }
    }

    async deleteDocumentArray(docIdArray) {
        if (!Array.isArray(docIdArray)) { docIdArray = [docIdArray]; }

        // Collect errors
        const errors = {};

        // TODO: Implement batch operation
        for (const id of docIdArray) {
            try {
                await this.deleteDocument(id);
            } catch (error) {
                errors[id] = error;
            }
        }

        return errors;
    }

    /**
     * Convenience methods
     */

    /**
     * Get a document by ID and return a properly instantiated document object
     * @param {string|number} id - Document ID
     * @returns {BaseDocument|null} Document instance or null if not found
     */
    async getById(id) {
        if (!id) { throw new Error('Document id required'); }

        // Get raw document data from database
        const rawDocData = await this.documents.get(id);
        if (!rawDocData) {
            debug(`Document with ID ${id} not found`);
            return null;
        }

        // Return a JS object
        return this.#parseDocument(rawDocData);
    }

    /**
     * Get multiple documents by ID and return properly instantiated document objects
     * @param {Array<string|number>} idArray - Array of document IDs
     * @returns {Array<BaseDocument>} Array of document instances
     */
    async getByIdArray(idArray) {
        if (!Array.isArray(idArray)) { idArray = [idArray]; }

        const documents = [];
        for (const id of idArray) {
            try {
                // Use getById which now properly instantiates document objects
                const doc = await this.getById(id);
                if (doc) {
                    documents.push(doc);
                }
            } catch (error) {
                debug(`Error getting document with ID ${id}: ${error.message}`);
            }
        }
        return documents;
    }

    /**
     * Get a document by checksum string and return a properly instantiated document object
     * @param {string} checksumString - Checksum string
     * @returns {BaseDocument|null} Document instance or null if not found
     */
    async getByChecksumString(checksumString) {
        if (!checksumString) { throw new Error('Checksum string required'); }

        // Get document ID from checksum index
        const id = await this.#checksumIndex.checksumStringToId(checksumString);
        if (!id) { return null; }

        // Use getById which now properly instantiates document objects
        return await this.getById(id);
    }

    /**
     * Get multiple documents by checksum string and return properly instantiated document objects
     * @param {Array<string>} checksumStringArray - Array of checksum strings
     * @returns {Array<BaseDocument>} Array of document instances
     */
    async getByChecksumStringArray(checksumStringArray) {
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

        // Use getByIdArray which now properly instantiates document objects
        return await this.getByIdArray(ids);
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
     * Stateful transactions (used by Contexts)
     */

    createTransaction() {
        debug('Transactions not implemented yet');
        throw new Error('Transactions not implemented yet');
    }

    commitTransaction(id) {
        if (!id) { throw new Error('Transaction ID required'); }
        debug('Transactions not implemented yet');
        throw new Error('Transactions not implemented yet');
    }

    abortTransaction(id) {
        if (!id) { throw new Error('Transaction ID required'); }
        debug('Transactions not implemented yet');
        throw new Error('Transactions not implemented yet');
    }

    listTransactions() {
        debug('Transactions not implemented yet');
        throw new Error('Transactions not implemented yet');
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
        const documentArray = await this.listDocuments(contextSpec, featureBitmapArray, filterArray);
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
        if (!contextSpec) { return ['/']; }
        if (Array.isArray(contextSpec)) { return contextSpec; }
        if (typeof contextSpec === 'string') {
            // If contextSpec includes a /, split it into an array of bitmap keys
            if (contextSpec.includes('/')) {
                return contextSpec.split('/').filter(Boolean);
            } else {
                // Otherwise, it's a single bitmap key
                return [contextSpec];
            }
        } else {
            throw new Error('Invalid contextSpec: Must be a path string starting with /, or an array of bitmap keys.');
        }

    }

    /**
     * Parse a document data object
     * @param {String|Object} documentData - Document data as string or object
     * @returns {Object} Parsed document data object (JSON parsed if string)
     * @private
     */
    #parseDocument(documentData) {
        debug('#parseDocument: Received data type:', typeof documentData);
        if (!documentData) {
            debug('#parseDocument: Error - Document data is required but received falsy value.');
            throw new Error('Document data required');
        }

        let parsedData = documentData;

        if (typeof documentData === 'string') {
            try {
                parsedData = JSON.parse(documentData);
                debug('#parseDocument: JSON parsed successfully.');
            } catch (error) {
                debug(`#parseDocument: Error parsing JSON string: ${error.message}`);
                // Throw a more specific error
                throw new Error(`Invalid JSON data provided: ${error.message}`);
            }
        } else if (typeof documentData === 'object' && documentData !== null) {
             // No parsing needed if it's already an object (and not null)
        } else {
            debug('#parseDocument: Error - Input data is not a string or object:', typeof documentData);
            throw new Error(`Invalid document data type: Expected string or object, got ${typeof documentData}`);
        }

        // Basic sanity check for schema and data properties after potential parsing
        if (typeof parsedData !== 'object' || parsedData === null) {
             // Check if it might be a BaseDocument instance already
             if(!(parsedData instanceof BaseDocument)) {
                 debug('#parseDocument: Error - Parsed data is not a non-null object.');
                 throw new Error('Parsed document data must be a non-null object.');
             } else {
                  debug('#parseDocument: Parsed data appears to be a BaseDocument instance (skipping schema/data check here).');
             }
        } else if (!parsedData.schema || parsedData.data === undefined) {
             // If it's an object, *then* check for schema/data (unless it's already an instance)
             if(!(parsedData instanceof BaseDocument)) {
                 debug('#parseDocument: Error - Parsed object lacks required schema or data property.');
                 throw new Error('Parsed document data must have "schema" and "data" properties.');
             } else {
                  debug('#parseDocument: Parsed data is an instance, skipping schema/data check here.');
             }
        }

        debug('#parseDocument: Returning parsed data.');
        return parsedData;
    }

    /**
     * Initialize a document
     * @param {Object} documentData - Document data object
     * @returns {BaseDocument} Initialized document instance
     * @private
     */
    #initializeDocument(documentData) {
        debug('#initializeDocument: Initializing document. Input type:', typeof documentData, 'Is instance:', isDocumentInstance(documentData));
        if (!documentData || typeof documentData !== 'object') {
            debug('#initializeDocument: Error - Document data must be a non-null object.');
            throw new Error('Document data required for initialization (must be an object)');
        }

        let doc;

        try {
            // Case 1: Already a document instance
            if (isDocumentInstance(documentData)) {
                debug('#initializeDocument: Input is already a Document instance.');
                // Perform validation on the existing instance
                this.validateDocumentInstance(documentData); // This might throw if invalid
                doc = documentData;
                debug('#initializeDocument: Document instance validated.');

            // Case 2: A plain data object that conforms to the basic document structure
            } else if (isDocument(documentData)) {
                debug(`#initializeDocument: Input is a plain data object. Schema: ${documentData.schema}`);
                // Get the schema class for the document
                const Schema = this.getSchema(documentData.schema); // This throws if schema not found
                if (!Schema) { /* Redundant due to getSchema throwing, but belts and suspenders */ throw new Error(`Schema ${documentData.schema} not found`); }
                debug(`#initializeDocument: Found Schema class for ${documentData.schema}.`);

                // Create a document instance *from* the data using the specific class's factory
                doc = Schema.fromData(documentData); // This handles setting defaults, etc.
                debug(`#initializeDocument: Created new Document instance from data. ID: ${doc.id ?? 'Not Set'}, CreatedAt: ${doc.createdAt}. running vaidation..`);

                // It's crucial to validate the *newly created instance*
                doc.validate(); // This uses the instance's validation logic
                debug('#initializeDocument: New Document instance validated.');

            // Case 3: Invalid input type
            } else {
                debug('#initializeDocument: Error - Invalid document data structure. Not an instance and lacks required properties.');
                throw new Error('Invalid document data: must be a BaseDocument instance or a plain object with "schema" and "data" properties.');
            }

            // Ensure checksums are generated *after* potential creation/validation
            if (!doc.checksumArray || doc.checksumArray.length === 0) {
                debug(`#initializeDocument: Generating checksums for document ID: ${doc.id ?? 'Not Set'}.`);
                doc.checksumArray = doc.generateChecksumStrings();
                debug(`#initializeDocument: Checksums generated: [${doc.checksumArray.join(', ')}]`);
            } else {
                debug(`#initializeDocument: Using existing checksums for document ID: ${doc.id ?? 'Not Set'}: [${doc.checksumArray.join(', ')}]`);
            }

        } catch (error) {
            // Catch errors from validation, schema lookup, or checksum generation
            debug(`#initializeDocument: Error during initialization: ${error.message}`, error);
            // Re-throw to be caught by the caller (e.g., #parseInitializeDocument)
            throw new Error(`Document initialization failed: ${error.message}`);
        }

        debug(`#initializeDocument: Initialization complete. Returning document instance. ID: ${doc.id ?? 'Not Set'}, Schema: ${doc.schema}`);
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
            parsedData = this.#parseDocument(documentData);
            debug('#parseInitializeDocument: Document parsed successfully.');

            // Step 2: Initialize the document (creates instance if needed, validates, generates checksums)
            initializedDoc = this.#initializeDocument(parsedData);
            debug('#parseInitializeDocument: Document initialized successfully.');

        } catch (error) {
             // Catch errors from either #parseDocument or #initializeDocument
             debug(`#parseInitializeDocument: Failed during parse/initialize chain: ${error.message}`);
             // Re-throw the error with context
             throw new Error(`Failed to parse and initialize document: ${error.message}`);
        }

        debug('#parseInitializeDocument: Parse and initialization complete. Returning document instance.');
        return initializedDoc; // Return the fully validated and initialized BaseDocument instance
    }

    #documentCount() {
        return this.documents.getCount();
    }

    #generateDocumentID() {
        try {
            // Try to get a recycled ID first
            const recycledId = this.#popDeletedId();
            if (recycledId !== null) {
                debug(`Using recycled document ID: ${recycledId}`);
                return recycledId;
            }

            // Generate a new ID based on the document count
            let count = this.#documentCount();
            // Ensure count is a number
            count = typeof count === 'number' ? count : 0;
            const newId = INTERNAL_BITMAP_ID_MAX + count + 1;
            debug(`Generated new document ID: ${newId}`);
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
            if (!this.deletedDocumentsBitmap || this.deletedDocumentsBitmap.isEmpty()) {
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
            this.deletedDocumentsBitmap.remove(minId);

            return minId;
        } catch (error) {
            debug(`Error popping deleted ID: ${error.message}`);
            return null;
        }
    }

}

export default SynapsD;
