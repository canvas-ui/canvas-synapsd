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

        // Main documents dataset
        this.documents = this.#db.createDataset('documents');

        /**
         * Inverted indexes
         */

        this.checksumIndex = new ChecksumIndex({ // sha256/checksum -> id
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

        this.contextBitmaps = this.bitmapIndex.createCollection();
        this.featureBitmaps = this.bitmapIndex.createCollection();
        this.filterBitmaps = this.bitmapIndex.createCollection();
        this.actionBitmaps = this.bitmapIndex.createCollection();

        /**
         * Vector store backend (LanceDB)
         */

        this.vectorStore = null;

        /**
         * Filters
         */

    }

    /**
     * Service
     */

    async start() {
        this.#status = 'running';
    }

    async shutdown() {
        try {
            this.#status = 'shutting down   ';
            await this.#db.close();
            this.#status = 'shutdown';
            debug('SynapsD database closed');
        } catch (error) {
            this.#status = 'error';
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

    get counts() {
        return {
            documents: this.#documentCount(),
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

    }

    async hasDocument(id, contextArray = [], featureArray = []) {
    }

    async hasDocumentByChecksum(checksum) {
    }

    async getDocument(id) { }

    async getDocumentByChecksum(checksum) { }

    async getMetadata(id) { }

    async getMetadataByChecksum(checksum) { }

    async updateDocument(document, contextArray = [], featureArray = []) {

    }

    async removeDocument(id, contextArray = [], featureArray = []) {

    }

    async removeDocumentByChecksum(checksum, contextArray = [], featureArray = []) {
    }

    async deleteDocument(docId) {}

    async deleteDocumentByChecksum(checksum) {
    }


    /**
     * CRUD :: Batch operations
     */

    async insertBatch(documents, contextArray = [], featureArray = []) {
    }

    async getBatch(ids) { }

    async getBatchByChecksums(checksums) { }

    async getMetadataBatch(ids) { }

    async getMetadataBatchByChecksums(checksums) { }

    async updateBatch(documents, contextArray = [], featureArray = []) { }

    async removeBatch(ids, contextArray = [], featureArray = []) { }

    async removeBatchByChecksums(checksums) { }

    async deleteBatch(ids) { }

    async deleteBatchByChecksums(checksums) { }

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
