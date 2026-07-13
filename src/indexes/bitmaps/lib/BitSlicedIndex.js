'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:bsi');
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Roaring = require('roaring');
const { RoaringBitmap32 } = Roaring;

/**
 * BitSlicedIndex
 *
 * Implements Bit-Sliced Indexing (BSI) for efficient range queries on integer values.
 * Uses a set of N bitmaps (slices) to represent N-bit integers.
 * Supports up to 64-bit integers using BigInt.
 *
 * Reference: https://www.pilosa.com/docs/architecture/#bsi-range-encoding
 */
export default class BitSlicedIndex {

    /**
     * @param {string} prefix - Key prefix for the slices (e.g., "idx/ts/c")
     * @param {BitmapIndex} bitmapIndex - The underlying BitmapIndex instance
     * @param {number} bitDepth - Number of bits (default 64)
     */
    constructor(prefix, bitmapIndex, bitDepth = 64) {
        if (!prefix) throw new Error('Prefix required');
        if (!bitmapIndex) throw new Error('BitmapIndex required');

        this.prefix = prefix;
        this.bitmapIndex = bitmapIndex;
        this.bitDepth = bitDepth;

        // Existence Bitmap Key (tracks all IDs that have a value in this BSI)
        this.ebmKey = `${this.prefix}/ebm`;
    }

    /**
     * Set a value for a document ID.
     * Updates the existence bitmap and all bit slices.
     *
     * @param {number} id - Document ID
     * @param {number|BigInt} value - Integer value (must be non-negative)
     */
    async setValue(id, value) {
        let bigValue = BigInt(value);
        if (bigValue < 0n || bigValue >= (1n << BigInt(this.bitDepth))) {
            throw new Error(`Value ${value} out of range for bit depth ${this.bitDepth}`);
        }

        debug(`setValue: id=${id}, value=${value}, prefix=${this.prefix}`);

        // First insert vs overwrite: if the id has no prior value, the zero-bit
        // slices already lack it, so unticking them is a pointless full-slice
        // re-serialize+write per zero bit. Only untick on overwrite.
        const ebm = await this.bitmapIndex.getBitmap(this.ebmKey, false);
        const isOverwrite = !!ebm && ebm.has(Number(id));

        // 1. Update Existence Bitmap
        await this.bitmapIndex.tick(this.ebmKey, id);

        // 2. Update Slices
        const promises = [];
        for (let i = 0n; i < BigInt(this.bitDepth); i++) {
            const bit = (bigValue >> i) & 1n;
            const sliceKey = this._sliceKey(Number(i));

            if (bit === 1n) {
                promises.push(this.bitmapIndex.tick(sliceKey, id));
            } else if (isOverwrite) {
                promises.push(this.bitmapIndex.untick(sliceKey, id));
            }
        }

        await Promise.all(promises);
    }

    /**
     * Remove a value for a document ID.
     * Clears the existence bitmap and all set bits.
     * This is effectively "setting null".
     *
     * @param {number} id - Document ID
     */
    async removeValue(id) {
        debug(`removeValue: id=${id}, prefix=${this.prefix}`);

        const promises = [];
        // Remove from EBM
        promises.push(this.bitmapIndex.untick(this.ebmKey, id));

        // Remove from all slices
        for (let i = 0; i < this.bitDepth; i++) {
            const sliceKey = this._sliceKey(i);
            promises.push(this.bitmapIndex.untick(sliceKey, id));
        }

        await Promise.all(promises);
    }

    /**
     * Execute a range or equality query.
     *
     * @param {string} operator - One of: '=', '!=', '>', '>=', '<', '<=', 'BETWEEN'
     * @param {number|BigInt|Array<number|BigInt>} value - The value(s) to compare against.
     *                                       For BETWEEN, pass [start, end].
     * @returns {Promise<RoaringBitmap32>} Resulting bitmap
     */
    async query(operator, value) {
        debug(`query: op=${operator}, value=${value}, prefix=${this.prefix}`);

        // Ensure existence bitmap is loaded
        const ebm = await this.bitmapIndex.getBitmap(this.ebmKey, false);
        if (!ebm || ebm.isEmpty) {
            return new RoaringBitmap32();
        }

        switch (operator) {
            case '=':
            case '==':
            case 'eq':
                return this._eq(BigInt(value), ebm);
            case '!=':
            case 'neq':
                return this._neq(BigInt(value), ebm);
            case '>':
            case 'gt':
                return this._gt(BigInt(value), ebm);
            case '>=':
            case 'gte':
                return this._gte(BigInt(value), ebm);
            case '<':
            case 'lt':
                return this._lt(BigInt(value), ebm);
            case '<=':
            case 'lte':
                return this._lte(BigInt(value), ebm);
            case 'BETWEEN':
                if (!Array.isArray(value) || value.length !== 2) throw new Error('BETWEEN requires [min, max]');
                return this._between(BigInt(value[0]), BigInt(value[1]), ebm);
            default:
                throw new Error(`Unknown operator: ${operator}`);
        }
    }

    /**
     * Reconstruct stored values for a set of document IDs.
     * One pass over the slices (each ANDed against the candidate set) instead of
     * per-id probing — this is the sort/extraction primitive.
     *
     * @param {RoaringBitmap32} ids - Candidate document IDs
     * @returns {Promise<Map<number, BigInt>>} id -> raw stored value; ids absent
     *          from the existence bitmap are omitted
     */
    async getValues(ids) {
        const ebm = await this.bitmapIndex.getBitmap(this.ebmKey, false);
        if (!ebm || ebm.isEmpty) { return new Map(); }
        const present = RoaringBitmap32.and(ids, ebm);
        if (present.isEmpty) { return new Map(); }

        const values = new Map();
        for (const id of present) { values.set(id, 0n); }
        for (let i = 0; i < this.bitDepth; i++) {
            const slice = await this._getSlice(i);
            if (slice.isEmpty) { continue; }
            const hits = RoaringBitmap32.and(present, slice);
            if (hits.isEmpty) { continue; }
            const weight = 1n << BigInt(i);
            for (const id of hits) { values.set(id, values.get(id) + weight); }
        }
        return values;
    }

    // ==========================================
    // Internal BSI Logic
    // ==========================================

    _sliceKey(bitIndex) {
        return `${this.prefix}/${bitIndex}`;
    }

    async _getSlice(bitIndex) {
        const bmp = await this.bitmapIndex.getBitmap(this._sliceKey(Number(bitIndex)), false);
        return bmp || new RoaringBitmap32();
    }

    async _eq(value, ebm) {
        let result = ebm.clone();

        for (let i = 0n; i < BigInt(this.bitDepth); i++) {
            const bit = (value >> i) & 1n;
            const slice = await this._getSlice(i);

            if (bit === 1n) {
                result.andInPlace(slice);
            } else {
                result.andNotInPlace(slice);
            }

            if (result.isEmpty) break;
        }
        return result;
    }

    async _neq(value, ebm) {
        const eq = await this._eq(value, ebm);
        return RoaringBitmap32.andNot(ebm, eq);
    }

    async _gt(value, ebm) {
        const keep = ebm.clone();
        const result = new RoaringBitmap32();

        for (let i = BigInt(this.bitDepth) - 1n; i >= 0n; i--) {
            const bit = (value >> i) & 1n;
            const slice = await this._getSlice(i);

            if (bit === 0n) {
                const contribution = RoaringBitmap32.and(keep, slice);
                result.orInPlace(contribution);
                keep.andNotInPlace(slice);
            } else {
                keep.andInPlace(slice);
            }

            if (keep.isEmpty) break;
        }

        return result;
    }

    async _gte(value, ebm) {
        const keep = ebm.clone();
        const result = new RoaringBitmap32();

        for (let i = BigInt(this.bitDepth) - 1n; i >= 0n; i--) {
            const bit = (value >> i) & 1n;
            const slice = await this._getSlice(i);

            if (bit === 0n) {
                const contribution = RoaringBitmap32.and(keep, slice);
                result.orInPlace(contribution);
                keep.andNotInPlace(slice);
            } else {
                keep.andInPlace(slice);
            }

            if (keep.isEmpty && result.isEmpty) break;
        }

        result.orInPlace(keep);
        return result;
    }

    async _lt(value, ebm) {
        const gte = await this._gte(value, ebm);
        return RoaringBitmap32.andNot(ebm, gte);
    }

    async _lte(value, ebm) {
        const gt = await this._gt(value, ebm);
        return RoaringBitmap32.andNot(ebm, gt);
    }

    async _between(min, max, ebm) {
        if (min > max) return new RoaringBitmap32();

        const gteMin = await this._gte(min, ebm);
        if (gteMin.isEmpty) return gteMin;

        const lteMax = await this._lte(max, ebm);
        return RoaringBitmap32.and(gteMin, lteMax);
    }
}
