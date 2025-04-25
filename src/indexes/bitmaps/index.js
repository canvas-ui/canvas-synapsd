'use strict';

// Utils
import debugInstance from 'debug';
const debug = debugInstance('synapsd:index:bitmaps');
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

    constructor(dataset, cache = new Map(), options = {}) {
        if (!dataset) { throw new Error('Backing store dataset required'); }
        this.dataset = dataset;
        this.cache = cache;

        // Set range and tag options (used when creating new Bitmaps)
        // TODO: Currently useless, remove or finish the implementation
        this.rangeMin = options.rangeMin || 0;
        this.rangeMax = options.rangeMax || 4294967296; // 2^32

        // Collections
        this.collections = new Map();

        debug(`BitmapIndex initialized with range ${this.rangeMin} - ${this.rangeMax}`);
    }

    /**
     * Collections
     */

    createCollection(name, options = {}) {
        const collection = new BitmapCollection(name, this, options);
        this.collections.set(name, collection);
        return collection;
    }

    getCollection(name) {
        return this.collections.get(name);
    }

    listCollections() {
        return Array.from(this.collections.values());
    }

    /**
     * Bitmaps CRUD operations
     */

    async createBitmap(key, oidArrayOrBitmap = [], options = {}) {
        BitmapIndex.validateKey(key);
        key = BitmapIndex.normalizeKey(key);
        debug(`createBitmap(): Creating bitmap with key ID "${key}", options: ${JSON.stringify(options)}`);

        try {
            // Check if bitmap already exists
            if (this.hasBitmap(key)) {
                debug(`Bitmap with key ID "${key}" already exists`);
                const existingBitmap = await this.getBitmap(key);
                if (existingBitmap) {
                    return existingBitmap;
                }

                // If we get here, the bitmap exists but couldn't be loaded
                throw new Error(`Failed to load existing bitmap "${key}"`);
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
            await this.#saveBitmap(key, bitmap);
            debug(`Bitmap with key ID "${key}" created successfully with ${bitmap.size} elements`);
            return bitmap;
        } catch (error) {
            debug(`Error creating bitmap "${key}"`, error);
            throw new Error(`Failed to create bitmap "${key}": ${error.message}`);
        }
    }

    async listBitmaps(prefix = '') {
        prefix = BitmapIndex.normalizeKey(prefix);
        if (prefix) {
            // If prefix provided, use range query
            const keys = [];
            for await (const key of this.dataset.getKeys({
                start: prefix + '/',
                end: prefix + '/' + '\uffff',
            })) { keys.push(key); }
            return keys;
        }

        // If no prefix, get all keys except internal ones
        const keys = [];
        for await (const key of this.dataset.getKeys()) {
            if (!key.startsWith('internal/')) { keys.push(key); }
        }
        return keys;
    }

    async getBitmap(key, autoCreateBitmap = false) {
        try {
            BitmapIndex.validateKey(key);
        } catch (error) {
            if (autoCreateBitmap) {
                debug(`Key "${key}" is invalid, but auto-create is enabled. Throwing error.`);
                throw new Error(`Invalid bitmap key "${key}": ${error.message}`);
            } else {
                debug(`Key "${key}" is invalid, returning null`);
                return null;
            }
        }

        key = BitmapIndex.normalizeKey(key);

        // First check the cache
        if (this.cache.has(key)) {
            debug(`Returning Bitmap key "${key}" from cache`);
            return this.cache.get(key);;
        }

        // Then try to load from store
        if (this.hasBitmap(key)) {
            const bitmap = this.#loadBitmapSync(key);
            if (bitmap) {
                return bitmap;
            }
            debug(`Failed to load bitmap "${key}" from store`);
        } else {
            debug(`Bitmap at key "${key}" not found in the persistent store`);
        }

        // If we get here, the bitmap doesn't exist or couldn't be loaded
        if (!autoCreateBitmap) { return null; }

        // Create a new bitmap
        debug(`Creating new bitmap for key "${key}"`);
        const bitmap = await this.createBitmap(key);
        if (!bitmap) {
            throw new Error(`Unable to create bitmap with key ID "${key}"`);
        }

        debug(`Created bitmap type: ${bitmap.constructor.name}`);
        return bitmap;
    }

    async renameBitmap(oldKey, newKey) {
        BitmapIndex.validateKey(oldKey);
        oldKey = BitmapIndex.normalizeKey(oldKey);
        BitmapIndex.validateKey(newKey);
        newKey = BitmapIndex.normalizeKey(newKey);
        debug(`Renaming bitmap "${oldKey}" to "${newKey}"`);

        const bitmap = await this.getBitmap(oldKey);
        if (!bitmap) { throw new Error(`Unable to rename bitmap "${oldKey}" to "${newKey}" because bitmap "${oldKey}" does not exist`); }

        try {
            await this.#saveBitmap(newKey, bitmap);
            await this.deleteBitmap(oldKey);
        } catch (error) {
            debug(`Error renaming bitmap "${oldKey}" to "${newKey}"`, error);
            throw new Error(`Failed to rename bitmap "${oldKey}" to "${newKey}": ${error.message}`);
        }

        return bitmap;
    }

    async deleteBitmap(key) {
        BitmapIndex.validateKey(key);
        key = BitmapIndex.normalizeKey(key);
        debug(`Deleting bitmap "${key}"`);
        this.cache.delete(key);
        try {
            await this.dataset.remove(key);
        } catch (error) {
            debug(`Error deleting bitmap "${key}"`, error);
            throw new Error(`Failed to delete bitmap "${key}": ${error.message}`);
        }

        return true;
    }

    hasBitmap(key) {
        BitmapIndex.validateKey(key);
        key = BitmapIndex.normalizeKey(key);
        return this.dataset.doesExist(key);
    }

    /**
     * Bitmap index operations
     */

    async tick(key, ids) {
        BitmapIndex.validateKey(key);
        key = BitmapIndex.normalizeKey(key);
        debug('Ticking bitmap key', key, ids);

        // Await the bitmap promise
        const bitmap = await this.getBitmap(key, true);
        if (!bitmap) {
            throw new Error(`Unable to create or load bitmap with key ID "${key}"`);
        }

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
        await this.#saveBitmap(key, bitmap);
        return bitmap;
    }

    async untick(key, ids) {
        BitmapIndex.validateKey(key);
        debug('Unticking bitmap key', key, ids);

        const bitmap = await this.getBitmap(key, false);
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
            await this.deleteBitmap(key);
            return null;
        } else {
            await this.#saveBitmap(key, bitmap);
            return bitmap;
        }
    }

    async tickMany(keyArray, ids) {
        debug('Ticking bitmap keyArray', keyArray, ids);
        const keysArray = Array.isArray(keyArray) ? keyArray : [keyArray];
        const idsArray = Array.isArray(ids) ? ids : [ids];
        const affectedKeys = [];

        if (idsArray.length === 0) {
            debug('No IDs to tick for keyArray', keyArray);
            return null;
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
            return null;
        }

        // Process keys in batch
        for (const key of keysArray) {
            BitmapIndex.validateKey(key);
            const bitmap = await this.getBitmap(key, true);
            bitmap.addMany(validIds);
            await this.#saveBitmap(key, bitmap);
            affectedKeys.push(key);
        }

        return affectedKeys;
    }

    async untickMany(keyArray, ids) {
        debug('Unticking bitmap keyArray', keyArray, ids);
        const keysArray = Array.isArray(keyArray) ? keyArray : [keyArray];
        const idsArray = Array.isArray(ids) ? ids : [ids];
        const affectedKeys = [];

        if (idsArray.length === 0) {
            debug('No IDs to untick for keyArray', keyArray);
            return null;
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
            return null;
        }

        // Process keys in batch
        for (const key of keysArray) {
            BitmapIndex.validateKey(key);
            const bitmap = await this.getBitmap(key, false);
            if (!bitmap) {
                debug(`Bitmap at key "${key}" not found in the persistent store`);
                continue;
            }

            bitmap.removeMany(validIds);
            await this.#saveBitmap(key, bitmap);
            affectedKeys.push(key);
        }

        return affectedKeys;
    }

    async untickAll(ids) {
        // Expensive operation, list all bitmaps and untick each one
        return this.untickMany(await this.listBitmaps(), ids);
    }

    // For backward compatibility - these methods simply call the new async versions
    async tickSync(key, ids) {
        console.warn('DEPRECATED: tickSync is deprecated, use tick instead');
        return this.tick(key, ids);
    }

    async untickSync(key, ids) {
        console.warn('DEPRECATED: untickSync is deprecated, use untick instead');
        return this.untick(key, ids);
    }

    async tickManySync(keyArray, ids) {
        console.warn('DEPRECATED: tickManySync is deprecated, use tickMany instead');
        return this.tickMany(keyArray, ids);
    }

    async untickManySync(keyArray, ids) {
        console.warn('DEPRECATED: untickManySync is deprecated, use untickMany instead');
        return this.untickMany(keyArray, ids);
    }

    async applyToMany(sourceKey, targetKeys) {
        BitmapIndex.validateKey(sourceKey);
        debug(`applyToMany(): Applying source "${sourceKey}" to targets: "${targetKeys}"`);

        const sourceBitmap = await this.getBitmap(sourceKey, false);
        if (!sourceBitmap || sourceBitmap.isEmpty()) {
            debug(`Source bitmap "${sourceKey}" not found or is empty, nothing to apply.`);
            return [];
        }

        const affectedKeys = [];
        const bitmapsToSave = []; // Collect bitmaps to save in batch if possible

        for (const targetKey of targetKeys) {
            BitmapIndex.validateKey(targetKey);
            // Auto-create target if it doesn't exist when applying
            const targetBitmap = await this.getBitmap(targetKey, true);
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

        const sourceBitmap = await this.getBitmap(sourceKey, false);
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
            const targetBitmap = await this.getBitmap(targetKey, false);
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

    /**
     * Logical operations
     */

    async AND(keyArray) {
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
            //BitmapIndex.validateKey(positiveKeys[0]);
            const firstBitmap = await this.getBitmap(positiveKeys[0], false); // Do NOT auto-create

            // If the first key doesn't exist, the AND result must be empty
            if (!firstBitmap) {
                debug(`AND(): First bitmap "${positiveKeys[0]}" not found, returning empty bitmap`);
                return new RoaringBitmap32();
            }
            partial = firstBitmap.clone();

            // AND with remaining bitmaps
            for (let i = 1; i < positiveKeys.length; i++) {
                BitmapIndex.validateKey(positiveKeys[i]);
                const bitmap = await this.getBitmap(positiveKeys[i], false); // Do NOT auto-create

                // If any subsequent key doesn't exist, the AND result must be empty
                if (!bitmap) {
                    debug(`AND(): Bitmap "${positiveKeys[i]}" not found, returning empty bitmap`);
                    return new RoaringBitmap32();
                }
                partial.andInPlace(bitmap);
            }
        } else {
            // If no positive keys, start with a full bitmap
            debug(`AND(): No positive keys, starting with a full bitmap`);
            partial = new RoaringBitmap32();
            partial.addRange(this.rangeMin, this.rangeMax);
        }

        if (negativeKeys.length) {
            debug(`AND(): Subtracting negative keys: "${negativeKeys}"`);
            const negativeUnion = new RoaringBitmap32();
            for (const key of negativeKeys) {
                BitmapIndex.validateKey(key);
                const nbitmap = await this.getBitmap(key, false);
                if (nbitmap) {
                    debug(`AND(): Adding negative bitmap "${key}" to union`);
                    negativeUnion.orInPlace(nbitmap);
                }
            }
            debug(`AND(): Subtracting negative union from partial bitmap`);
            partial.andNotInPlace(negativeUnion);
        }

        debug(`AND(): Returning ${partial ? 'partial of size ' + partial.size : 'new RoaringBitmap32()'}`);
        return partial || new RoaringBitmap32();
    }

    async OR(keyArray) {
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
            const bmp = await this.getBitmap(key, true);
            result.orInPlace(bmp);
        }

        if (negativeKeys.length) {
            const negativeUnion = new RoaringBitmap32();
            for (const key of negativeKeys) {
                BitmapIndex.validateKey(key);
                const bmp = await this.getBitmap(key, false);
                if (bmp) {
                    negativeUnion.orInPlace(bmp);
                }
            }
            result.andNotInPlace(negativeUnion);
        }
        return result;
    }

    async XOR(keyArray) {
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
            const bmp = await this.getBitmap(key, false);
            if (bmp) {
                result = result ? result.xor(bmp) : bmp.clone();
            }
        }
        result = result || new RoaringBitmap32();

        if (negativeKeys.length) {
            const negativeUnion = new RoaringBitmap32();
            for (const key of negativeKeys) {
                BitmapIndex.validateKey(key);
                const bmp = await this.getBitmap(key, false);
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

    static normalizeKey(key) {
        if (!key) { return null; }
        if (typeof key !== 'string') { throw new Error('Bitmap key must be a string'); }

        // Replace backslashes with forward slashes
        key = key.replace(/\\/g, '/');

        // Remove all special characters except underscore, dash, exclamation marks and forward slashes
        key = key.replace(/[^a-zA-Z0-9_\-!\/]/g, '');

        // Remove exclamation marks if they are not at the beginning of the key
        if (key.startsWith('!')) {
            key = key.slice(1);
        }

        return key;
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

    /**
     * Database operations
     */

    async #saveBitmap(key, bitmap) {
        debug('Storing bitmap to persistent store', key);
        if (!key) { throw new Error('Key is required'); }
        if (!bitmap) { throw new Error('Bitmap is required'); }

        try {
            if (!(bitmap instanceof Bitmap)) {
                throw new Error('Bitmap must be an instance of Bitmap');
            }

            const serializedBitmap = bitmap.serialize(true);
            this.dataset.put(key, serializedBitmap);
            this.cache.set(key, bitmap);
            debug(`Bitmap "${key}" saved successfully with ${bitmap.size} elements`);
        } catch (error) {
            debug(`Error saving bitmap "${key}"`, error);
            throw new Error(`Failed to save bitmap "${key}": ${error.message}`);
        }
    }

    async #batchSaveBitmaps(keyArray, bitmapArray) {
        const keys = Array.isArray(keyArray) ? keyArray : [keyArray];
        const bitmaps = Array.isArray(bitmapArray) ? bitmapArray : [bitmapArray];
        for (let i = 0; i < keys.length; i++) {
            await this.#saveBitmap(keys[i], bitmaps[i]);
        }
    }

    #loadBitmapSync(key) { // LMDB get() is sync
        debug(`Loading bitmap with key ID "${key}" from persistent store`);

        try {
            const bitmapData = this.dataset.get(key);
            if (!bitmapData) {
                throw new Error(`Bitmap with key ID "${key}" not found in the persistent store`);
            }

            // First deserialize into a RoaringBitmap32
            const roaring = RoaringBitmap32.deserialize(bitmapData, true);
            debug(`Deserialized bitmap data type: ${roaring.constructor.name}`);

            // Create a fresh Bitmap instance
            const bitmap = new Bitmap(roaring, {
                key: key,
                rangeMin: this.rangeMin,
                rangeMax: this.rangeMax,
            });

            // Verify that the bitmap has the required methods
            debug(`New bitmap instance type: ${bitmap.constructor.name}, has addMany: ${typeof bitmap.addMany === 'function'}`);

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

    #batchLoadBitmapsSync(keyArray) {
        const keys = Array.isArray(keyArray) ? keyArray : [keyArray];
        const bitmaps = [];
        // TODO: Create a initializeBitmap() method that will take a buffer and initialize a bitmap
        // Then use a this.dataset.getMany() method to load multiple bitmaps with one query
        // Then initialize them into the cache
        // Premature optimization is the root of all evil.
        // Hence the implementation below :)
        for (const key of keys) {
            if (this.cache.has(key)) {
                bitmaps.push(this.cache.get(key));
            } else {
                bitmaps.push(this.#loadBitmapSync(key));
            }
        }
        return bitmaps;
    }

}

export default BitmapIndex;
