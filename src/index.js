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
//import FtsIndex from './lib/FtsIndex.js';
import BitmapIndex from './lib/BitmapIndex.js';
import VectorIndex from '@lancedb/lancedb';

// Constants
const INTERNAL_BITMAP_ID_MAX = 128 * 1024; // 128KB

/**
 * SynapsD
 *
 * ** Simple ** indexing engine for Canvas
 *
 * Context index:
 *  - Bitmaps with explicit AND
 * Feature index:
 *  - Bitmaps with explicit OR, supports AND
 *  - built-in (validated) features:
 *          'data/abstraction/<abstraction>'
 *          'mime/<mime>'
 *          'tag/<tag>'
 *          'system/os/<os>'
 *          'system/device/<device>'
 *          'system/user/<user>'
 *          'action/<action>'
 *  - custom features:
 *          'custom/<your/custom/feature/structure>'
 * Filters:
 *  - Time range
 *  - Regexp
 *  - Fulltext search
 */

class SynapsD extends EventEmitter {

    #db;
    #rootPath;

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

        // Initialize database backend, or use provided instance
        if (options.db && options.db instanceof Db) {
            this.#db = options.db;
            this.#rootPath = this.#db.path;
        } else {
            if (!options.path) { throw new Error('Database path required'); }
            this.#db = new Db(options);
            this.#rootPath = options.path;
        }

        // Support for custom caching backend (assuming it implements a Map interface)
        this.cache = options.cache ?? new Map();

        // Initialize datasets
        this.documents = this.#db.createDataset('documents');
        this.metadata = this.#db.createDataset('metadata');
        this.bitmaps = this.#db.createDataset('bitmaps');

        // Initialize inverted checksum index
        this.hash2id = this.#db.createDataset('checksums'); // sha256/checksum -> id

        /**
         * Indexes
         */

        // FTS index (until we move to something better)
        // For flexsearch, we should switch to Document instead of Index
        // See https://github.com/nextapps-de/flexsearch?tab=readme-ov-file#document.add
        // We should also support a separate FTS index for paths
        /*this.fts = new FtsIndex(this.#db.createDataset('fts'), {
            preset: 'performance',
            tokenize: 'forward',
            cache: true,
        });*/

        // Bitmap indexes
        this.bContexts = new BitmapIndex(
            this.bitmaps.createDataset('contexts'),
            this.cache,
            {
                tag: 'contexts',
                rangeMin: INTERNAL_BITMAP_ID_MAX
            });

        this.bFeatures = new BitmapIndex(
            this.bitmaps.createDataset('features'),
            this.cache,
            {
                tag: 'features',
                rangeMin: INTERNAL_BITMAP_ID_MAX
            });

        this.bFilters = new BitmapIndex(
            this.bitmaps.createDataset('filters'),
            this.cache,
            {
                tag: 'filters',
                rangeMin: INTERNAL_BITMAP_ID_MAX
            });

        // RAG
        this.dChunks = this.#db.createDataset('chunks'); // Useless for now
        this.vEmbeddings = VectorIndex.connect(path.join(options.path, 'embeddings'));

        this.timestamps = this.#db.createDataset('timestamps');

    }

    get path() { return this.#rootPath; }

    /**
     * CRUD operations
     */

    async insertDocument(obj, contextArray = [], featureArray = []) {
        debug('Inserting object to index');

        // Validate and parse object
        await this.#validateObject(obj);
        const document = this.#parseDocument(obj);

        // Insert document to metadata store
        await this.metadata.put(document.id, document);

        // Update checksum index
        for (const [algo, checksum] of document.checksums) {
            await this.#insertChecksum(algo, checksum, document.id);
        }

        // Update bitmaps
        this.bContexts.tickManySync(contextArray, document.id);
        this.bFeatures.tickManySync(featureArray, document.id);

        // Update FTS index
        await this.fts.insert(document.id, document.searchArray);

        debug('Object inserted to index:', document);

        // Emit event
        this.emit('index:insert', document.id);

        // Return document.id
        return document.id;
    }

    async hasDocument(id, contextArray = [], featureArray = []) {
        debug(`Checking if object ID "${id}" exists in index`);

        // Validate ID
        if (!id) { throw new Error('Object ID required'); }

        // Check metadata store
        if (!this.metadata.has(id)) { return false; }

        // Calculate bitmaps
        let contextBitmap = this.bContexts.AND(contextArray);
        let featureBitmap = this.bFeatures.OR(featureArray);
        contextBitmap.andInPlace(featureBitmap);

        // Return result
        return !contextBitmap.isEmpty;
    }

    async getDocument(id) { }

    async getDocumentMetadata(id) {}

    async updateDocument(obj, contextArray = [], featureArray = []) {
        debug('Updating object in index', obj);

        // Validate and parse object
        await this.#validateObject(obj);
        const document = this.#parseDocument(obj);

        // Update document in metadata
        await this.metadata.put(document.id, document);

        // Update checksum index
        for (const [algo, checksum] of document.checksums) {
            await this.#insertChecksum(algo, checksum, document.id);
        }

        // Update bitmaps
        this.bContexts.tickManySync(contextArray, document.id);
        this.bFeatures.tickManySync(featureArray, document.id);

        // Update FTS index
        await this.fts.update(document.id, document.searchArray);

        // Emit event
        this.emit('index:update', document.id);

        // Return document.id
        return document.id;
    }

    async removeDocument(id, contextArray = [], featureArray = []) {
        debug(`Removing object ${id} from bitmap indexes; Context: ${contextArray} Features: ${featureArray}`);
        let document = await this.metadata.get(id);
        if (!document) {
            debug(`Document ${id} not found`);
            return false;
        }

        // Update bitmaps
        if (contextArray.length > 0) { this.bContexts.untickManySync(contextArray, id); }
        if (featureArray.length > 0) { this.bFeatures.untickManySync(featureArray, id); }

        // TODO: Calculate deltas
        this.emit('index:remove', id, { contextArray: contextArray, featureArray: featureArray });

        // Return document.id
        return document.id;
    }

    async deleteDocument(docId) {}

    /**
     * Query operations
     */

    // timeRange query can be done using the filterArray
    async listDocuments(contextArray = [], featureArray = [], filterArray = [], options = {}) {
        debug(`Listing objects contextArray: ${contextArray} featureArray: ${featureArray} filterArray: ${filterArray}`);
        // Bitmap ops always return a bitmap
        let contextBitmap = this.bContexts.AND(contextArray);
        let featureBitmap = this.bFeatures.OR(featureArray);

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
        let ids = await this.fts.search(query);
        if (!ids) { return []; }
        // Compute bitmap intersection
        // Compute filters
        return (options.returnMetadata) ?
            await Promise.all(ids.map(id => this.metadata.get(id))) :
            ids;
    }

    async getMetadata(id) {
        debug(`Getting metadata object ID "${id}"`);

        if (id === null) { throw new Error('Object ID required'); }
        if (!Number.isInteger(id) || id < 0) {
            throw new Error('Object ID must be a non-negative integer');
        }

        // Fetch document
        let document = await this.metadata.get(id);
        if (!document) { return null; }

        return document;
    }

    async getMetadataForChecksum(algo, checksum) {
        debug(`Getting object by checksum ${algo}/${checksum}`);

        // Validate algorithm and checksum
        if (!algo || typeof algo !== 'string') { throw new Error('Algorithm must be a valid string'); }
        if (!checksum || typeof checksum !== 'string') { throw new Error('Checksum must be a valid string'); }

        // Convert checksum to ID
        let id = await this.#checksumToId(algo, checksum);
        if (!id) { return null; }

        // Fetch document by ID
        return this.getMetadata(id);
    }

    listSchemas() {
        return schemaRegistry.listSchemas();
    }

    getSchema(schemaId) {
        return schemaRegistry.getSchema(schemaId);
    }


    /**
     * Utils
     */

    generateObjectID() {
        let count = this.objectCount();
        return INTERNAL_BITMAP_ID_MAX + count + 1;
    }

    objectCount() {
        let stats = this.metadata.getStats();
        return stats.entryCount;
    }

    async #validateObject(obj) {
        if (!obj) { throw new Error('Object required'); }

        // These are generated by the storage backend
        if (!obj.checksums || !obj.checksums.size) {
            throw new Error('Object checksums array required');
        }
        if (!obj.embeddings || !Array.isArray(obj.embeddings)) {
            throw new Error('Object embeddings array required');
        }

        return true;
    }

    #parseDocument(obj) {
        // Return only what we care about
        return {
            id: obj.id || this.generateObjectID(),
            created_at: obj.created_at || new Date().toISOString(),
            updated_at: obj.updated_at || new Date().toISOString(),
            action: obj.action || 'insert',
            checksums: obj.checksums,
            embeddings: obj.embeddings,
            searchArray: obj.searchArray || [],
        };
    }

    async #insertChecksum(algo, checksum, id) {
        return await this.hash2id.put(`${algo}/${checksum}`, id);
    }

    async #checksumToId(algo, checksum) {
        return await this.hash2id.get(`${algo}/${checksum}`);
    }

    async close() {
        await this.#db.close();
        debug('Index database closed');
    }

}

export default SynapsD;
