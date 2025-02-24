'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:service');

// DB Backend
import Db from './backends/lmdb/index.js';

// Schemas
import schemaRegistry from './schemas/SchemaRegistry.js';
import BaseDocument from './schemas/BaseDocument.js';
// Indexes
import ChecksumIndex from './indexes/inverted/Checksum.js';
import TimestampIndex from './indexes/inverted/Timestamp.js';
import BitmapIndex from './indexes/bitmaps/index.js';
import VectorIndex from './indexes/vector/index.js';

// Constants
const INTERNAL_BITMAP_ID_MIN = 0;
const INTERNAL_BITMAP_ID_MAX = 100000;

/**
 * SynapsD
 */

class SynapsD extends EventEmitter {

    #db;        // Database backend instance
    #rootPath;  // Root path of the database
    #status;    // Status of the database

    constructor(options = {
        backupOnOpen: false,
        backupOnClose: true,
        compression: true,
        eventEmitterOptions: {},
        // TODO: Add per dataset versioning support to the underlying db backend!
    }) {
        super(options.eventEmitterOptions);
        debug('Initializing Canvas SynapsD');
        debug('DB Options:', options);

        this.#status = 'initializing';

        // Initialize database backend
        if (!options.path) { throw new Error('Database path required'); }
        this.#db = new Db(options);
        this.#rootPath = options.path;

        // Support for custom (presumably in-memory) caching backend (assuming it implements a Map() interface)
        this.cache = options.cache ?? new Map();

        // Main JSON document datasets
        this.documents = this.#db.createDataset('documents');   // If you want to use SynapsD to store JSON documents
        this.metadata = this.#db.createDataset('metadata');    // If you want to use SynapsD for metedata only

        /**
         * Inverted indexes
         */

        this.checksumIndex = new ChecksumIndex({ // algorithm/checksum -> id
            store: this.#db.createDataset('checksums')
        });

        this.timestampIndex = new TimestampIndex({ // timestamp -> id
            store: this.#db.createDataset('timestamps')
        });

        /**
         * Bitmap indexes
         */

        this.bitmapStore = this.#db.createDataset('bitmaps');
        this.bitmapIndex = new BitmapIndex(
            this.bitmapStore,
            this.cache,
        );

        this.deletedDocuments = this.bitmapIndex.createBitmap('internal/deleted'); //.createCollection('gc');
        //this.bActive = this.gc.createBitmap('active');
        //this.bDeleted = this.gc.createBitmap('deleted');
        //this.bFreed = this.gc.createBitmap('freed');

        console.log(this.deletedDocuments.toArray());

        /**
         * Vector store backend (LanceDB)
         */

        this.vectorStore = null;

        /**
         * Filters
         */

        debug('SynapsD initialized');
        debug('Document count:', this.#documentCount());
    }

    /**
     * Service
     */

    async start() {
        this.#status = 'running';
        debug('SynapsD started');
    }

    async shutdown() {
        try {
            this.#status = 'shutting down   ';
            await this.#db.close();
            this.#status = 'shutdown';
            debug('SynapsD database closed');
        } catch (error) {
            this.#status = 'error';
            debug('SynapsD database error', error);
            throw error;
        }
    }

    /**
     * Getters
     */

    get path() { return this.#rootPath; }

    get stats() {
        return {
            // TODO: Implement
        };
    }

    get status() { return this.#status; }

    /**
     * Stateful transactions (used by Contexts)
     */

    createTransaction() {}

    commitTransaction() {}

    abortTransaction() {}


    /**
     * CRUD :: Single document operations
     */

    async insertDocument(document, contextArray = [], featureArray = []) {
        // Validate document
        if (!this.validateDocument(document)) {
            throw new Error('Document validation failed');
        }

        // Check if the document is an instance of BaseDocument, initialize it if so
        if (!(document instanceof BaseDocument)) {
            const Schema = schemaRegistry.getSchema(document.schema);
            document = new Schema(document);
        }

        // Generate checksums before checking existence
        document.checksumArray = document.generateChecksumStrings();

        // If a checksum already exists, update the document
        if (await this.hasDocumentByChecksum(document.checksumArray[0])) {
            debug('Document already exists, updating');
            return await this.updateDocument(document, contextArray, featureArray);
        }

        // Generate a new document ID
        document.id = this.#generateDocumentID();

        // If document.schema is not part of featureArray, add it
        if (!featureArray.includes(document.schema)) {
            featureArray.push(document.schema);
        }

        // Insert a new document into the database
        await this.documents.put(document.id, document);

        // Update context bitmaps
        if (contextArray.length > 0) {
            for (const context of contextArray) {
                await this.bitmapIndex.tickSync(context, document.id);
            }
        }

        // Update feature bitmaps
        if (featureArray.length > 0) {
            for (const feature of featureArray) {
                await this.bitmapIndex.tickSync(feature, document.id);
            }
        }

        // Add checksums to the inverted index
        for (const checksum of document.checksumArray) {
            this.checksumIndex.set(checksum, document.id);
        }

        return document;
    }

    async hasDocument(id, contextArray = [], featureArray = []) {
        if (!id) { throw new Error('Document id required'); }
        if (!Array.isArray(contextArray)) { throw new Error('Context array required'); }
        if (!Array.isArray(featureArray)) { throw new Error('Feature array required'); }

        if (!this.documents.has(id)) { return false; }

        let contextBitmap = contextArray.length > 0 ? this.contextBitmaps.AND(contextArray) : null;
        let featureBitmap = featureArray.length > 0 ? this.featureBitmaps.OR(featureArray) : null;

        if (contextBitmap && featureBitmap) {
            contextBitmap.andInPlace(featureBitmap);
            return contextBitmap.size > 0;
        } else if (contextBitmap) {
            return contextBitmap.size > 0;
        } else if (featureBitmap) {
            return featureBitmap.size > 0;
        } else {
            return true;
        }
    }

    async hasDocumentByChecksum(checksum) {
        if (!checksum) { throw new Error('Checksum required'); }

        let id = await this.checksumStringToId(checksum);
        if (!id) { return false; }

        return await this.documents.has(id);
    }

    async getDocument(id) {
        if (!id) { throw new Error('Document id required'); }
        if (!this.documents.has(id)) { return null; }
        return await this.documents.get(id);
    }

    async getDocumentByChecksum(checksum) {
        if (!checksum) { throw new Error('Checksum required'); }

        let id = await this.checksumStringToId(checksum);
        if (!id) { return null; }

        return await this.getDocument(id);
    }


    async getMetadata(id) { }

    async getMetadataByChecksum(checksum) { }

    async updateDocument(document, contextArray = [], featureArray = []) {
        if (!document) { throw new Error('Document required'); }

        // Validate document
        if (!this.validateDocument(document)) {
            throw new Error('Document validation failed');
        }

        // Validate context and feature arrays
        if (!Array.isArray(contextArray)) { throw new Error('Context array required'); }
        if (!Array.isArray(featureArray)) { throw new Error('Feature array required'); }

        // Ensure document is properly initialized
        if (!(document instanceof BaseDocument)) {
            const Schema = schemaRegistry.getSchema(document.schema);
            document = new Schema(document);
        }

        // If document.schema is not part of featureArray, add it
        if (!featureArray.includes(document.schema)) {
            featureArray.push(document.schema);
        }

        // Ensure document has checksums
        document.checksumArray = document.generateChecksumStrings();

        // Get existing document
        const existingDocument = await this.getDocumentByChecksum(document.checksumArray[0]);
        if (!existingDocument) { throw new Error('Document not found'); }

        // Ensure existing document is properly initialized
        let oldChecksumArray = [];
        if (existingDocument instanceof BaseDocument) {
            oldChecksumArray = existingDocument.checksumArray || [];
        } else {
            const Schema = schemaRegistry.getSchema(existingDocument.schema);
            const existingDoc = new Schema(existingDocument);
            oldChecksumArray = existingDoc.checksumArray || [];
        }

        // Copy the ID from existing document
        document.id = existingDocument.id;

        // Update document in the database
        await this.documents.put(document.id, document);

        // Update checksum index - remove old checksums
        for (const checksum of oldChecksumArray) {
            this.checksumIndex.delete(checksum);
        }

        // Add new checksums
        for (const checksum of document.checksumArray) {
            this.checksumIndex.set(checksum, document.id);
        }

        // Update context bitmaps if provided
        if (contextArray.length > 0) {
            for (const context of contextArray) {
                await this.bitmapIndex.tickSync(context, document.id);
            }
        }

        // Update feature bitmaps if provided
        if (featureArray.length > 0) {
            for (const feature of featureArray) {
                await this.bitmapIndex.tickSync(feature, document.id);
            }
        }

        return document;
    }

    async removeDocument(id, contextArray = [], featureArray = []) {
        if (!id) { throw new Error('Document id required'); }
        if (!Array.isArray(contextArray)) { throw new Error('Context array required'); }
        if (!Array.isArray(featureArray)) { throw new Error('Feature array required'); }

        // Remove document will only remove the document from the supplied bitmaps
        // It will not delete the document from the database.
        if (contextArray.length > 0) {
            this.bitmapIndex.untickManySync(contextArray, id);
        }
        if (featureArray.length > 0) {
            this.bitmapIndex.untickManySync(featureArray, id);
        }
    }

    async removeDocumentByChecksum(checksum, contextArray = [], featureArray = []) {
        let id = await this.checksumStringToId(checksum);
        if (!id) { throw new Error('Document not found'); }
        await this.removeDocument(id, contextArray, featureArray);
    }

    async deleteDocument(id) {
        if (!id) { throw new Error('Document id required'); }
        if (!this.documents.has(id)) { throw new Error('Document not found'); }

        // Mark the document as deleted
        debug(`Deleting document ${id}`);
        await this.deletedDocuments.tick(id);

        // Remove document from all bitmaps
        // TODO: Rework, darn expensive!
        try {
            this.bitmapIndex.deleteSync(id);
        } catch (error) {
            debug('Error deleting document from bitmaps', error);
        }

        // Remove document from the database
        try {
            await this.documents.delete(id);
        } catch (error) {
            debug('Error deleting document from database', error);
        }
    }

    async deleteDocumentByChecksum(checksum) {
        let id = await this.checksumStringToId(checksum);
        if (!id) { throw new Error('Document not found'); }
        await this.deleteDocument(id);
    }


    /**
     * CRUD :: Batch operations
     */

    async insertBatch(documents, contextArray = [], featureArray = []) {
        // TODO: Implement batch insert
        for (const document of documents) {
            await this.insertDocument(document, contextArray, featureArray);
        }
    }

    async getBatch(ids) {
        if (!Array.isArray(ids)) {
            throw new Error('Expected array of ids');
        }

        return await this.documents.getMany(ids);
    }

    async getBatchByChecksums(checksums) {
        if (!Array.isArray(checksums)) {
            throw new Error('Expected array of checksums');
        }

        let ids = await this.checksumStringBatchToIds(checksums);
        return await this.documents.getMany(ids);
    }

    async getMetadataBatch(ids) { }

    async getMetadataBatchByChecksums(checksums) { }

    async updateBatch(documents, contextArray = [], featureArray = []) { }

    async removeBatch(ids, contextArray = [], featureArray = []) {
        ids = Array.isArray(ids) ? ids : [ids];
        for (const id of ids) {
            await this.removeDocument(id, contextArray, featureArray);
        }
    }

    async removeBatchByChecksums(checksums) {
        let ids = await this.checksumStringBatchToIds(checksums);
        for (const id of ids) {
            await this.removeDocument(id);
        }
    }

    async deleteBatch(ids) {
        ids = Array.isArray(ids) ? ids : [ids];
        for (const id of ids) {
            await this.deleteDocument(id);
        }
    }

    async deleteBatchByChecksums(checksums) {
        let ids = await this.checksumStringBatchToIds(checksums);
        for (const id of ids) {
            await this.deleteDocument(id);
        }
    }

    /**
     * Bitmap operations
     */

    async createBitmap(name) {
        return await this.bitmapIndex.createBitmap(name);
    }

    async listBitmaps() {
        return await this.bitmapIndex.listBitmaps();
    }

    async renameBitmap(oldName, newName) {
        return await this.bitmapIndex.renameBitmap(oldName, newName);
    }

    async deleteBitmap(name) {
        return await this.bitmapIndex.deleteBitmap(name);
    }

    async updateBitmaps(ids, contextArray = [], featureArray = []) { }

    async updateContextBitmaps(ids, contextArray) { }

    async updateFeatureBitmaps(ids, featureArray) { }

    async updateFilterBitmaps(ids, filterArray) { }

    // We need to implement the following methods to support Context tree operations:
    // - mergeContextBitmap (apply the current bitmap to an array of bitmaps)
    // - subtractContextBitmap (subtract the current bitmap from an array of bitmaps)
    // - intersectContextBitmap (intersect the current bitmap with an array of bitmaps)
    // - unionContextBitmap (union the current bitmap with an array of bitmaps)
    // - xorContextBitmap (xor the current bitmap with an array of bitmaps)
    // - invertContextBitmap (invert the current bitmap)
    // - isEmptyContextBitmap (check if the current bitmap is empty)
    // - toArrayContextBitmap (convert the current bitmap to an array of ids)
    // - fromArrayContextBitmap (convert an array of ids to a bitmap)
    // - getContextBitmap (get the current bitmap)
    // - setContextBitmap (set the current bitmap)
    // - clearContextBitmap (clear the current bitmap)
    // - deleteContextBitmap (delete the current bitmap)

    // Optional (vanilla) methods:
    // - intersectBitmap (intersect the current bitmap with an array of bitmaps)
    // - unionBitmap (union the current bitmap with an array of bitmaps)
    // - xorBitmap (xor the current bitmap with a array of bitmaps)
    // - invertBitmap (invert the current bitmap)
    // - isEmptyBitmap (check if the current bitmap is empty)
    // - toArrayBitmap (convert the current bitmap to an array of ids)
    // - fromArrayBitmap (convert an array of ids to a bitmap)
    // - getBitmap (get the current bitmap)
    // - setBitmap (set the current bitmap)
    // - clearBitmap (clear the current bitmap)
    // - deleteBitmap (delete the current bitmap)

    /**
     * Query operations
     */

    async listDocuments(contextArray = [], featureArray = [], filterArray = [], options = {}) {
        debug(`Listing documents with context: ${contextArray}, features: ${featureArray}, filters: ${filterArray}`);

        // Initialize result bitmap
        let resultBitmap = null;

        // Apply context filters if provided
        if (contextArray.length > 0) {
            resultBitmap = this.bitmapIndex.AND(contextArray);
        }

        // Apply feature filters if provided
        if (featureArray.length > 0) {
            const featureBitmap = this.bitmapIndex.OR(featureArray);
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

    async findDocuments(query, contextArray = [], featureArray = [], filterArray = [], options = {}) {
        debug(`Finding objects with query: ${query}`);
        // Full-text search (fts) is not implemented in this version.
        // Returning an empty array and letting the application decide on fallback behavior.
        console.warn('Full-text search (fts) is not implemented yet');
        return [];
    }

    /**
     * Schema operations
     */

    listSchemas() { return schemaRegistry.listSchemas(); }

    hasSchema(schemaId) { return schemaRegistry.hasSchema(schemaId); }

    getSchema(schemaId) { return schemaRegistry.getSchema(schemaId); }

    /**
     * Utils
     */

    /**
     * Resolves a checksum string to a document ID
     * @param {string} checksum - Checksum string
     * @returns {Promise<number|null>} Document ID or null if not found
     * @throws {Error} If checksum format is invalid
     */
    async checksumStringToId(checksum) {
        if (typeof checksum !== 'string') {
            throw new Error('Checksum must be a string');
        }
        return await this.checksumIndex.get(checksum);
    }

    /**
     * Resolves an algorithmic checksum to a document ID
     * @param {string} algo - Hash algorithm (e.g., 'sha256')
     * @param {string} checksum - Checksum value
     * @returns {Promise<number|null>} Document ID or null if not found
     * @throws {Error} If inputs are invalid
     */
    async checksumToId(algo, checksum) {
        if (!algo || !checksum) {
            throw new Error('Algorithm and checksum are required');
        }
        return await this.checksumIndex.get(`${algo}/${checksum}`);
    }

    /**
     * Resolves multiple checksums to document IDs
     * @param {string} algo - Hash algorithm
     * @param {string[]} checksums - Array of checksums
     * @returns {Promise<Array<number|null>>} Array of document IDs (null for not found)
     * @throws {Error} If inputs are invalid
     */
    async checksumBatchToIds(algo, checksums) {
        if (!Array.isArray(checksums)) {
            throw new Error('Expected array of checksums');
        }
        return await Promise.all(
            checksums.map(checksum => this.checksumToId(algo, checksum))
        );
    }

    /**
     * Resolves multiple checksum strings to document IDs
     * @param {string[]} checksums - Array of checksum strings
     * @returns {Promise<Array<number|null>>} Array of document IDs (null for not found)
     * @throws {Error} If input is invalid
     */
    async checksumStringBatchToIds(checksums) {
        if (!Array.isArray(checksums)) {
            throw new Error('Expected array of checksums');
        }
        return await Promise.all(
            checksums.map(checksum => this.checksumStringToId(checksum))
        );
    }

    /**
     * Convenience method to get only found IDs from a batch
     * @param {string[]} checksums - Array of checksum strings
     * @returns {Promise<number[]>} Array of found document IDs
     */
    async resolveValidChecksums(checksums) {
        const results = await this.checksumStringBatchToIds(checksums);
        return results.filter(id => id !== null);
    }

    validateDocument(document) {
        if (!document) throw new Error('Document required');
        if (!document.schema) throw new Error('Document schema required');

        const Schema = schemaRegistry.getSchema(document.schema);
        if (!Schema) throw new Error(`Schema "${document.schema}" not found`);

        // Schema validation
        return Schema.validate(document);
    }

    #generateDocumentID() {
        const recycledId = this.deletedDocuments.pop();
        if (recycledId) {
            debug(`Using recycled document ID: ${recycledId}`);
            return recycledId;
        }

        let count = this.#documentCount();
        return INTERNAL_BITMAP_ID_MAX + count + 1;
    }

    #documentCount() {
        let stats = this.documents.getStats();
        return stats.entryCount;
    }

}

export default SynapsD;
