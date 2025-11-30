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
 *
 * Reference: https://www.pilosa.com/docs/architecture/#bsi-range-encoding
 */
export default class BitSlicedIndex {

    /**
     * @param {string} prefix - Key prefix for the slices (e.g., "idx/ts/c")
     * @param {BitmapIndex} bitmapIndex - The underlying BitmapIndex instance
     * @param {number} bitDepth - Number of bits (default 32)
     */
    constructor(prefix, bitmapIndex, bitDepth = 32) {
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
     * @param {number} value - Integer value (must be non-negative)
     */
    async setValue(id, value) {
        if (value < 0 || value >= Math.pow(2, this.bitDepth)) {
            throw new Error(`Value ${value} out of range for bit depth ${this.bitDepth}`);
        }

        debug(`setValue: id=${id}, value=${value}, prefix=${this.prefix}`);

        // 1. Update Existence Bitmap
        await this.bitmapIndex.tick(this.ebmKey, id);

        // 2. Update Slices
        // We process all bits. If bit is 1, we tick. If 0, we untick.
        // Optimization: We could check previous value if we knew it, but we don't.
        // We assume the cost of unticking a non-existent bit is low (handled by BitmapIndex/Roaring).

        const promises = [];
        for (let i = 0; i < this.bitDepth; i++) {
            const bit = (value >>> i) & 1;
            const sliceKey = this._sliceKey(i);

            if (bit) {
                promises.push(this.bitmapIndex.tick(sliceKey, id));
            } else {
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

        // Check if it exists first? Or just blindly remove from all slices?
        // Blind removal is safer to ensure cleanup.

        const promises = [];
        // Remove from EBM
        promises.push(this.bitmapIndex.untick(this.ebmKey, id));

        // Remove from all slices (expensive if we iterate all 32, but necessary to be sure)
        // Optimization: We could check EBM first.
        // Assuming calling code knows it's deleting.

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
     * @param {number|Array<number>} value - The value(s) to compare against.
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
                return this._eq(value, ebm);
            case '!=':
            case 'neq':
                return this._neq(value, ebm);
            case '>':
            case 'gt':
                return this._gt(value, ebm);
            case '>=':
            case 'gte':
                return this._gte(value, ebm);
            case '<':
            case 'lt':
                return this._lt(value, ebm);
            case '<=':
            case 'lte':
                return this._lte(value, ebm);
            case 'BETWEEN':
                if (!Array.isArray(value) || value.length !== 2) throw new Error('BETWEEN requires [min, max]');
                return this._between(value[0], value[1], ebm);
            default:
                throw new Error(`Unknown operator: ${operator}`);
        }
    }

    // ==========================================
    // Internal BSI Logic
    // ==========================================

    _sliceKey(bitIndex) {
        return `${this.prefix}/${bitIndex}`;
    }

    async _getSlice(bitIndex) {
        // Don't auto-create for read operations, treating missing as empty
        const bmp = await this.bitmapIndex.getBitmap(this._sliceKey(bitIndex), false);
        return bmp || new RoaringBitmap32();
    }

    /**
     * Equality: ID exists AND (for all bits: slice[i] == value[i])
     */
    async _eq(value, ebm) {
        let result = ebm.clone();

        for (let i = 0; i < this.bitDepth; i++) {
            const bit = (value >>> i) & 1;
            const slice = await this._getSlice(i);

            if (bit) {
                // Bit is 1: Result must be in slice
                result.andInPlace(slice);
            } else {
                // Bit is 0: Result must NOT be in slice
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

    /**
     * Greater Than
     * Algorithm scans from MSB to LSB.
     * GT = Union of (Bit i is 1 in result AND 0 in value) restricted by "strict match so far"
     */
    async _gt(value, ebm) {
        const keep = ebm.clone(); // Candidates that match prefix so far
        const result = new RoaringBitmap32();

        for (let i = this.bitDepth - 1; i >= 0; i--) {
            const bit = (value >>> i) & 1;
            const slice = await this._getSlice(i);

            if (bit === 0) {
                // Value bit is 0.
                // If slice bit is 1, those IDs are definitely GT.
                // We add (keep AND slice) to result.
                // Then we restrict keep to (keep AND NOT slice) -> effectively must be 0 at this pos to continue matching.

                const contribution = RoaringBitmap32.and(keep, slice);
                result.orInPlace(contribution);

                keep.andNotInPlace(slice);
            } else {
                // Value bit is 1.
                // To stay GE (or match), ID bit must be 1.
                // If ID bit is 0, it's LT (drop from keep).

                keep.andInPlace(slice);
            }

            if (keep.isEmpty) break;
        }

        return result;
    }

    async _gte(value, ebm) {
        // GTE = GT OR EQ
        // Can be optimized: similar to GT, but final 'keep' are the EQs

        const keep = ebm.clone();
        const result = new RoaringBitmap32();

        for (let i = this.bitDepth - 1; i >= 0; i--) {
            const bit = (value >>> i) & 1;
            const slice = await this._getSlice(i);

            if (bit === 0) {
                // Value is 0. Slice 1 implies GT.
                const contribution = RoaringBitmap32.and(keep, slice);
                result.orInPlace(contribution);

                // Restrict keep to 0s (matches)
                keep.andNotInPlace(slice);
            } else {
                // Value is 1. Slice 1 implies Match (keep). Slice 0 implies LT (discard).
                keep.andInPlace(slice);
            }

            if (keep.isEmpty && result.isEmpty) break; // Optimization check
        }

        // Whatever remains in 'keep' matches exactly, so it is Equal.
        // Since we want GTE, we add EQ to GT.
        result.orInPlace(keep);

        return result;
    }

    async _lt(value, ebm) {
        // LT = NOT GTE (within EBM)
        const gte = await this._gte(value, ebm);
        return RoaringBitmap32.andNot(ebm, gte);
    }

    async _lte(value, ebm) {
        // LTE = NOT GT (within EBM)
        const gt = await this._gt(value, ebm);
        return RoaringBitmap32.andNot(ebm, gt);
    }

    async _between(min, max, ebm) {
        if (min > max) return new RoaringBitmap32();

        // BETWEEN = GTE(min) AND LTE(max)
        // There are optimized BSI range algorithms but simple intersection is functionally correct.

        const gteMin = await this._gte(min, ebm);
        if (gteMin.isEmpty) return gteMin;

        const lteMax = await this._lte(max, ebm);

        return RoaringBitmap32.and(gteMin, lteMax);
    }
}

