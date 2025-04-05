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

        debug(`BitmapIndex initialized with range ${this.rangeMin} - ${this.rangeMax}`);
    }

    /**
     * Bitmaps
     */

    createBitmap(key, oidArrayOrBitmap = []) {
        BitmapIndex.validateKey(key);
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
            this.#saveBitmap(key, bitmap);
            debug(`Bitmap with key ID "${key}" created successfully with ${bitmap.size} elements`);
            return bitmap;
        } catch (error) {
            debug(`Error creating bitmap "${key}"`, error);
            throw new Error(`Failed to create bitmap "${key}": ${error.message}`);
        }
    }

    async listBitmaps(prefix = '') {
        if (prefix) {
            // If prefix provided, use range query
            const keys = [];
            for await (const key of this.store.getKeys({
                start: prefix,
                end: prefix + '\uffff',
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

    getBitmap(key, autoCreateBitmap = false) {
        BitmapIndex.validateKey(key);

        // First check the cache
        if (this.cache.has(key)) {
            debug(`Returning Bitmap key "${key}" from cache`);
            return this.cache.get(key);
        }

        // Then try to load from store
        if (this.hasBitmap(key)) {
            const bitmap = this.#loadBitmap(key);
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

    renameBitmap(oldKey, newKey) {
        BitmapIndex.validateKey(oldKey);
        BitmapIndex.validateKey(newKey);
        debug(`Renaming bitmap "${oldKey}" to "${newKey}"`);

        const bitmap = this.getBitmap(oldKey);
        if (!bitmap) { throw new Error(`Unable to rename bitmap "${oldKey}" to "${newKey}" because bitmap "${oldKey}" does not exist`); }

        this.deleteBitmap(oldKey);
        this.#saveBitmap(newKey, bitmap);

        return bitmap;
    }

    deleteBitmap(key) {
        BitmapIndex.validateKey(key);
        debug(`Deleting bitmap "${key}"`);
        this.cache.delete(key);
        this.store.del(key);
    }

    hasBitmap(key) {
        BitmapIndex.validateKey(key);
        return this.store.has(key);
    }

    /**
     * Bitmap index operations
     */

    tickSync(key, ids) {
        BitmapIndex.validateKey(key);
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
        this.#saveBitmap(key, bitmap);
        return bitmap;
    }

    untickSync(key, ids) {
        BitmapIndex.validateKey(key);
        debug('Unticking bitmap key', key, ids);

        const bitmap = this.getBitmap(key, false);
        if (!bitmap) {return null;}

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
            this.#saveBitmap(key, bitmap);
            return bitmap;
        }
    }

    tickManySync(keyArray, ids) {
        debug('Ticking bitmap keyArray', keyArray, ids);
        const keysArray = Array.isArray(keyArray) ? keyArray : [keyArray];
        const idsArray = Array.isArray(ids) ? ids : [ids];
        const affectedKeys = [];

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
            BitmapIndex.validateKey(key);
            const bitmap = this.getBitmap(key, true);
            bitmap.addMany(validIds);
            this.#saveBitmap(key, bitmap);
            affectedKeys.push(key);
        }

        return affectedKeys;
    }

    untickManySync(keyArray, ids) {
        debug('Unticking bitmap keyArray', keyArray, ids);
        const keysArray = Array.isArray(keyArray) ? keyArray : [keyArray];
        const idsArray = Array.isArray(ids) ? ids : [ids];
        const affectedKeys = [];

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
            BitmapIndex.validateKey(key);
            const bitmap = this.getBitmap(key, false);
            if (!bitmap) {
                debug(`Bitmap at key "${key}" not found in the persistent store`);
                continue;
            }

            bitmap.removeMany(validIds);
            this.#saveBitmap(key, bitmap);
            affectedKeys.push(key);
        }

        return affectedKeys;
    }

    async tickMany(keyArray, ids) {
        // Simple async wrapper for now
        return this.tickManySync(keyArray, ids);
    }

    async untickMany(keyArray, ids) {
        // Simple async wrapper for now
        return this.untickManySync(keyArray, ids);
    }

    async applyToMany(sourceKey, targetKeys) {
        BitmapIndex.validateKey(sourceKey);
        debug(`applyToMany(): Applying source "${sourceKey}" to targets: "${targetKeys}"`);

        const sourceBitmap = this.getBitmap(sourceKey, false);
        if (!sourceBitmap || sourceBitmap.isEmpty()) {
            debug(`Source bitmap "${sourceKey}" not found or is empty, nothing to apply.`);
            return [];
        }

        const affectedKeys = [];
        const bitmapsToSave = []; // Collect bitmaps to save in batch if possible

        for (const targetKey of targetKeys) {
            BitmapIndex.validateKey(targetKey);
            // Auto-create target if it doesn't exist when applying
            const targetBitmap = this.getBitmap(targetKey, true);
            const originalSize = targetBitmap.size;

            targetBitmap.orInPlace(sourceBitmap);

            // Only save and mark as affected if there was a change
            if (targetBitmap.size !== originalSize) {
                bitmapsToSave.push(targetBitmap); // Assuming Bitmap instance holds its key internally or we pair it later
                affectedKeys.push(targetKey);
            }
        }

        // Perform batch save (or individual saves if batching isn't implemented in store)
        // Assuming #saveBitmap handles individual saves for now.
        for (const bitmap of bitmapsToSave) {
            // Need the key associated with the bitmap instance for saving
            this.#saveBitmap(bitmap.key, bitmap);
        }

        if (affectedKeys.length) {
            return affectedKeys;
        }
        return affectedKeys;
    }

    async subtractFromMany(sourceKey, targetKeys) {
        BitmapIndex.validateKey(sourceKey);
        debug(`subtractFromMany(): Subtracting source "${sourceKey}" from targets: "${targetKeys}"`);

        const sourceBitmap = this.getBitmap(sourceKey, false);
        if (!sourceBitmap || sourceBitmap.isEmpty()) {
            debug(`Source bitmap "${sourceKey}" not found or is empty, nothing to subtract.`);
            return [];
        }

        const affectedKeys = [];
        const bitmapsToSave = []; // Collect bitmaps to save
        const keysToDelete = []; // Collect keys for empty bitmaps

        for (const targetKey of targetKeys) {
            BitmapIndex.validateKey(targetKey);
            // Do not auto-create target if it doesn't exist when subtracting
            const targetBitmap = this.getBitmap(targetKey, false);
            if (!targetBitmap) {
                debug(`Target bitmap "${targetKey}" not found, skipping subtraction.`);
                continue;
            }

            const originalSize = targetBitmap.size;
            targetBitmap.andNotInPlace(sourceBitmap); // Subtract source from target

            if (targetBitmap.size !== originalSize) {
                 if (targetBitmap.isEmpty()) {
                    debug(`Target bitmap "${targetKey}" is now empty after subtraction, scheduling for deletion.`);
                    keysToDelete.push(targetKey);
                } else {
                    bitmapsToSave.push(targetBitmap);
                }
                affectedKeys.push(targetKey);
            }
        }

        // Perform batch save/delete
        for (const bitmap of bitmapsToSave) {
             this.#saveBitmap(bitmap.key, bitmap);
        }
        for (const key of keysToDelete) {
            this.deleteBitmap(key); // deleteBitmap already handles cache removal and event emission
        }

        // Return all keys that were affected (modified or deleted)
        return affectedKeys;
    }

    removeSync(key, ids) {
        BitmapIndex.validateKey(key);
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
            this.#saveBitmap(key, bitmap);
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
            BitmapIndex.validateKey(positiveKeys[0]);
            const firstBitmap = this.getBitmap(positiveKeys[0], false); // Do NOT auto-create

            // If the first key doesn't exist, the AND result must be empty
            if (!firstBitmap) {
                return new RoaringBitmap32();
            }
            partial = firstBitmap.clone();

            // AND with remaining bitmaps
            for (let i = 1; i < positiveKeys.length; i++) {
                BitmapIndex.validateKey(positiveKeys[i]);
                const bitmap = this.getBitmap(positiveKeys[i], false); // Do NOT auto-create

                // If any subsequent key doesn't exist, the AND result must be empty
                if (!bitmap) {
                    return new RoaringBitmap32();
                }
                partial.andInPlace(bitmap);
            }
        } else {
            // If no positive keys, start with a full bitmap
            partial = new RoaringBitmap32();
            partial.addRange(this.rangeMin, this.rangeMax);
        }

        if (negativeKeys.length) {
            const negativeUnion = new RoaringBitmap32();
            for (const key of negativeKeys) {
                BitmapIndex.validateKey(key);
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

        const result = new RoaringBitmap32();
        for (const key of positiveKeys) {
            BitmapIndex.validateKey(key);
            const bmp = this.getBitmap(key, true);
            result.orInPlace(bmp);
        }

        if (negativeKeys.length) {
            const negativeUnion = new RoaringBitmap32();
            for (const key of negativeKeys) {
                BitmapIndex.validateKey(key);
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
            BitmapIndex.validateKey(key);
            const bmp = this.getBitmap(key, false);
            if (bmp) {
                result = result ? result.xor(bmp) : bmp.clone();
            }
        }
        result = result || new RoaringBitmap32();

        if (negativeKeys.length) {
            const negativeUnion = new RoaringBitmap32();
            for (const key of negativeKeys) {
                BitmapIndex.validateKey(key);
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
    static validateKey(key) {
        if (!key) { throw new Error('Bitmap key cannot be null or undefined'); }
        if (typeof key !== 'string') { throw new Error('Bitmap key must be a string'); }

        const normalizedKey = key.startsWith('!') ? key.slice(1) : key;
        const isValid = ALLOWED_PREFIXES.some(prefix => normalizedKey.startsWith(prefix));
        if (!isValid) {
            throw new Error(`Bitmap key "${key}" does not follow naming convention. Must start with one of: ${ALLOWED_PREFIXES.join(', ')}`);
        }

        return true;
    }

    /**
     * Database operations
     */

    #saveBitmap(key, bitmap) {
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

    #batchSaveBitmaps(keyArray, bitmapArray) {
        const keys = Array.isArray(keyArray) ? keyArray : [keyArray];
        const bitmaps = Array.isArray(bitmapArray) ? bitmapArray : [bitmapArray];
        for (let i = 0; i < keys.length; i++) {
            this.#saveBitmap(keys[i], bitmaps[i]);
        }
    }

    #loadBitmap(key) {
        debug(`Loading bitmap with key ID "${key}" from persistent store`);

        try {
            const bitmapData = this.store.get(key);
            if (!bitmapData) {
                throw new Error(`Bitmap with key ID "${key}" not found in the persistent store`);
            }

            const deserializedBitmap = Bitmap.deserialize(bitmapData, true);

            // Create a new Bitmap instance with the serialized data
            const bitmap = new Bitmap(deserializedBitmap, {
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

    #batchLoadBitmaps(keyArray) {
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
                bitmaps.push(this.#loadBitmap(key));
            }
        }
        return bitmaps;
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

        if (Array.isArray(oidArrayOrBitmap) ||
            oidArrayOrBitmap instanceof Uint32Array ||
            oidArrayOrBitmap instanceof RoaringBitmap32) {
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
