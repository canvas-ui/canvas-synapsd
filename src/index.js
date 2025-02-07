'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import path from 'path';
import debugMessage from 'debug';
const debug = debugMessage('canvas-synapsd');

// DB Backend
import Db from './backends/lmdb/index.js';

// Schemas
import schemaRegistry from './schemas/SchemaRegistry.js';

// Indexes
import ChecksumIndex from './indexes/inverted/Checksum.js';
import TimestampIndex from './indexes/inverted/Timestamp.js';
import BitmapIndex from './indexes/bitmaps/index.js';
import VectorIndex from './indexes/vector/index.js';

// Constants
const INTERNAL_BITMAP_ID_MIN = 0;
const INTERNAL_BITMAP_ID_MAX = 128 * 1024; // 128KB

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

        // Support for custom (presumably in-memory) caching backend (assuming it implements a Map interface)
        this.cache = options.cache ?? new Map();

        // Main JSON document datasets
        this.documents = this.#db.createDataset('documents');
        this.metadata = this.#db.createDataset('metadata');

        /**
         * Inverted indexes
         */

        this.checksumIndex = new ChecksumIndex({ // algorithm/checksum -> id
            store: this.#db.createDataset('checksums'),
            cache: this.cache,
        });

        this.timestampIndex = new TimestampIndex({ // timestamp -> id
            store: this.#db.createDataset('timestamps'),
            cache: this.cache,
        });

        /**
         * Bitmap indexes
         */

        this.bitmapStore = this.#db.createDataset('bitmaps');
        this.bitmapIndex = new BitmapIndex(
            this.bitmapStore,
            this.cache,
        );

        this.gc = this.bitmapIndex.createCollection('gc');
        this.bActive = this.gc.createBitmap('active');
        this.bDeleted = this.gc.createBitmap('deleted');
        this.bFreed = this.gc.createBitmap('freed');

        /**
         * Vector store backend (LanceDB)
         */

        this.vectorStore = null;

        /**
         * Filters
         */

        debug('SynapsD initialized');

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
        this.validateDocument(document);

        // Recalculate checksums
        document.checksumArray = document.generateChecksumStrings();

        // If a checksum already exists, update the document
        if (await this.hasDocumentByChecksum(document.checksumArray[0])) {
            return await this.updateDocument(document, contextArray, featureArray);
        }

        // Generate a new document ID
        document.id = this.#generateDocumentID();

        // Insert a new document into the database
        // TODO: Add versioning support
        await this.documents.put(document.id, document);

        // Update context bitmaps
        if (contextArray.length > 0) {
            this.bitmapIndex.tickMany(document.id, contextArray);
        }

        // Update feature bitmaps
        if (featureArray.length > 0) {
            this.bitmapIndex.tickMany(document.id, featureArray);
        }

        // Update metadata
        await this.metadata.put(document.id, {
            id: document.id,
            created_at: document.created_at,
            updated_at: document.updated_at,
            status: 'active',
        });

        // Return the document
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

        return await this.hasDocument(id);
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
        if (!Array.isArray(contextArray)) { throw new Error('Context array required'); }
        if (!Array.isArray(featureArray)) { throw new Error('Feature array required'); }

        let id = document.id;
        if (!id) { throw new Error('Document id required'); }

        const oldChecksumArray = document.checksumArray;
        document.checksumArray = document.generateChecksumStrings();

        // Check the first checksum to see if it has changed
        if (oldChecksumArray[0] !== document.checksumArray[0]) {
            // Remove old checksums
            for (const checksum of oldChecksumArray) {
                this.checksumIndex.delete(checksum);
            }
            // Add new checksums
            for (const checksum of document.checksumArray) {
                this.checksumIndex.set(checksum, id);
            }
        }

        // Update document in the database
        await this.documents.put(id, document);

        let doc = await this.documents.get(id);
        if (!doc) { throw new Error('Document not found'); }

        // Update context bitmaps if provided
        if (contextArray.length > 0) {
            this.bitmapIndex.tickManySync(contextArray, id);
        }

        // Update feature bitmaps if provided
        if (featureArray.length > 0) {
            this.bitmapIndex.tickManySync(featureArray, id);
        }

        return await this.documents.put(id, doc);
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

        // Its cheaper to maintain a bitmap of deleted documents then to
        // loop through all bitmaps and remove the document from each one.
        this.bDeleted.tick(id);

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

    // timeRange query can be done using the filterArray
    async listDocuments(contextArray = [], featureArray = [], filterArray = [], options = {}) {
        debug(`Listing objects contextArray: ${contextArray} featureArray: ${featureArray} filterArray: ${filterArray}`);
        // Use the context and feature bitmap collections from the BitmapIndex
        let contextBitmap = this.contextBitmaps.AND(contextArray);
        let featureBitmap = this.featureBitmaps.OR(featureArray);

        let res = [];

        if (contextBitmap.isEmpty) {
            res = featureBitmap.toArray();
        } else {
            contextBitmap.andInPlace(featureBitmap);
            res = contextBitmap.toArray();
        }

        // if (filterArray.length > 0) {} // TODO
        if (res.length === 0) { return []; }

        if (options.returnMetadata) {
            res = await Promise.all(res.map(id => this.metadata.get(id)));
        }

        return (options.limit && options.limit > 0) ?
            res.slice(0, options.limit) :
            res;
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
        return Schema.validateData(document);
    }

    #generateDocumentID() {
        let count = this.#documentCount();
        return INTERNAL_BITMAP_ID_MAX + count + 1;
    }

    #documentCount() {
        let stats = this.documents.getStats();
        return stats.entryCount;
    }

}

export default SynapsD;
