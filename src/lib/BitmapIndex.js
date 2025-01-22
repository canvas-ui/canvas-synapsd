import RoaringBitmap32 from 'roaring';
import Bitmap from './Bitmap.js';
import { uuid12 } from './utils.js';
import debug from 'debug';
const log = debug('canvas:synapsdb:BitmapCollection');

class BitmapIndex {

    constructor(store = new Map(), cache = new Map(), options = {
        tag: uuid12(),
        rangeMin: 0,
        rangeMax: 4294967296, // 2^32
    }) {
        this.store = store;
        this.cache = cache;
        this.rangeMin = options.rangeMin;
        this.rangeMax = options.rangeMax || 4294967296; // 2^32
        this.tag = options.tag;
        log(`BitmapIndex "${this.tag}" initialized with rangeMin: ${this.rangeMin}, rangeMax: ${this.rangeMax}`);
    }

    /**
     * Bitmap index operations
     */

    tickSync(key, ids) {
        log('Ticking', key, ids);
        const bitmap = this.getBitmap(key, true);
        bitmap.addMany(Array.isArray(ids) ? ids : [ids]);
        this.saveBitmap(key, bitmap);
        return bitmap;
    }

    untickSync(key, ids) {
        log('Unticking', key, ids);
        const bitmap = this.getBitmap(key, false);
        if (!bitmap) return null;
        bitmap.removeMany(Array.isArray(ids) ? ids : [ids]);
        this.saveBitmap(key, bitmap);
        return bitmap;
    }

    tickManySync(keyArray, ids) {
        log('Ticking many', keyArray, ids);
        // TODO: Replace with batch operation
        return keyArray.map(key => this.tickSync(key, ids));
    }

    untickManySync(keyArray, ids) {
        log('Unticking many', keyArray, ids);
        // TODO: Replace with batch operation
        return keyArray.map(key => this.untickSync(key, ids));
    }

    removeSync(key, ids) {
        log('Removing', key, ids);
        const bitmap = this.getBitmap(key, false);
        if (!bitmap) return null;
        bitmap.removeMany(Array.isArray(ids) ? ids : [ids]);
        this.saveBitmap(key, bitmap);
        return bitmap;
    }

    deleteSync(id) {
        log(`Deleting object references with ID "${id}" from all bitmaps in collection`);
        for (const key of this.listBitmaps()) {
            this.remove(key, id);
        }
    }

    /**
     * Logical operations
     */

    AND(keyArray) {
        log(`${this.tag} -> AND(): keyArray: "${keyArray}"`);
        if (!Array.isArray(keyArray)) {throw new TypeError(`First argument must be an array of bitmap keys, "${typeof keyArray}" given`);}

        let partial = null;
        for (const key of keyArray) {
            const bitmap = this.getBitmap(key, true);

            // Initialize partial with the first non-empty bitmap
            if (!partial) {
                partial = bitmap;
                continue;
            }
            // Perform AND operation
            partial.andInPlace(bitmap);
        }

        // Return partial or an empty roaring bitmap
        return partial || new RoaringBitmap32();
    }

    OR(keyArray) {
        log(`${this.tag} -> OR(): keyArray: "${keyArray}"`);
        if (!Array.isArray(keyArray)) {throw new TypeError(`First argument must be an array of bitmap keys, "${typeof keyArray}" given`);}
        // Filter out invalid bitmaps, for OR we are pretty tolerant (for now at least)
        const validBitmaps = keyArray.map(key => this.getBitmap(key)).filter(Boolean);
        return validBitmaps.length ? RoaringBitmap32.orMany(validBitmaps) : new RoaringBitmap32();
    }

    XOR(keyArray) {
        log(`${this.tag} -> XOR(): keyArray: "${keyArray}"`);
        if (!Array.isArray(keyArray)) {
            throw new TypeError(`First argument must be an array of bitmap keys, "${typeof keyArray}" given`);
        }

        const validBitmaps = [];
        for (const key of keyArray) {
            const bitmap = this.getBitmap(key, false);
            if (bitmap && bitmap instanceof Bitmap && !bitmap.isEmpty()) {
                validBitmaps.push(bitmap);
            }
        }

        return validBitmaps.length > 0
            ? RoaringBitmap32.xorMany(validBitmaps)
            : new RoaringBitmap32();
    }

    /**
     * Utils
     */

    getBitmap(key, autoCreateBitmap = false) {
        log('Getting bitmap', key, 'autoCreateBitmap:', autoCreateBitmap);
        if (this.cache.has(key)) {
            log(`Returning Bitmap key "${key}" from cache`);
            return this.cache.get(key);
        }

        // Load from store
        if (this.hasBitmap(key)) { return this.loadBitmap(key); }

        log(`Bitmap at key ${key} not found in the persistent store`);
        if (!autoCreateBitmap) { return null; }

        let bitmap = this.createBitmap(key);
        if (!bitmap) {throw new Error(`Unable to create bitmap with key ID "${key}"`);}

        return bitmap;
    }

    createBitmap(key, oidArrayOrBitmap = null) {
        log(`${this.tag} -> createBitmap(): Creating bitmap with key ID "${key}"`);

        if (this.hasBitmap(key)) {
            log(`Bitmap with key ID "${key}" already exists`);
            return false;
        }

        const bitmapData = this.#parseInput(oidArrayOrBitmap);
        const bitmap = new Bitmap(bitmapData, {
            type: 'static',
            key: key,
            rangeMin: this.rangeMin,
            rangeMax: this.rangeMax,
        });

        this.saveBitmap(key, bitmap);
        log(`Bitmap with key ID "${key}" created successfully`);
        return bitmap;
    }

    renameBitmap(oldKey, newKey) {
        log(`Renaming bitmap "${oldKey}" to "${newKey}"`);
        const bitmap = this.getBitmap(oldKey);
        if (!bitmap) { return null; }
        this.deleteBitmap(oldKey);
        this.saveBitmap(newKey, bitmap.serialize());
        return bitmap;
    }

    deleteBitmap(key) {
        log(`Deleting bitmap "${key}"`);
        this.cache.delete(key);
        this.store.del(key);
    }

    hasBitmap(key) {
        return this.store.has(key);
    }

    listBitmaps() {
        let bitmapList = [];
        for (const key of this.store.getKeys()) {
            bitmapList.push(key);
        }
        return bitmapList;
    }

    saveBitmap(key, bitmap) {
        log('Storing bitmap to persistent store', key);
        if (!key) { throw new Error('Key is required'); }
        if (!bitmap) { throw new Error('Bitmap is required'); }
        if (!(bitmap instanceof Bitmap)) { throw new Error('Bitmap must be an instance of Bitmap'); }
        const serializedBitmap = bitmap.serialize(true);
        this.store.put(key, serializedBitmap);
        this.cache.set(key, bitmap);
    }

    loadBitmap(key) {
        log(`Loading bitmap with key ID "${key}" from persistent store`);
        let bitmapData = this.store.get(key);
        if (!bitmapData) {
            log(`Unable to load bitmap "${key}" from the database`);
            return null;
        }

        let bitmap = new RoaringBitmap32();
        return Bitmap.create(bitmap.deserialize(bitmapData, true), {
            type: 'static',
            key: key,
            rangeMin: this.rangeMin,
            rangeMax: this.rangeMax,
        });
    }

    clearCache() {
        this.cache.clear();
    }

    /**
     * Internal methods (sync, using a Map() like interface)
     */

    #parseInput(input) {
        if (!input) {
            log('Creating new empty bitmap');
            return new RoaringBitmap32();
        } else if (input instanceof RoaringBitmap32) {
            log(`RoaringBitmap32 supplied as input with ${input.size} elements`);
            return input;
        } else if (Array.isArray(input)) {
            log(`OID Array supplied as input with ${input.length} elements`);
            return new RoaringBitmap32(input);
        } else if (typeof input === 'number') {
            return input;
        } else {
            throw new TypeError(`Invalid input type: ${typeof input}`);
        }
    }

}

export default BitmapIndex;
