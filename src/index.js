'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd');

// DB Backend
import Db from './backends/lmdb/index.js';

// Schemas
import schemaRegistry from './schemas/SchemaRegistry.js';
import { isDocument, isDocumentData } from './schemas/SchemaRegistry.js';
import BaseDocument from './schemas/BaseDocument.js';

// Indexes
import BitmapIndex from './indexes/bitmaps/index.js';
import ChecksumIndex from './indexes/inverted/Checksum.js';
import TimestampIndex from './indexes/inverted/Timestamp.js';

// Constants
const INTERNAL_BITMAP_ID_MIN = 0;
const INTERNAL_BITMAP_ID_MAX = 100000;

/**
 * Simplified SynapsD class
 */

class SynapsD extends EventEmitter {

    #dbBackend = 'lmdb';

    #rootPath;  // Root path of the database
    #db;        // Database backend instance
    #status;    // Status of the database

    #bitmapStore;
    #bitmapCache;


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

        this.#status = 'initializing';
        this.#rootPath = options.rootPath ?? options.path;

        // Initialize database backend
        if (!this.#rootPath) { throw new Error('Database path required'); }
        this.#db = new Db({
            ...options,
            path: this.#rootPath,
        });

        // Document datasets
        this.documents = this.#db.createDataset('documents');
        this.metadata = this.#db.createDataset('metadata');

        /**
         * Bitmap indexes
         */

        this.#bitmapCache = options.bitmapCache ?? new Map();
        this.#bitmapStore = this.#db.createDataset('bitmaps');
        this.bitmapIndex = new BitmapIndex(
            this.#bitmapStore,
            this.#bitmapCache,
        );

        // Deleted documents bitmap
        this.deletedDocumentsBitmap = this.bitmapIndex.createBitmap('internal/gc/deleted');

        // Action bitmaps
        // TODO: Refactor
        this.actionBitmaps = {
            created: this.bitmapIndex.createBitmap('internal/action/created'),
            updated: this.bitmapIndex.createBitmap('internal/action/updated'),
            deleted: this.bitmapIndex.createBitmap('internal/action/deleted'),
        };

        /**
         * Inverted indexes
         */

        this.checksumIndex = new ChecksumIndex(this.#db.createDataset('checksums'));
        this.timestampIndex = new TimestampIndex(
            this.#db.createDataset('timestamps'),
            this.actionBitmaps,
        );

        // TODO: FTS index
        // TODO: Vector index

    }

    /**
     * Getters
     */

    get path() { return this.#rootPath; }
    get stats() {
        return {
            dbBackend: this.#dbBackend,
            dbPath: this.#rootPath,
            status: this.#status,
            documentCount: this.documents.getCount(),
            metadataCount: this.metadata.getCount(),
            bitmapCacheSize: this.#bitmapCache.size,
            bitmapStoreSize: this.#bitmapStore.getCount(),
            checksumIndexSize: this.checksumIndex.getCount(),
            timestampIndexSize: this.timestampIndex.getCount(),
        };
    }

    get status() { return this.#status; }
    get db() { return this.#db; } // Could be useful

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

    validateData(documentData) {
        if (!documentData || typeof documentData !== 'object') {
            debug('Invalid document data:', documentData);
            return false;
        }

        try {
            // Check if schema exists
            if (!this.hasSchema(documentData.schema)) {
                debug(`Schema ${documentData.schema} not found`);
                return false;
            }

            // Get schema class and validate
            const SchemaClass = this.getSchema(documentData.schema);
            return SchemaClass.validateData(documentData);
        } catch (error) {
            debug('Validation error:', error);
            return false;
        }
    }

    validateDocument(document) {
        if (!document || typeof document !== 'object') {
            return false;
        }

        try {
            // Check if schema exists
            if (!this.hasSchema(document.schema)) {
                return false;
            }

            // Get schema class and validate
            const SchemaClass = this.getSchema(document.schema);
            return SchemaClass.validate(document);
        } catch (error) {
            debug('Validation error:', error);
            return false;
        }
    }


    /**
     * CRUD methods
     */

    // TODO: A combined upsert method would be more appropriate here
    async insertDocument(document, contextBitmapArray = [], featureBitmapArray = []) {
        if (!document) { throw new Error('Document is required'); }
        if (!Array.isArray(contextBitmapArray)) { throw new Error('Context array must be an array'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }
        debug('insertDocument: ', document);

        let parsedDocument = this.#parseInitializeDocument(document);
        const storedDocument = await this.getByChecksumString(parsedDocument.checksumArray[0]);

        // If a checksum already exists, update the document
        if (storedDocument) {
            debug(`insertDocument: Document found by checksum ${parsedDocument.checksumArray[0]}, updating..`);
            return this.updateDocument(storedDocument, contextBitmapArray, featureBitmapArray);
        } else {
            debug(`insertDocument: Document not found by checksum ${parsedDocument.checksumArray[0]}, inserting`);
        }

        // Checksum not found in the index, insert as a new document
        try {
            parsedDocument.id = this.#generateDocumentID(); // If checksum differs, always generate a new ID
            parsedDocument.validate();
            await this.documents.put(parsedDocument.id, parsedDocument);
            await this.checksumIndex.insertArray(parsedDocument.checksumArray, parsedDocument.id);
            await this.timestampIndex.insert('created', parsedDocument.createdAt || new Date().toISOString(), parsedDocument.id);
            if (parsedDocument.updatedAt) {
                await this.timestampIndex.insert('updated', parsedDocument.updatedAt, parsedDocument.id);
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

    async insertDocumentArray(docArray, contextBitmapArray = [], featureBitmapArray = []) {
        if (!Array.isArray(docArray)) { docArray = [docArray]; }
        if (!Array.isArray(contextBitmapArray)) { throw new Error('Context array must be an array'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }

        // Collect errors
        let errors = {};

        // Insert documents
        // TODO: Insert with a batch operation
        for (const doc of docArray) {
            try {
                await this.insertDocument(doc, contextBitmapArray, featureBitmapArray);
            } catch (error) {
                errors[doc.id] = error;
            }
        }
        return errors;
    }

    async hasDocument(id, contextBitmapArray = [], featureBitmapArray = []) {
        if (!id) { throw new Error('Document id required'); }
        if (!Array.isArray(contextBitmapArray)) { throw new Error('Context array required'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array required'); }

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
        let contextBitmap = contextBitmapArray.length > 0 ? this.bitmapIndex.AND(contextBitmapArray) : null;
        let featureBitmap = featureBitmapArray.length > 0 ? this.bitmapIndex.OR(featureBitmapArray) : null;

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

    async hasDocumentByChecksum(checksum) {
        if (!checksum) { throw new Error('Checksum required'); }

        let id = await this.checksumIndex.checksumStringToId(checksum);
        if (!id) { return false; }

        return await this.documents.has(id);
    }

    // Returns documents from the main dataset + context and/or feature bitmaps
    async listDocuments(contextBitmapArray = [], featureBitmapArray = [], filterArray = [], options = { limit: null }) {
        if (!Array.isArray(contextBitmapArray)) { throw new Error('Context array must be an array'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }
        if (!Array.isArray(filterArray)) { throw new Error('Filter array must be an array'); }
        debug(`Listing documents with context: ${contextBitmapArray}, features: ${featureBitmapArray}, filters: ${filterArray}`);

        // Initialize result bitmap
        let resultBitmap = null;

        // Apply context filters if provided
        if (contextBitmapArray.length > 0) {
            resultBitmap = this.bitmapIndex.AND(contextBitmapArray);
        }

        // Apply feature filters if provided
        if (featureBitmapArray.length > 0) {
            const featureBitmap = this.bitmapIndex.OR(featureBitmapArray);
            if (resultBitmap) {
                resultBitmap.andInPlace(featureBitmap);
            } else {
                resultBitmap = featureBitmap;
            }
        }

        // Apply additional filters if provided
        if (filterArray.length > 0) {
            const filterBitmap = this.bitmapIndex.AND(filterArray);
            if (resultBitmap) {
                resultBitmap.andInPlace(filterBitmap);
            } else {
                resultBitmap = filterBitmap;
            }
        }

        // If no filters were applied or result is empty, get all documents
        if (!resultBitmap || resultBitmap.isEmpty) {
            // Changed from listEntries to getRange for consistency
            const documents = [];
            for await (const { key, value } of this.documents.getRange()) {
                documents.push(value);
            }
            return options.limit ? documents.slice(0, options.limit) : documents;
        }

        // Convert bitmap to array of document IDs
        const documentIds = Array.from(resultBitmap);

        // Changed: Get documents one by one to avoid undefined entries
        const documents = [];
        for (const id of documentIds) {
            const doc = await this.documents.get(id);
            if (doc) {
                documents.push(doc);
            }
        }

        // Apply limit if specified
        return options.limit ? documents.slice(0, options.limit) : documents;
    }

    // Updates documents in context and/or feature bitmaps
    async updateDocument(document, contextBitmapArray = [], featureBitmapArray = []) {
        if (!document) { throw new Error('Document required'); }
        if (!document.id) { throw new Error('Document must have an ID for update operations'); }
        if (!Array.isArray(contextBitmapArray)) { throw new Error('Context array must be an array'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }
        debug('updateDocument: ', document);

        let parsedDocument = this.#parseInitializeDocument(document);
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
            await this.checksumIndex.deleteArray(storedDocument.checksumArray);
            await this.checksumIndex.insertArray(updatedDocument.checksumArray, updatedDocument.id);
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

    async updateDocumentArray(docArray, contextBitmapArray = [], featureBitmapArray = []) {
        if (!Array.isArray(docArray)) { docArray = [docArray]; }
        if (!Array.isArray(contextBitmapArray)) { throw new Error('Context array must be an array'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }

        // Collect errors
        let errors = {};

        // Update documents
        // TODO: Update with a batch operation
        for (const doc of docArray) {
            try {
                await this.updateDocument(doc, contextBitmapArray, featureBitmapArray);
            } catch (error) {
                errors[doc.id] = error;
            }
        }

        return errors;
    }

    // Removes documents from context and/or feature bitmaps
    async removeDocument(docId, contextBitmapArray = [], featureBitmapArray = []) {
        if (!docId) { throw new Error('Document id required'); }
        if (!Array.isArray(contextBitmapArray)) { throw new Error('Context array must be an array'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }

        // Remove document will only remove the document from the supplied bitmaps
        // It will not delete the document from the database.
        if (contextBitmapArray.length > 0) {
            this.bitmapIndex.untickManySync(contextBitmapArray, docId);
        }
        if (featureBitmapArray.length > 0) {
            this.bitmapIndex.untickManySync(featureBitmapArray, docId);
        }
    }

    async removeDocumentArray(docIdArray, contextBitmapArray = [], featureBitmapArray = []) {
        if (!Array.isArray(docIdArray)) { docIdArray = [docIdArray]; }
        if (!Array.isArray(contextBitmapArray)) { throw new Error('Context array must be an array'); }
        if (!Array.isArray(featureBitmapArray)) { throw new Error('Feature array must be an array'); }

        // Collect errors
        let errors = {};

        // TODO: Implement batch operation
        for (const id of docIdArray) {
            try {
                await this.removeDocument(id, contextBitmapArray, featureBitmapArray);
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
            debug(`deleteDocument > Document: `, document);

            // Delete document from database
            await this.documents.delete(docId);

            // Delete document from all bitmaps
            await this.bitmapIndex.delete(docId);

            // Delete document checksums from inverted index
            await this.checksumIndex.deleteArray(document.checksumArray);

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
        let errors = {};

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
        const id = await this.checksumIndex.checksumStringToId(checksumString);
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
                const id = await this.checksumIndex.checksumStringToId(checksum);
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
     * Bitmap management methods
     */

    createBitmap(id, options = {}) {
        return this.bitmapIndex.createBitmap(id, options);
    }

    listBitmaps(collection) {
        return this.bitmapIndex.listBitmaps(collection);
    }

    getBitmap(id) {
        return this.bitmapIndex.getBitmap(id);
    }

    deleteBitmap(id) {
        return this.bitmapIndex.deleteBitmap(id);
    }

    updateBitmap(id, options = {}) {
        return this.bitmapIndex.updateBitmap(id, options);
    }

    hasBitmap(id) {
        return this.bitmapIndex.hasBitmap(id);
    }

    tickBitmaps(docIdArray, bitmapArray) {
        if (!Array.isArray(docIdArray)) { docIdArray = [docIdArray]; }
        if (!Array.isArray(bitmapArray)) { bitmapArray = [bitmapArray]; }

        for (const bitmapId of bitmapArray) {
            for (const docId of docIdArray) {
                this.bitmapIndex.tickSync(bitmapId, docId);
            }
        }
    }

    untickBitmaps(docIdArray, bitmapArray) {
        if (!Array.isArray(docIdArray)) { docIdArray = [docIdArray]; }
        if (!Array.isArray(bitmapArray)) { bitmapArray = [bitmapArray]; }

        for (const bitmapId of bitmapArray) {
            for (const docId of docIdArray) {
                this.bitmapIndex.untickSync(bitmapId, docId);
            }
        }
    }

    /**
     * Bitmap Collection methods
     */

    createCollection(id, options = {}) {
        return this.bitmapIndex.createCollection(id, options);
    }

    listCollections() {
        return this.bitmapIndex.listCollections();
    }

    getCollection(id) {
        return this.bitmapIndex.getCollection(id);
    }

    updateCollection(id, options = {}) {
        return this.bitmapIndex.updateCollection(id, options);
    }

    deleteCollection(id) {
        return this.bitmapIndex.deleteCollection(id);
    }

    hasCollection(id) {
        return this.bitmapIndex.hasCollection(id);
    }

    /**
     * Internal methods
     */

    /**
     * Parse a document data object
     * @param {Object} documentData - Document data object
     * @returns {Object} Parsed document data object
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

        // Make sure we have a document object
        if (isDocumentData(documentData)) {
            // Get the schema class for the document
            const Schema = this.getSchema(documentData.schema);
            if (!Schema) { throw new Error(`Schema ${documentData.schema} not found`); }

            // Create a document instance from data
            doc = Schema.fromData(documentData);

            // Ensure checksums are generated
            if (!doc.checksumArray || doc.checksumArray.length === 0) {
                doc.checksumArray = doc.generateChecksumStrings();
            }
        } else if (isDocument(documentData)) {
            doc = documentData;

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
