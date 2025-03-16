'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:bitmap-manager');
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Includes
const { RoaringBitmap32 } = require('roaring/RoaringBitmap32');
import Bitmap from './lib/Bitmap.js';
import BitmapCollection from './lib/BitmapCollection.js';

// Constants
const ALLOWED_PREFIXES = [
    'internal/',
    'context/',
    'client/',
    'server/',
    'user/',
    'tag/',
    'data/',
    'nested/',
    'custom/',
];

class BitmapIndex {

    constructor(backingStore, cache = new Map(), options = {}) {
        if (!backingStore) { throw new Error('Backing store required'); }
        this.store = backingStore;
        this.cache = cache;

        // Set range and tag options (used when creating new Bitmaps)
        this.rangeMin = options.rangeMin || 0;
        this.rangeMax = options.rangeMax || 4294967296; // 2^32

        // If an emitter is passed in options, use it; otherwise create a new one.
        this.emitter = options.emitter || new EventEmitter();
        debug(`BitmapIndex initialized with range ${this.rangeMin} - ${this.rangeMax}`);

        // Create a internal bitmap collection
        this.system = this.createCollection('internal');
    }

    /**
     * Collections
     */

    createCollection(collectionName, options = {}) {
        if (!collectionName) { throw new Error('Collection name required'); }
        if (!options.rangeMin) { options.rangeMin = this.rangeMin; }
        if (!options.rangeMax) { options.rangeMax = this.rangeMax; }
        return new BitmapCollection(collectionName, this, options);
    }

    /**
     * Bitmap index operations
     */

    tickSync(key, ids) {
        BitmapIndex._validateKey(key);
        debug('Ticking bitmap key', key, ids);
        const bitmap = this.getBitmap(key, true);
        const idsArray = Array.isArray(ids) ? ids : [ids];

        if (idsArray.length === 0) {
            debug('No IDs to tick for bitmap key', key);
            return bitmap;
        }

        // Ensure all IDs are valid numbers
        const validIds = idsArray.filter(id => {
            const numId = Number(id);
            if (typeof id !== 'number' && (isNaN(numId) || !Number.isInteger(numId) || numId <= 0)) {
                debug(`Invalid ID: ${id}, skipping`);
                return false;
            }
            return true;
        }).map(id => typeof id === 'number' ? id : Number(id));

        if (validIds.length === 0) {
            debug('No valid IDs to tick for bitmap key', key);
            return bitmap;
        }

        bitmap.addMany(validIds);
        this.saveBitmap(key, bitmap);
        this.emitBitmapUpdate(key);
        return bitmap;
    }

    untickSync(key, ids) {
        BitmapIndex._validateKey(key);
        debug('Unticking bitmap key', key, ids);

        const bitmap = this.getBitmap(key, false);
        if (!bitmap) return null;

        const idsArray = Array.isArray(ids) ? ids : [ids];

        if (idsArray.length === 0) {
            debug('No IDs to untick for bitmap key', key);
            return bitmap;
        }

        // Ensure all IDs are valid numbers
        const validIds = idsArray.filter(id => {
            const numId = Number(id);
            if (typeof id !== 'number' && (isNaN(numId) || !Number.isInteger(numId) || numId <= 0)) {
                debug(`Invalid ID: ${id}, skipping`);
                return false;
            }
            return true;
        }).map(id => typeof id === 'number' ? id : Number(id));

        if (validIds.length === 0) {
            debug('No valid IDs to untick for bitmap key', key);
            return bitmap;
        }

        bitmap.removeMany(validIds);

        if (bitmap.isEmpty()) {
            debug('Bitmap is now empty, deleting', key);
            this.deleteBitmap(key);
            return null;
        } else {
            this.saveBitmap(key, bitmap);
            this.emitBitmapUpdate(key);
            return bitmap;
        }
    }

    tickManySync(keyArray, ids) {
        debug('Ticking bitmap keyArray', keyArray, ids);
        const keysArray = Array.isArray(keyArray) ? keyArray : [keyArray];
        const idsArray = Array.isArray(ids) ? ids : [ids];
        let affectedKeys = [];

        if (idsArray.length === 0) {
            debug('No IDs to tick for keyArray', keyArray);
            return affectedKeys;
        }

        // Ensure all IDs are valid numbers
        const validIds = idsArray.filter(id => {
            const numId = Number(id);
            if (typeof id !== 'number' && (isNaN(numId) || !Number.isInteger(numId) || numId <= 0)) {
                debug(`Invalid ID: ${id}, skipping`);
                return false;
            }
            return true;
        }).map(id => typeof id === 'number' ? id : Number(id));

        if (validIds.length === 0) {
            debug('No valid IDs to tick for keyArray', keyArray);
            return affectedKeys;
        }

        // Process keys in batch
        for (const key of keysArray) {
            BitmapIndex._validateKey(key);
            const bitmap = this.getBitmap(key, true);
            bitmap.addMany(validIds);
            this.saveBitmap(key, bitmap);
            affectedKeys.push(key);
        }

        if (affectedKeys.length) { this.emitBitmapUpdate(affectedKeys); }
        return affectedKeys;
    }

    untickManySync(keyArray, ids) {
        debug('Unticking bitmap keyArray', keyArray, ids);
        const keysArray = Array.isArray(keyArray) ? keyArray : [keyArray];
        const idsArray = Array.isArray(ids) ? ids : [ids];
        let affectedKeys = [];

        if (idsArray.length === 0) {
            debug('No IDs to untick for keyArray', keyArray);
            return affectedKeys;
        }

        // Ensure all IDs are valid numbers
        const validIds = idsArray.filter(id => {
            const numId = Number(id);
            if (typeof id !== 'number' && (isNaN(numId) || !Number.isInteger(numId) || numId <= 0)) {
                debug(`Invalid ID: ${id}, skipping`);
                return false;
            }
            return true;
        }).map(id => typeof id === 'number' ? id : Number(id));

        if (validIds.length === 0) {
            debug('No valid IDs to untick for keyArray', keyArray);
            return affectedKeys;
        }

        // Process keys in batch
        for (const key of keysArray) {
            BitmapIndex._validateKey(key);
            const bitmap = this.getBitmap(key, false);
            if (!bitmap) {
                debug(`Bitmap at key "${key}" not found in the persistent store`);
                continue;
            }

            bitmap.removeMany(validIds);
            this.saveBitmap(key, bitmap);
            affectedKeys.push(key);
        }

        if (affectedKeys.length) {
            this.emitBitmapUpdate(affectedKeys);
        }
        return affectedKeys;
    }

    removeSync(key, ids) {
        BitmapIndex._validateKey(key);
        debug('Removing bitmap key', key, ids);

        const bitmap = this.getBitmap(key, false);
        if (!bitmap) {
            debug(`Bitmap at key "${key}" not found in the persistent store`);
            return null;
        }

        const idsArray = Array.isArray(ids) ? ids : [ids];

        if (idsArray.length === 0) {
            debug('No IDs to remove for bitmap key', key);
            return bitmap;
        }

        // Ensure all IDs are valid numbers
        const validIds = idsArray.filter(id => {
            const numId = Number(id);
            if (typeof id !== 'number' && (isNaN(numId) || !Number.isInteger(numId) || numId <= 0)) {
                debug(`Invalid ID: ${id}, skipping`);
                return false;
            }
            return true;
        }).map(id => typeof id === 'number' ? id : Number(id));

        if (validIds.length === 0) {
            debug('No valid IDs to remove for bitmap key', key);
            return bitmap;
        }

        bitmap.removeMany(validIds);

        if (bitmap.isEmpty()) {
            debug('Bitmap is now empty, deleting', key);
            this.deleteBitmap(key);
            return null;
        } else {
            this.saveBitmap(key, bitmap);
            this.emitBitmapUpdate(key);
            return bitmap;
        }
    }

    async delete(id) {
        if (id === undefined || id === null) {
            throw new Error('ID cannot be null or undefined');
        }

        debug(`Deleting object references with ID "${id}" from all bitmaps in collection`);

        try {
            // First fetch all bitmap keys
            const bitmapKeys = await this.listBitmaps();

            if (!bitmapKeys || bitmapKeys.length === 0) {
                debug('No bitmaps found to delete from');
                return [];
            }

            // Then untick the ID for the whole list
            return this.untickManySync(bitmapKeys, id);
        } catch (error) {
            debug(`Error deleting object references with ID "${id}" from all bitmaps in collection`, error);
            throw error; // Re-throw to allow proper error handling upstream
        }
    }

    /**
     * Logical operations
     */

    AND(keyArray) {
        debug(`AND(): keyArray: "${keyArray}"`);
        if (!Array.isArray(keyArray)) { throw new TypeError(`First argument must be an array of bitmap keys, "${typeof keyArray}" given`); }

        // Split positive and negative keys (keys starting with "!" mean NOT)
        const positiveKeys = [];
        const negativeKeys = [];
        for (const key of keyArray) {
            if (key.startsWith('!')) {
                negativeKeys.push(key.slice(1));
            } else {
                positiveKeys.push(key);
            }
        }

        let partial = null;
        if (positiveKeys.length) {
            // Start with the first bitmap
            BitmapIndex._validateKey(positiveKeys[0]);
            partial = this.getBitmap(positiveKeys[0], true).clone();

            // AND with remaining bitmaps
            for (let i = 1; i < positiveKeys.length; i++) {
                BitmapIndex._validateKey(positiveKeys[i]);
                const bitmap = this.getBitmap(positiveKeys[i], true);
                partial.andInPlace(bitmap);
            }
        } else {
            // If no positive keys, start with a full bitmap
            partial = new RoaringBitmap32();
            partial.addRange(this.rangeMin, this.rangeMax);
        }

        if (negativeKeys.length) {
            let negativeUnion = new RoaringBitmap32();
            for (const key of negativeKeys) {
                BitmapIndex._validateKey(key);
                const nbitmap = this.getBitmap(key, false);
                if (nbitmap) {
                    negativeUnion.orInPlace(nbitmap);
                }
            }
            partial.andNotInPlace(negativeUnion);
        }

        return partial || new RoaringBitmap32();
    }

    OR(keyArray) {
        debug(`OR(): keyArray: "${keyArray}"`);
        if (!Array.isArray(keyArray)) {
            throw new TypeError(`First argument must be an array of bitmap keys, "${typeof keyArray}" given`);
        }

        const positiveKeys = [];
        const negativeKeys = [];
        for (const key of keyArray) {
            if (key.startsWith('!')) {
                negativeKeys.push(key.slice(1));
            } else {
                positiveKeys.push(key);
            }
        }

        let result = new RoaringBitmap32();
        for (const key of positiveKeys) {
            BitmapIndex._validateKey(key);
            const bmp = this.getBitmap(key, true);
            result.orInPlace(bmp);
        }

        if (negativeKeys.length) {
            let negativeUnion = new RoaringBitmap32();
            for (const key of negativeKeys) {
                BitmapIndex._validateKey(key);
                const bmp = this.getBitmap(key, false);
                if (bmp) {
                    negativeUnion.orInPlace(bmp);
                }
            }
            result.andNotInPlace(negativeUnion);
        }
        return result;
    }

    XOR(keyArray) {
        debug(`XOR(): keyArray: "${keyArray}"`);
        if (!Array.isArray(keyArray)) {
            throw new TypeError(`First argument must be an array of bitmap keys, "${typeof keyArray}" given`);
        }
        const positiveKeys = [];
        const negativeKeys = [];
        for (const key of keyArray) {
            if (key.startsWith('!')) {
                negativeKeys.push(key.slice(1));
            } else {
                positiveKeys.push(key);
            }
        }

        let result = null;
        for (const key of positiveKeys) {
            BitmapIndex._validateKey(key);
            const bmp = this.getBitmap(key, false);
            if (bmp) {
                result = result ? result.xor(bmp) : bmp.clone();
            }
        }
        result = result || new RoaringBitmap32();

        if (negativeKeys.length) {
            let negativeUnion = new RoaringBitmap32();
            for (const key of negativeKeys) {
                BitmapIndex._validateKey(key);
                const bmp = this.getBitmap(key, false);
                if (bmp) {
                    negativeUnion.orInPlace(bmp);
                }
            }
            result.andNotInPlace(negativeUnion);
        }
        return result;
    }

    /**
     * Utils
     */

    // Validate key (ignoring leading "!" for negation)
    static _validateKey(key) {
        if (!key) {
            throw new Error('Bitmap key cannot be null or undefined');
        }

        const normalizedKey = key.startsWith('!') ? key.slice(1) : key;
        const isValid = ALLOWED_PREFIXES.some(prefix => normalizedKey.startsWith(prefix));
        if (!isValid) {
            throw new Error(`Bitmap key "${key}" does not follow naming convention. Must start with one of: ${ALLOWED_PREFIXES.join(', ')}`);
        }
    }

    // Returns the prefix (with trailing slash) from a key (ignoring possible "!")
    static _getPrefix(key) {
        const normalizedKey = key.startsWith('!') ? key.slice(1) : key;
        return normalizedKey.split('/')[0] + '/';
    }

    // Emit an update event with one or more bitmap keys.
    emitBitmapUpdate(keyOrKeys) {
        if (this.emitter && typeof this.emitter.emit === 'function') {
            const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
            this.emitter.emit('bitmap:update', keys);
        }
    }

    /**
     * Database operations
     */

    getBitmap(key, autoCreateBitmap = false) {
        BitmapIndex._validateKey(key);

        // First check the cache
        if (this.cache.has(key)) {
            debug(`Returning Bitmap key "${key}" from cache`);
            return this.cache.get(key);
        }

        // Then try to load from store
        if (this.hasBitmap(key)) {
            const bitmap = this.loadBitmap(key);
            if (bitmap) {
                return bitmap;
            }
            debug(`Failed to load bitmap "${key}" from store`);
        } else {
            debug(`Bitmap at key "${key}" not found in the persistent store`);
        }

        // If we get here, the bitmap doesn't exist or couldn't be loaded
        if (!autoCreateBitmap) {
            return null;
        }

        // Create a new bitmap
        debug(`Creating new bitmap for key "${key}"`);
        const bitmap = this.createBitmap(key);
        if (!bitmap) {
            throw new Error(`Unable to create bitmap with key ID "${key}"`);
        }

        return bitmap;
    }

    createBitmap(key, oidArrayOrBitmap = []) {
        BitmapIndex._validateKey(key);
        debug(`createBitmap(): Creating bitmap with key ID "${key}"`);

        try {
            // Check if bitmap already exists
            if (this.hasBitmap(key)) {
                debug(`Bitmap with key ID "${key}" already exists`);
                const existingBitmap = this.getBitmap(key);
                if (existingBitmap) {
                    return existingBitmap;
                }
                // If we get here, the bitmap exists but couldn't be loaded
                debug(`Failed to load existing bitmap "${key}", will create a new one`);
            }

            // Parse input data
            const bitmapData = this.#parseInput(oidArrayOrBitmap);

            // Create new bitmap
            const bitmap = new Bitmap(bitmapData, {
                key: key,
                rangeMin: this.rangeMin,
                rangeMax: this.rangeMax,
            });

            // Save to store and cache
            this.saveBitmap(key, bitmap);
            debug(`Bitmap with key ID "${key}" created successfully with ${bitmap.size} elements`);
            return bitmap;
        } catch (error) {
            debug(`Error creating bitmap "${key}"`, error);
            throw new Error(`Failed to create bitmap "${key}": ${error.message}`);
        }
    }

    renameBitmap(oldKey, newKey) {
        BitmapIndex._validateKey(oldKey);
        BitmapIndex._validateKey(newKey);
        debug(`Renaming bitmap "${oldKey}" to "${newKey}"`);

        const bitmap = this.getBitmap(oldKey);
        if (!bitmap) { throw new Error(`Unable to rename bitmap "${oldKey}" to "${newKey}" because bitmap "${oldKey}" does not exist`); }

        this.deleteBitmap(oldKey);
        this.saveBitmap(newKey, bitmap.serialize());
        this.emitBitmapUpdate(newKey);

        return bitmap;
    }

    deleteBitmap(key) {
        BitmapIndex._validateKey(key);
        debug(`Deleting bitmap "${key}"`);
        this.cache.delete(key);
        this.store.del(key);
        if (this.emitter && typeof this.emitter.emit === 'function') {
            this.emitter.emit('bitmap:deleted', key);
        }
    }

    hasBitmap(key) {
        BitmapIndex._validateKey(key);
        return this.store.has(key);
    }

    async listBitmaps(prefix = '') {
        if (prefix) {
            // If prefix provided, use range query
            const keys = [];
            for await (const key of this.store.getKeys({
                start: prefix,
                end: prefix + '\uffff'
            })) {
                if (!key.startsWith('internal/')) {
                    keys.push(key);
                }
            }
            return keys;
        }

        // If no prefix, get all keys except deleted documents
        const keys = [];
        for await (const key of this.store.getKeys()) {
            if (!key.startsWith('internal/')) {
                keys.push(key);
            }
        }
        return keys;
    }

    saveBitmap(key, bitmap) {
        debug('Storing bitmap to persistent store', key);
        if (!key) { throw new Error('Key is required'); }
        if (!bitmap) { throw new Error('Bitmap is required'); }

        try {
            if (!(bitmap instanceof Bitmap)) {
                throw new Error('Bitmap must be an instance of Bitmap');
            }

            const serializedBitmap = bitmap.serialize(true);
            this.store.put(key, serializedBitmap);
            this.cache.set(key, bitmap);
            debug(`Bitmap "${key}" saved successfully with ${bitmap.size} elements`);
        } catch (error) {
            debug(`Error saving bitmap "${key}"`, error);
            throw new Error(`Failed to save bitmap "${key}": ${error.message}`);
        }
    }

    loadBitmap(key) {
        debug(`Loading bitmap with key ID "${key}" from persistent store`);

        try {
            const bitmapData = this.store.get(key);
            if (!bitmapData) {
                debug(`Unable to load bitmap "${key}" from the database`);
                return null;
            }

            // Create a new Bitmap instance with the serialized data
            const bitmap = new Bitmap(bitmapData, {
                key: key,
                rangeMin: this.rangeMin,
                rangeMax: this.rangeMax,
            });

            // Cache the bitmap for future use
            this.cache.set(key, bitmap);
            debug(`Bitmap "${key}" loaded successfully with ${bitmap.size} elements`);

            return bitmap;
        } catch (error) {
            debug(`Error loading bitmap "${key}"`, error);
            // Don't throw here, just return null to allow fallback to creation
            return null;
        }
    }

    batchLoadBitmaps(keyArray) {
        const keys = Array.isArray(keyArray) ? keyArray : [keyArray];
        const bitmaps = [];
        // TODO: Create a initializeBitmap() method that will take a buffer and initialize a bitmap
        // Then use a this.store.getMany() method to load multiple bitmaps with one query
        // Then initialize them into the cache
        // Premature optimization is the root of all evil.
        // Hence the implementation below :)
        for (const key of keys) {
            if (this.cache.has(key)) {
                bitmaps.push(this.cache.get(key));
            } else {
                bitmaps.push(this.loadBitmap(key));
            }
        }
        return bitmaps;
    }

    batchSaveBitmaps(keyArray, bitmapArray) {
        const keys = Array.isArray(keyArray) ? keyArray : [keyArray];
        const bitmaps = Array.isArray(bitmapArray) ? bitmapArray : [bitmapArray];
        for (let i = 0; i < keys.length; i++) {
            this.saveBitmap(keys[i], bitmaps[i]);
        }
    }

    clearCache() {
        this.cache.clear();
    }

    /**
     * Internal methods
     */

    #parseInput(oidArrayOrBitmap) {
        if (!oidArrayOrBitmap) {
            return [];
        }

        if (Array.isArray(oidArrayOrBitmap)) {
            return oidArrayOrBitmap;
        }

        if (oidArrayOrBitmap instanceof RoaringBitmap32) {
            return oidArrayOrBitmap;
        }

        if (typeof oidArrayOrBitmap === 'number') {
            return [oidArrayOrBitmap];
        }

        throw new Error(`Invalid input data type: ${typeof oidArrayOrBitmap}`);
    }

    #loadBitmapsFromStore(bitmapIdArray) {
        if (!Array.isArray(bitmapIdArray)) { bitmapIdArray = [bitmapIdArray]; }
    }

    #saveBitmapsToStore(bitmapIdArray) {
        if (!Array.isArray(bitmapIdArray)) { bitmapIdArray = [bitmapIdArray]; }
    }

    #deleteBitmapsFromStore(bitmapIdArray) {
        if (!Array.isArray(bitmapIdArray)) { bitmapIdArray = [bitmapIdArray]; }
    }

}

export default BitmapIndex;
