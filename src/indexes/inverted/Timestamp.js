'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:timestamp-index');
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Roaring = require('roaring');
const { RoaringBitmap32 } = Roaring;
import {
    parseISO,
    getUnixTime,
    isToday,
    isYesterday,
    isThisWeek,
    isThisMonth,
    isThisYear,
    startOfDay,
    endOfDay,
    startOfYesterday,
    endOfYesterday,
    startOfWeek,
    endOfWeek,
    startOfMonth,
    endOfMonth,
    startOfYear,
    endOfYear
} from 'date-fns';

import BitSlicedIndex from '../bitmaps/lib/BitSlicedIndex.js';

const VALID_ACTIONS = ['created', 'updated', 'deleted'];

/**
 * TimestampIndex - Maps normalized timestamps (seconds) to bitmaps of document IDs using BSI.
 *
 * Replaces the legacy YYYY-MM-DD Key-Value approach with Bit-Sliced Indexing
 * for efficient range queries.
 */
export default class TimestampIndex {

    constructor(bitmapIndex, actionBitmaps) {
        if (!bitmapIndex) { throw new Error('BitmapIndex required for TimestampIndex'); }
        if (!actionBitmaps || !VALID_ACTIONS.every(act => actionBitmaps[act] && typeof actionBitmaps[act].has === 'function')) {
            throw new Error('Valid actionBitmaps (created, updated, deleted), which are Bitmap instances, are required');
        }

        this.bitmapIndex = bitmapIndex;
        this.actionBitmaps = actionBitmaps; // { created: Bitmap, updated: Bitmap, deleted: Bitmap }

        // Initialize BSI instances for each action
        this.bsi = {
            created: new BitSlicedIndex('internal/ts/c', bitmapIndex),
            updated: new BitSlicedIndex('internal/ts/u', bitmapIndex),
            deleted: new BitSlicedIndex('internal/ts/d', bitmapIndex),
        };

        debug('TimestampIndex initialized with BSI');
    }

    /**
     * Get the count of items in the index.
     * For BSI, this is ambiguous (count of bits? count of unique IDs?).
     * We'll return the size of the 'created' action bitmap as a proxy for "indexed documents",
     * or we can return 0 as "keys" concept is deprecated.
     */
    async getCount() {
        // Proxy to global created bitmap size
        return this.actionBitmaps.created.size;
    }

    /**
     * Insert a document ID with its timestamp and action.
     * @param {string} action - The action type (created, updated, deleted).
     * @param {string|Date|number} timestamp - The timestamp of the action.
     * @param {number} id - Document ID.
     * @returns {Promise<boolean>} True on success.
     */
    async insert(action, timestamp, id) {
        if (!this.#isValidAction(action)) {
            throw new Error(`Invalid action: ${action}. Must be one of ${VALID_ACTIONS.join(', ')}`);
        }
        const ts = this.#normalizeTimestamp(timestamp);
        if (ts === null) { throw new Error('Invalid timestamp provided for insert'); }
        if (id === undefined || id === null) { throw new Error('ID required for insert'); }

        // Update BSI
        await this.bsi[action].setValue(id, ts);
        debug(`Set ID ${id} timestamp to ${ts} in BSI '${action}'`);

        // Update action bitmap
        const actionBitmap = this.actionBitmaps[action];
        if (actionBitmap) {
            actionBitmap.add(id);
            // Note: We don't strictly need to save actionBitmap here if BSI is the source of truth,
            // but actionBitmaps are likely used elsewhere for quick "isCreated" checks.
            // Also, BitmapIndex usually requires explicit save, but here we are operating on the instance passed in.
            // We assume the caller or a periodic process handles persistence of actionBitmaps if they are not auto-saved.
            // However, looking at src/index.js, they are created via bitmapIndex.createBitmap,
            // so they are managed by BitmapIndex. We should probably save them.
            await this.bitmapIndex.tick(actionBitmap.key, id);
        }

        return true;
    }

    /**
     * Get document IDs for a specific timestamp (Exact Match).
     * @param {string|Date|number} timestamp - The timestamp to query.
     * @returns {Promise<Array<number>>} Array of document IDs.
     */
    async get(timestamp) {
        const ts = this.#normalizeTimestamp(timestamp);
        if (ts === null) { return []; }

        // "Get" implies "any action happened at this timestamp"?
        // Or specific action? Legacy implies union.
        const results = await Promise.all([
            this.bsi.created.query('=', ts),
            this.bsi.updated.query('=', ts),
            this.bsi.deleted.query('=', ts)
        ]);

        const union = new RoaringBitmap32();
        for (const res of results) {
            union.orInPlace(res);
        }
        return union.toArray();
    }

    /**
     * Find document IDs by timestamp range.
     * Returns union of all actions in the range.
     * @param {string|Date|number} startDate - Starting timestamp (inclusive).
     * @param {string|Date|number} endDate - Ending timestamp (inclusive).
     * @returns {Promise<Array<number>>} Array of unique document IDs.
     */
    async findByRange(startDate, endDate) {
        const start = this.#normalizeTimestamp(startDate);
        const end = this.#normalizeTimestamp(endDate);

        if (start === null || end === null) {
            throw new Error('Valid start and end dates required for findByRange');
        }
        if (start > end) {
            throw new Error('Start date must be before or equal to end date');
        }

        const results = await Promise.all([
            this.bsi.created.query('BETWEEN', [start, end]),
            this.bsi.updated.query('BETWEEN', [start, end]),
            this.bsi.deleted.query('BETWEEN', [start, end])
        ]);

        const union = new RoaringBitmap32();
        for (const res of results) {
            union.orInPlace(res);
        }
        return union.toArray();
    }

    /**
     * Find document IDs by timestamp range and action.
     * @param {string} action - The action type (created, updated, deleted).
     * @param {string|Date|number} startDate - Starting timestamp.
     * @param {string|Date|number} endDate - Ending timestamp.
     * @returns {Promise<Array<number>>} Array of document IDs.
     */
    async findByRangeAndAction(action, startDate, endDate) {
        if (!this.#isValidAction(action)) {
            throw new Error(`Invalid action: ${action}. Must be one of: ${VALID_ACTIONS.join(', ')}`);
        }

        const start = this.#normalizeTimestamp(startDate);
        const end = this.#normalizeTimestamp(endDate);

        if (start === null || end === null) {
            throw new Error('Valid start and end dates required');
        }

        const result = await this.bsi[action].query('BETWEEN', [start, end]);
        return result.toArray();
    }

    /**
     * Remove a document ID from a timestamp entry.
     * NOTE: In BSI, we typically just "unset" the value for the ID.
     * But we need to know the action.
     * If action is not provided (legacy signature), we attempt to remove from ALL.
     * @param {string|Date|number} timestamp - Ignored in BSI (value matches ID).
     * @param {number} id - Document ID to remove.
     * @returns {Promise<boolean>} True.
     */
    async remove(timestamp, id) {
        if (id === undefined || id === null) { return false; }

        // We remove from all actions as we don't know which one is intended
        await Promise.all([
            this.bsi.created.removeValue(id),
            this.bsi.updated.removeValue(id),
            this.bsi.deleted.removeValue(id)
        ]);

        debug(`Removed ID ${id} from all BSI indices`);
        return true;
    }

    /**
     * Delete an entire timestamp entry (removes all IDs).
     * Not supported/applicable in BSI (would require finding all IDs with value X and clearing them).
     * @deprecated
     */
    async delete(timestamp) {
        debug('delete() is deprecated/not supported in BSI TimestampIndex');
        return false;
    }

    /**
     * Check if a timestamp key exists.
     * @deprecated
     */
    async has(timestamp) {
        const ids = await this.get(timestamp);
        return ids.length > 0;
    }

    /**
     * List timestamp keys.
     * @deprecated
     */
    async list(prefix) {
        debug('list() is deprecated in BSI TimestampIndex');
        return [];
    }

    /**
     * List all stored timestamp keys.
     * @deprecated
     */
    async listAll() {
        debug('listAll() is deprecated in BSI TimestampIndex');
        return [];
    }

    /**
     * Find document IDs by predefined timeframe and optionally filter by action.
     * @param {string} timeframe - Timeframe: 'today', 'yesterday', 'thisWeek', 'thisMonth', 'thisYear'.
     * @param {string} [action] - Optional action filter (created, updated, deleted).
     * @returns {Promise<Array<number>>} Array of document IDs.
     */
    async findByTimeframe(timeframe, action = null) {
        const now = new Date();
        let start, end;

        switch (timeframe) {
            case 'today':
                start = startOfDay(now);
                end = endOfDay(now);
                break;
            case 'yesterday':
                start = startOfYesterday();
                end = endOfYesterday();
                break;
            case 'thisWeek':
                start = startOfWeek(now);
                end = endOfWeek(now); // or end = now
                break;
            case 'thisMonth':
                start = startOfMonth(now);
                end = endOfMonth(now); // or end = now
                break;
            case 'thisYear':
                start = startOfYear(now);
                end = endOfYear(now); // or end = now
                break;
            default:
                throw new Error(`Invalid timeframe: ${timeframe}. Must be one of: today, yesterday, thisWeek, thisMonth, thisYear`);
        }

        if (action) {
            return await this.findByRangeAndAction(action, start, end);
        }
        return await this.findByRange(start, end);
    }

    // ========================================
    // Private Methods
    // ========================================

    /**
     * Normalize timestamp to Unix Timestamp (Seconds).
     * @param {string|Date|number} timestamp - Input timestamp.
     * @returns {number|null} Unix timestamp (integer seconds) or null if invalid.
     */
    #normalizeTimestamp(timestamp) {
        if (timestamp === null || timestamp === undefined) { return null; }

        try {
            let date;
            if (timestamp instanceof Date) {
                date = timestamp;
            } else if (typeof timestamp === 'number') {
                // Assuming milliseconds if > 2^32? Or seconds?
                // JS Date uses ms.
                // If it's a small number, it might be seconds.
                // But let's assume input is either Date object or Date-compatible (ms).
                // But getUnixTime expects Date or number (ms).
                date = new Date(timestamp);
            } else if (typeof timestamp === 'string') {
                date = parseISO(timestamp);
                if (isNaN(date.getTime())) {
                    date = new Date(timestamp); // Fallback
                }
            } else {
                return null;
            }

            if (isNaN(date.getTime())) {
                throw new Error('Invalid date value');
            }

            return getUnixTime(date);
        } catch (e) {
            debug(`Error normalizing timestamp '${String(timestamp)}': ${e.message}`);
            return null;
        }
    }

    #isValidAction(action) {
        return VALID_ACTIONS.includes(action);
    }
}
