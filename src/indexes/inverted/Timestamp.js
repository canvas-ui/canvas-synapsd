'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:timestamp-index');
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Roaring = require('roaring');
const { RoaringBitmap32 } = Roaring;

import BitSlicedIndex from '../bitmaps/lib/BitSlicedIndex.js';

// We use a 64-bit address space in seconds.
// This safely covers ~292 billion years into the past or future at second precision.
// 2^63 is the offset we add to all second values to allow negative timestamps (e.g. before 1970).
const BIT_DEPTH = 64;
const EPOCH_OFFSET = 1n << 63n;

/**
 * TimestampIndex - Maps arbitrary timelines to bitmaps of document IDs using Dual-BSI.
 * Replaces the legacy action-based Key-Value approach with dynamic Interval Range capability.
 */
export default class TimestampIndex {
    constructor(bitmapIndex) {
        if (!bitmapIndex) { throw new Error('BitmapIndex required for TimestampIndex'); }
        this.bitmapIndex = bitmapIndex;
        this.timelines = {}; // Lazy instantiation registry
        debug(`TimestampIndex initialized with Dual-BSI approach (${BIT_DEPTH}-bit)`);
    }

    /**
     * Lazily instantiate and retrieve a timeline's Dual-BSI.
     * @param {string} name - Timeline name
     * @returns {{start: BitSlicedIndex, end: BitSlicedIndex}}
     */
    getTimeline(name) {
        if (!this.timelines[name]) {
            this.timelines[name] = {
                start: new BitSlicedIndex(`internal/ts/${name}/start`, this.bitmapIndex, BIT_DEPTH),
                end: new BitSlicedIndex(`internal/ts/${name}/end`, this.bitmapIndex, BIT_DEPTH)
            };
        }
        return this.timelines[name];
    }

    /**
     * Get the count of unique documents in a specific timeline.
     * @param {string} timelineName - Timeline name
     * @returns {Promise<number>}
     */
    async getCount(timelineName) {
        const timeline = this.getTimeline(timelineName);
        const ebm = await this.bitmapIndex.getBitmap(timeline.start.ebmKey, false);
        return ebm ? ebm.size : 0;
    }

    /**
     * Insert a document ID with its start and optional end times into a timeline.
     * @param {string} timelineName - The name of the timeline (e.g., 'crud:created', 'wikipedia').
     * @param {number} id - Document ID.
     * @param {number|bigint|string|Date} startVal - The start timestamp.
     * @param {number|bigint|string|Date} [endVal] - The end timestamp. Defaults to startVal.
     * @returns {Promise<boolean>} True on success.
     */
    async insert(timelineName, id, startVal, endVal = null) {
        if (id === undefined || id === null) { throw new Error('ID required for insert'); }
        if (startVal === undefined || startVal === null) { throw new Error('startVal required for insert'); }

        const startInt = this.#toBigIntSec(startVal);
        const endInt = endVal !== null && endVal !== undefined ? this.#toBigIntSec(endVal) : startInt;

        const timeline = this.getTimeline(timelineName);

        await Promise.all([
            timeline.start.setValue(id, startInt),
            timeline.end.setValue(id, endInt)
        ]);

        debug(`Set ID ${id} in timeline '${timelineName}' [${startInt}, ${endInt}]`);
        return true;
    }

    /**
     * Find document IDs overlapping with a given range in one or more timelines.
     * Condition for overlap: (timeline.start <= queryEnd) AND (timeline.end >= queryStart)
     * 
     * @param {string|Array<string>} timelineNames - Timeline name(s).
     * @param {number|bigint|string|Date} queryStart - Query range start.
     * @param {number|bigint|string|Date} queryEnd - Query range end.
     * @returns {Promise<Array<number>>} Array of unique document IDs across requested timelines.
     */
    async findOverlapping(timelineNames, queryStart, queryEnd) {
        const startInt = this.#toBigIntSec(queryStart);
        const endInt = this.#toBigIntSec(queryEnd);

        const names = Array.isArray(timelineNames) ? timelineNames : [timelineNames];
        const union = new RoaringBitmap32();

        const promises = names.map(async (name) => {
            const timeline = this.getTimeline(name);
            const [startMatches, endMatches] = await Promise.all([
                timeline.start.query('<=', endInt),
                timeline.end.query('>=', startInt)
            ]);
            return RoaringBitmap32.and(startMatches, endMatches);
        });

        const results = await Promise.all(promises);
        for (const res of results) {
            union.orInPlace(res);
        }

        return union.toArray();
    }

    /**
     * Remove a document ID from a specific timeline.
     * @param {string} timelineName - The timeline name.
     * @param {number} id - Document ID to remove.
     * @returns {Promise<boolean>} True.
     */
    async remove(timelineName, id) {
        if (id === undefined || id === null) { return false; }

        const timeline = this.getTimeline(timelineName);
        await Promise.all([
            timeline.start.removeValue(id),
            timeline.end.removeValue(id)
        ]);

        debug(`Removed ID ${id} from timeline '${timelineName}'`);
        return true;
    }

    // ========================================
    // Timeframe Utilities
    // ========================================

    /**
     * Get a date boundary pair { start, end } for common timeframes.
     * Returned as ISO strings suitable for insert() and findOverlapping().
     * @param {string} timeframe - 'today', 'yesterday', 'thisWeek', 'thisMonth', 'thisYear', 'thisCentury', 'thisMillennium'
     * @returns {{start: string, end: string}}
     */
    static getTimeframeBounds(timeframe) {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        const date = now.getDate();

        let start, end;
        
        switch (timeframe) {
            case 'today':
                start = new Date(year, month, date);
                end = new Date(start.getTime() + 86400000 - 1);
                break;
            case 'yesterday':
                start = new Date(year, month, date - 1);
                end = new Date(start.getTime() + 86400000 - 1);
                break;
            case 'thisWeek':
                const day = now.getDay() || 7; 
                start = new Date(year, month, date - day + 1);
                end = new Date(start.getTime() + 7 * 86400000 - 1);
                break;
            case 'thisMonth':
                start = new Date(year, month, 1);
                end = new Date(year, month + 1, 0, 23, 59, 59, 999);
                break;
            case 'thisYear':
                start = new Date(year, 0, 1);
                end = new Date(year, 11, 31, 23, 59, 59, 999);
                break;
            case 'thisCentury':
                const centuryStart = Math.floor(year / 100) * 100;
                start = new Date(centuryStart, 0, 1);
                end = new Date(centuryStart + 99, 11, 31, 23, 59, 59, 999);
                break;
            case 'thisMillennium':
                const millStart = Math.floor(year / 1000) * 1000;
                start = new Date(millStart, 0, 1);
                end = new Date(millStart + 999, 11, 31, 23, 59, 59, 999);
                break;
            default:
                throw new Error(`Invalid timeframe: ${timeframe}`);
        }
        
        return { start: start.toISOString(), end: end.toISOString() };
    }

    // ========================================
    // Timeline Management API
    // ========================================

    /**
     * List all persistent timeline names in the database.
     * @returns {Promise<Array<string>>}
     */
    async listTimelines() {
        const keys = await this.bitmapIndex.listBitmaps('internal/ts');
        // Extract the timeline name from keys like 'internal/ts/wikipedia/start/ebm'
        const names = keys.map(k => k.split('/')[2]).filter(Boolean);
        return [...new Set(names)];
    }

    /**
     * Check if a timeline exists.
     * @param {string} name - Timeline name
     * @returns {boolean}
     */
    hasTimeline(name) {
        // EBM for 'start' slice indicates existence of data
        return this.bitmapIndex.hasBitmap(`internal/ts/${name}/start/ebm`);
    }

    /**
     * Delete an entire timeline and free its bitmaps.
     * @param {string} name - Timeline name
     * @returns {Promise<boolean>}
     */
    async deleteTimeline(name) {
        const keys = await this.bitmapIndex.listBitmaps(`internal/ts/${name}`);
        if (keys.length === 0) return false;

        for (const key of keys) {
            await this.bitmapIndex.deleteBitmap(key);
        }

        delete this.timelines[name];
        debug(`Deleted timeline '${name}' (removed ${keys.length} bit slices)`);
        return true;
    }

    // ========================================
    // Private Methods
    // ========================================

    /**
     * Convert arbitrary value to seconds-precision BigInt with offset.
     * @param {number|bigint|string|Date} val
     * @returns {bigint}
     */
    #toBigIntSec(val) {
        if (typeof val === 'bigint') return val + EPOCH_OFFSET;
        
        let ms;
        if (val instanceof Date) {
            ms = val.getTime();
        } else if (typeof val === 'number') {
            // Assume input numbers are milliseconds (JS standard)
            ms = val;
        } else if (typeof val === 'string') {
            ms = new Date(val).getTime();
        } else {
            return EPOCH_OFFSET;
        }

        if (isNaN(ms)) return EPOCH_OFFSET;
        
        // Convert to seconds, then apply the offset to avoid negative numbers in BSI
        return BigInt(Math.floor(ms / 1000)) + EPOCH_OFFSET;
    }
}
