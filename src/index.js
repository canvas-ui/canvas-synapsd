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

        this.deletedDocumentsBitmap = this.bitmapIndex.createBitmap('internal/gc/deleted');

        // Action bitmaps
        // TODO: Refactor || FIX!
        this.actionBitmaps = {
            created: this.bitmapIndex.createBitmap('internal/action/created'),
            updated: this.bitmapIndex.createBitmap('internal/action/updated'),
            deleted: this.bitmapIndex.createBitmap('internal/action/deleted'),
        };

        /**
         * Inverted indexes
         */

        this.#checksumIndex = new ChecksumIndex(this.#db.createDataset('checksums'));
        this.#timestampIndex = new TimestampIndex(
            this.#db.createDataset('timestamps'),
            this.actionBitmaps,
        );

        // TODO: FTS index
        // TODO: Vector index

        /**
         * Collections (TODO: Implement an easy-to-use collection abstraction)
         */

        this.#collections = new Map();

        /**
         * Tree Abstraction
         */

        // Instantiate the Tree view
        this.#tree = new ContextTree({
            documentStore: this.documents,
            metadataStore: this.metadata,
            internalStore: this.system,
            bitmapIndex: this.bitmapIndex,
        });

        this.#treeLayers = this.#tree.layers;

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
    get layers() { return this.#treeLayers; } // db.tree.layers.renameLayer()
    get bitmaps() { return this.bitmapIndex; } // db.bitmapIndex.createBitmap()

    /**
     * Service methods
     */

    async start() {
        debug('Starting SynapsD');
        try {
            // Initialize database backend
            // Initialize index backends

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
            debug('Data validation error:', error);
            return false;
        }
    }

    /**
     * CRUD methods
     */

    async insertDocument(document, contextSpec = null, featureBitmapArray = []) {
        if (!document) { throw new Error('Document is required'); }
        // contextSpec can be a path string (e.g., "/foo/bar") or an array of bitmap keys
        const isPathString = typeof contextSpec === 'string' && contextSpec.startsWith('/');
        const isContextKeyArray = Array.isArray(contextSpec);
        if (contextSpec !== null && !isPathString && !isContextKeyArray) {
            throw new Error('Invalid contextSpec: Must be null, a path string starting with /, or an array of bitmap keys.');
        }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }

        let contextBitmapArray = [];
        if (isPathString) {
            debug(`insertDocument with path: "${contextSpec}"`);
            // Resolve path to keys, create nodes/bitmaps if they don't exist
            // Use the new method that returns context keys directly
            contextBitmapArray = await this.tree.getContextKeysForPath(contextSpec, true);
        } else if (isContextKeyArray) {
            debug('insertDocument with context array:', contextSpec);
            contextBitmapArray = contextSpec; // Use the provided array directly
        } else {
            debug('insertDocument with no context.');
            // Default to root layer if no context specified
            const rootId = this.tree.getRootLayerId();
            if (rootId) {
                debug(`Defaulting document context to root layer ID: ${rootId}`);
                contextBitmapArray = [`context/${rootId}`];
            } else {
                // This should not happen if tree initialization is correct
                debug('Warning: Could not get root layer ID to default context.');
                contextBitmapArray = []; // Proceed with no context
            }
        }

        const parsedDocument = this.#parseInitializeDocument(document);
        const storedDocument = await this.getByChecksumString(parsedDocument.checksumArray[0]);

        // If a checksum already exists, update the document
        if (storedDocument) {
            debug(`insertDocument: Document found by checksum ${parsedDocument.checksumArray[0]}, updating..`);
            return this.updateDocument(storedDocument, contextSpec, featureBitmapArray);
        } else {
            debug(`insertDocument: Document not found by checksum ${parsedDocument.checksumArray[0]}, inserting`);
        }

        // Checksum not found in the index, insert as a new document
        try {
            parsedDocument.id = this.#generateDocumentID(); // If checksum differs, always generate a new ID
            parsedDocument.validate();
            await this.documents.put(parsedDocument.id, parsedDocument);
            await this.#checksumIndex.insertArray(parsedDocument.checksumArray, parsedDocument.id);
            await this.#timestampIndex.insert('created', parsedDocument.createdAt || new Date().toISOString(), parsedDocument.id);
            if (parsedDocument.updatedAt) {
                await this.#timestampIndex.insert('updated', parsedDocument.updatedAt, parsedDocument.id);
            }

            // Update context bitmaps
            if (contextBitmapArray.length > 0) {
                for (const context of contextBitmapArray) {
                    this.bitmapIndex.tickSync(context, parsedDocument.id);
                }
            }

            // If document.schema is not part of featureBitmapArray, add it
            if (!featureBitmapArray.includes(parsedDocument.schema)) {
                featureBitmapArray.push(parsedDocument.schema);
            }

            // Update feature bitmaps
            for (const feature of featureBitmapArray) {
                this.bitmapIndex.tickSync(feature, parsedDocument.id);
            }

            return parsedDocument.id;
        } catch (error) {
            debug(`Error inserting document: ${error.message}`);
            throw error;
        }
    }

    async insertDocumentArray(docArray, contextSpec = null, featureBitmapArray = []) {
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
                errors[doc.id] = error;
            }
        }
        return errors;
    }

    async hasDocument(id, contextSpec = null, featureBitmapArray = []) {
        if (!id) { throw new Error('Document id required'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }

        // First check if the document exists in the database
        if (!await this.documents.has(id)) {
            debug(`Document with ID "${id}" not found in the database`);
            return false;
        }

        // Handle contextSpec - convert to contextBitmapArray
        let contextBitmapArray = [];
        if (contextSpec) {
            const isPathString = typeof contextSpec === 'string' && contextSpec.startsWith('/');
            const isContextKeyArray = Array.isArray(contextSpec);

            if (isPathString) {
                // Convert path to context keys
                contextBitmapArray = await this.tree.getContextKeysForPath(contextSpec, false);
            } else if (isContextKeyArray) {
                contextBitmapArray = contextSpec;
            } else {
                throw new Error('Invalid contextSpec: Must be null, a path string starting with /, or an array of bitmap keys.');
            }
        }

        // If no context or feature filters, document exists
        if (contextBitmapArray.length === 0 && featureBitmapArray.length === 0) {
            return true;
        }

        // Apply context and feature filters
        const contextBitmap = contextBitmapArray.length > 0 ? this.bitmapIndex.AND(contextBitmapArray) : null;
        const featureBitmap = featureBitmapArray.length > 0 ? this.bitmapIndex.OR(featureBitmapArray) : null;

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
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }
        if (!Array.isArray(filterArray)) { throw new Error('Filter array must be an array'); }
        debug(`Listing documents with contextSpec: ${contextSpec}, features: ${featureBitmapArray}, filters: ${filterArray}`);

        // Handle contextSpec - convert to contextBitmapArray
        let contextBitmapArray = [];
        if (contextSpec) {
            const isPathString = typeof contextSpec === 'string' && contextSpec.startsWith('/');
            const isContextKeyArray = Array.isArray(contextSpec);

            if (isPathString) {
                // Convert path to context keys
                debug(`listDocuments: Converting path "${contextSpec}" to context keys`);
                contextBitmapArray = await this.tree.getContextKeysForPath(contextSpec, false);
            } else if (isContextKeyArray) {
                debug('listDocuments: Using provided context array');
                contextBitmapArray = contextSpec;
            } else {
                throw new Error('Invalid contextSpec: Must be null, a path string starting with /, or an array of bitmap keys.');
            }
        }

        // Start with null, will hold RoaringBitmap32 instance if filters are applied
        let resultBitmap = null;
        // Flag to track if any filters actually modified the initial empty bitmap
        let filtersApplied = false;

        // Apply context filters if provided
        if (contextBitmapArray.length > 0) {
            resultBitmap = this.bitmapIndex.AND(contextBitmapArray);
            filtersApplied = true; // AND result assigned
        }

        // Apply feature filters if provided
        if (featureBitmapArray.length > 0) {
            const featureBitmap = this.bitmapIndex.OR(featureBitmapArray);
            if (filtersApplied) { // Check if resultBitmap holds a meaningful value
                resultBitmap.andInPlace(featureBitmap);
            } else {
                resultBitmap = featureBitmap;
                filtersApplied = true; // OR result assigned
            }
        }

        // Apply additional filters if provided
        if (filterArray.length > 0) {
            const filterBitmap = this.bitmapIndex.AND(filterArray);
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
        return options.limit ? documents.slice(0, options.limit) : documents;
    }

    // Updates documents in context and/or feature bitmaps
    async updateDocument(document, contextSpec = null, featureBitmapArray = []) {
        if (!document) { throw new Error('Document required'); }
        if (!document.id) { throw new Error('Document must have an ID for update operations'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }
        debug('updateDocument: ', document);

        // Handle contextSpec - convert to contextBitmapArray
        let contextBitmapArray = [];
        if (contextSpec) {
            const isPathString = typeof contextSpec === 'string' && contextSpec.startsWith('/');
            const isContextKeyArray = Array.isArray(contextSpec);

            if (isPathString) {
                // Convert path to context keys
                debug(`updateDocument: Converting path "${contextSpec}" to context keys`);
                contextBitmapArray = await this.tree.getContextKeysForPath(contextSpec, true);
            } else if (isContextKeyArray) {
                debug('updateDocument: Using provided context array');
                contextBitmapArray = contextSpec;
            } else {
                throw new Error('Invalid contextSpec: Must be null, a path string starting with /, or an array of bitmap keys.');
            }
        }

        const parsedDocument = this.#parseInitializeDocument(document);
        let updatedDocument = null;

        try {
            // Get stored document (now returns a proper document instance)
            const storedDocumentData = await this.getById(parsedDocument.id);
            if (!storedDocumentData) {
                throw new Error(`updateDocument: Document not found based on ID ${parsedDocument.id}`);
            }

            const storedDocument = this.#parseInitializeDocument(storedDocumentData);
            debug('updateDocument > Stored document: ', storedDocument);
            updatedDocument = storedDocument.update(parsedDocument);
            debug('updateDocument > Updated document: ', updatedDocument);

            // Validate and save
            updatedDocument.validate();
            await this.documents.put(updatedDocument.id, updatedDocument);

            // Update checksum index
            await this.#checksumIndex.deleteArray(storedDocument.checksumArray);
            await this.#checksumIndex.insertArray(updatedDocument.checksumArray, updatedDocument.id);
        } catch (error) {
            throw error;
        }

        // Update context bitmaps if provided
        if (contextBitmapArray.length > 0) {
            for (const context of contextBitmapArray) {
                this.bitmapIndex.tickSync(context, updatedDocument.id);
            }
        }

        // If document.schema is not part of featureBitmapArray, add it
        if (!featureBitmapArray.includes(updatedDocument.schema)) {
            featureBitmapArray.push(updatedDocument.schema);
        }

        // Update feature bitmaps if provided
        if (featureBitmapArray.length > 0) {
            for (const feature of featureBitmapArray) {
                this.bitmapIndex.tickSync(feature, updatedDocument.id);
            }
        }

        return updatedDocument;
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

        // Handle contextSpec - convert to contextBitmapArray
        let contextBitmapArray = [];
        if (contextSpec) {
            const isPathString = typeof contextSpec === 'string' && contextSpec.startsWith('/');
            const isContextKeyArray = Array.isArray(contextSpec);

            if (isPathString) {
                // Convert path to context keys
                debug(`removeDocument: Converting path "${contextSpec}" to context keys`);
                contextBitmapArray = await this.tree.getContextKeysForPath(contextSpec, false);
            } else if (isContextKeyArray) {
                debug('removeDocument: Using provided context array');
                contextBitmapArray = contextSpec;
            } else {
                throw new Error('Invalid contextSpec: Must be null, a path string starting with /, or an array of bitmap keys.');
            }
        }

        // Remove document will only remove the document from the supplied bitmaps
        // It will not delete the document from the database.
        if (contextBitmapArray.length > 0) {
            this.bitmapIndex.untickManySync(contextBitmapArray, docId);
        }
        if (featureBitmapArray.length > 0) {
            this.bitmapIndex.untickManySync(featureBitmapArray, docId);
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
            await this.bitmapIndex.delete(docId);

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

    /**
     * Parse a document data object
     * @param {String|Object} documentData - Document data as string or object
     * @returns {Object} Parsed document data object (JSON parsed if string)
     * @private
     */
    #parseDocument(documentData) {
        if (!documentData) { throw new Error('Document data required'); }
        if (typeof documentData === 'string') {
            try {
                documentData = JSON.parse(documentData);
            } catch (error) {
                debug(`Error parsing document data: ${error.message}`);
                throw error;
            }
        }

        return documentData;
    }

    /**
     * Initialize a document
     * @param {Object} documentData - Document data object
     * @returns {BaseDocument} Initialized document instance
     * @private
     */
    #initializeDocument(documentData) {
        if (!documentData) { throw new Error('Document data required'); }
        let doc;

        // If we have a document instance, return it
        if (isDocumentInstance(documentData)) {
            // Validate the document
            this.validateDocumentInstance(documentData);

            doc = documentData;

            // Ensure checksums are generated
            if (!doc.checksumArray || doc.checksumArray.length === 0) {
                doc.checksumArray = doc.generateChecksumStrings();
            }

        // If we have a document data object, create a document instance from it
        } else if (isDocument(documentData)) {
            // Get the schema class for the document
            const Schema = this.getSchema(documentData.schema);
            if (!Schema) { throw new Error(`Schema ${documentData.schema} not found`); }

            // Create a document instance from data
            doc = Schema.fromData(documentData);

            // Ensure checksums are generated
            if (!doc.checksumArray || doc.checksumArray.length === 0) {
                doc.checksumArray = doc.generateChecksumStrings();
            }
        } else {
            throw new Error('Invalid document: must be a document instance or valid document data');
        }

        return doc;
    }

    /**
     * Parse and initialize a document
     * @param {Object} document - Document data or instance to parse
     * @returns {BaseDocument} Initialized document instance
     * @private
     */
    #parseInitializeDocument(documentData) {
        if (!documentData) { throw new Error('Document data required'); }
        let doc;

        // Ensure we are dealing with a JS object
        documentData = this.#parseDocument(documentData);

        // Initialize the document
        doc = this.#initializeDocument(documentData);

        return doc;
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
