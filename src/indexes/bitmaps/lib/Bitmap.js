'use strict';

// Utils
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:bitmap');

// Includes
// const { RoaringBitmap32 } = require('roaring/RoaringBitmap32'); // Old
const Roaring = require('roaring');
const { RoaringBitmap32 } = Roaring;

// Constants
const MIN_OID = 0;
const MAX_OID = 4294967296;

class Bitmap extends RoaringBitmap32 {
    constructor(oidArrayOrBitmap = [], options = {}) {
        super(oidArrayOrBitmap);

        if (!options.key || typeof options.key !== 'string' || options.key.trim() === '') {
            throw new Error('Valid bitmap key string required');
        }
        this.key = options.key;
        this.rangeMin = options.rangeMin ?? MIN_OID;
        this.rangeMax = options.rangeMax ?? MAX_OID;

        debug(`Bitmap "${this.key}" ID range: ${this.rangeMin} - ${this.rangeMax} initialized`);
        debug(`Bitmap "${this.key}" has ${this.size} objects`);
    }

    // Optimized implementation using native roaring addMany
    addMany(values) {
        debug(`Adding ${Array.isArray(values) ? values.length : 'unknown number of'} values to bitmap "${this.key}"`);

        if (Array.isArray(values) || values instanceof RoaringBitmap32) {
            // Native addMany supports both arrays and bitmaps efficiently
            super.addMany(values);
        } else {
            throw new Error(`Cannot add values of type ${typeof values} to bitmap`);
        }

        return this;
    }

    // Optimized implementation using native roaring removeMany
    removeMany(values) {
        debug(`Removing ${Array.isArray(values) ? values.length : 'unknown number of'} values from bitmap "${this.key}"`);

        if (Array.isArray(values) || values instanceof RoaringBitmap32) {
            // Native removeMany supports both arrays and bitmaps efficiently
            super.removeMany(values);
        } else {
            throw new Error(`Cannot remove values of type ${typeof values} from bitmap`);
        }

        return this;
    }

    tick(oid) {
        this.#validateOid(oid);
        this.add(oid);
    }

    tickArray(oidArray) {
        this.#validateArray(oidArray);
        this.addMany(oidArray);
    }

    tickBitmap(bitmap) {
        this.#validateBitmap(bitmap);
        this.addMany(bitmap);
    }

    untick(oid) {
        this.#validateOid(oid);
        this.remove(oid);
    }

    untickArray(oidArray) {
        this.#validateArray(oidArray);
        this.removeMany(oidArray);
    }

    untickBitmap(bitmap) {
        this.#validateBitmap(bitmap);
        this.removeMany(bitmap);
    }

    static create(oidArrayOrBitmap, options = {}) {
        options = {
            type: 'static',
            rangeMin: MIN_OID,
            rangeMax: MAX_OID,
            ...options,
        };

        Bitmap.validateRange(oidArrayOrBitmap, options.rangeMin, options.rangeMax);
        return new Bitmap(oidArrayOrBitmap, options);
    }

    /**
     * Static method to deserialize a buffer back into a Bitmap instance
     * @param {Buffer} buffer - Serialized bitmap data
     * @param {boolean} portable - Whether the serialization is portable
     * @param {Object} options - Options for the bitmap
     * @returns {Bitmap} - New bitmap instance
     */
    static deserialize(buffer, portable = true, options = {}) {
        const roaring = RoaringBitmap32.deserialize(buffer, portable);
        return new Bitmap(roaring, options);
    }

    static validateRange(inputData, rangeMin = MIN_OID, rangeMax = MAX_OID) {
        if (rangeMin < 0 || rangeMax < 0 || rangeMin > rangeMax) {
            throw new Error(`Invalid range: ${rangeMin} - ${rangeMax}`);
        }

        const validateOid = (oid) => {
            if (oid < rangeMin || oid > rangeMax) {
                throw new Error(`ID out of range: ${oid}, range: ${rangeMin} - ${rangeMax}`);
            }
        };

        if (typeof inputData === 'number') {
            validateOid(inputData);
        } else if (Array.isArray(inputData)) {
            inputData.forEach(validateOid);
        } else if (inputData instanceof RoaringBitmap32) {
            validateOid(inputData.minimum());
            validateOid(inputData.maximum());
        } else {
            throw new Error(`Invalid input data: ${inputData}`);
        }
    }

    #validateOid(oid) {
        if (oid < this.rangeMin || oid > this.rangeMax) {
            throw new Error(`Object ID ${oid} not within range: ${this.rangeMin} - ${this.rangeMax}`);
        }
    }

    #validateArray(oidArray) {
        if (!Array.isArray(oidArray)) {
            throw new Error(`Not an array: ${oidArray}`);
        }
        if (oidArray.length === 0) {return;}

        const minOid = Math.min(...oidArray);
        const maxOid = Math.max(...oidArray);
        if (minOid < this.rangeMin || maxOid > this.rangeMax) {
            throw new Error(`Array contains out of range values. Range: ${this.rangeMin} - ${this.rangeMax}`);
        }
    }

    #validateBitmap(bitmap) {
        if (!(bitmap instanceof RoaringBitmap32)) {
            throw new Error(`Not a RoaringBitmap32 instance: ${bitmap}`);
        }
        const minId = bitmap.minimum();
        const maxId = bitmap.maximum();
        if (minId < this.rangeMin || maxId > this.rangeMax) {
            throw new Error(`Bitmap contains out of range values. Range: ${this.rangeMin} - ${this.rangeMax}`);
        }
    }
}

export default Bitmap;
