'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:timestamp-index');
import roaring from 'roaring';
const { RoaringBitmap32 } = roaring;
import {
    parseISO,
    isToday,
    isYesterday,
    isThisWeek,
    isThisISOWeek,
    isThisMonth,
    isThisQuarter,
    isThisYear,
} from 'date-fns';

const VALID_ACTIONS = ['created', 'updated', 'deleted'];

/**
 * TimestampIndex - Maps normalized timestamps to bitmaps of document IDs
 *
 * Design: timestamp (YYYY-MM-DD) -> RoaringBitmap of document IDs
 * This allows efficient filtering like "all files updated today"
 */
export default class TimestampIndex {

    constructor(dataset, actionBitmaps) {
        if (!dataset) { throw new Error('TimestampIndex dataset required for timestamp:bitmap mappings'); }
        if (!actionBitmaps || !VALID_ACTIONS.every(act => actionBitmaps[act] && typeof actionBitmaps[act].has === 'function')) {
            throw new Error('Valid actionBitmaps (created, updated, deleted), which are Bitmap instances, are required');
        }
        
        this.dataset = dataset; // LMDB store for timestamp -> serialized RoaringBitmap
        this.actionBitmaps = actionBitmaps; // { created: Bitmap, updated: Bitmap, deleted: Bitmap }
        debug('TimestampIndex initialized');
    }

    /**
     * Get the number of timestamp keys in the index.
     * @returns {Promise<number>} The number of timestamp entries.
     */
    async getCount() {
        return this.dataset.getCount();
    }

    /**
     * Insert a document ID with its timestamp and action.
     * Adds the ID to the bitmap for the normalized timestamp.
     * @param {string} action - The action type (created, updated, deleted).
     * @param {string|Date|number} timestamp - The timestamp of the action.
     * @param {number} id - Document ID.
     * @returns {Promise<boolean>} True on success.
     */
    async insert(action, timestamp, id) {
        if (!this.#isValidAction(action)) {
            throw new Error(`Invalid action: ${action}. Must be one of ${VALID_ACTIONS.join(', ')}`);
        }
        const normalizedTimestamp = this.#normalizeTimestamp(timestamp);
        if (!normalizedTimestamp) { throw new Error('Invalid timestamp provided for insert'); }
        if (id === undefined || id === null) { throw new Error('ID required for insert'); }

        // Get or create bitmap for this timestamp
        let bitmap = await this.#getBitmap(normalizedTimestamp);
        if (!bitmap) {
            bitmap = new RoaringBitmap32();
        }

        // Add ID to bitmap
        bitmap.add(id);

        // Store serialized bitmap (portable format)
        await this.dataset.put(normalizedTimestamp, Buffer.from(bitmap.serialize('portable')));
        debug(`Added ID ${id} to timestamp bitmap: ${normalizedTimestamp}`);

        // Update action bitmap
        const actionBitmap = this.actionBitmaps[action];
        if (actionBitmap) {
            actionBitmap.add(id);
            debug(`Ticked ID ${id} in action bitmap '${action}'`);
        }

        return true;
    }

    /**
     * Get document IDs for a specific timestamp.
     * @param {string|Date|number} timestamp - The timestamp to query.
     * @returns {Promise<Array<number>>} Array of document IDs, empty if timestamp not found.
     */
    async get(timestamp) {
        const normalizedTimestamp = this.#normalizeTimestamp(timestamp);
        if (!normalizedTimestamp) { return []; }

        const bitmap = await this.#getBitmap(normalizedTimestamp);
        return bitmap ? bitmap.toArray() : [];
    }

    /**
     * Find document IDs by timestamp range.
     * Returns union of all bitmaps in the range.
     * @param {string|Date|number} startDate - Starting timestamp (inclusive).
     * @param {string|Date|number} endDate - Ending timestamp (inclusive).
     * @returns {Promise<Array<number>>} Array of unique document IDs.
     */
    async findByRange(startDate, endDate) {
        const normalizedStart = this.#normalizeTimestamp(startDate);
        const normalizedEnd = this.#normalizeTimestamp(endDate);

        if (!normalizedStart || !normalizedEnd) {
            throw new Error('Valid start and end dates required for findByRange');
        }
        if (new Date(normalizedStart) > new Date(normalizedEnd)) {
            throw new Error('Start date must be before or equal to end date');
        }

        const unionBitmap = new RoaringBitmap32();

        if (this.dataset && typeof this.dataset.getRange === 'function') {
            for await (const { value } of this.dataset.getRange({ start: normalizedStart, end: normalizedEnd })) {
                if (value && Buffer.isBuffer(value)) {
                    const bitmap = RoaringBitmap32.deserialize(value, 'portable');
                    unionBitmap.orInPlace(bitmap);
                }
            }
        }

        return unionBitmap.toArray();
    }

    /**
     * Find document IDs by timestamp range and action.
     * Returns intersection of range results with action bitmap.
     * @param {string} action - The action type (created, updated, deleted).
     * @param {string|Date|number} startDate - Starting timestamp.
     * @param {string|Date|number} endDate - Ending timestamp.
     * @returns {Promise<Array<number>>} Array of document IDs.
     */
    async findByRangeAndAction(action, startDate, endDate) {
        if (!this.#isValidAction(action)) {
            throw new Error(`Invalid action: ${action}. Must be one of: ${VALID_ACTIONS.join(', ')}`);
        }

        const normalizedStart = this.#normalizeTimestamp(startDate);
        const normalizedEnd = this.#normalizeTimestamp(endDate);

        if (!normalizedStart || !normalizedEnd) {
            throw new Error('Valid start and end dates required');
        }

        const unionBitmap = new RoaringBitmap32();

        if (this.dataset && typeof this.dataset.getRange === 'function') {
            for await (const { value } of this.dataset.getRange({ start: normalizedStart, end: normalizedEnd })) {
                if (value && Buffer.isBuffer(value)) {
                    const bitmap = RoaringBitmap32.deserialize(value, 'portable');
                    unionBitmap.orInPlace(bitmap);
                }
            }
        }

        // Intersect with action bitmap
        const actionBitmap = this.actionBitmaps[action];
        if (!actionBitmap) { return []; }

        const resultBitmap = RoaringBitmap32.and(unionBitmap, actionBitmap);
        return resultBitmap.toArray();
    }

    /**
     * Remove a document ID from a timestamp's bitmap.
     * If bitmap becomes empty, removes the timestamp entry.
     * @param {string|Date|number} timestamp - The timestamp.
     * @param {number} id - Document ID to remove.
     * @returns {Promise<boolean>} True if removed, false if not found.
     */
    async remove(timestamp, id) {
        const normalizedTimestamp = this.#normalizeTimestamp(timestamp);
        if (!normalizedTimestamp || id === undefined || id === null) { return false; }

        const bitmap = await this.#getBitmap(normalizedTimestamp);
        if (!bitmap || !bitmap.has(id)) { return false; }

        bitmap.remove(id);

        // If bitmap is empty, delete the entry
        if (bitmap.size === 0) {
            await this.dataset.remove(normalizedTimestamp);
            debug(`Removed empty timestamp entry: ${normalizedTimestamp}`);
        } else {
            await this.dataset.put(normalizedTimestamp, Buffer.from(bitmap.serialize('portable')));
            debug(`Removed ID ${id} from timestamp: ${normalizedTimestamp}`);
        }

        return true;
    }

    /**
     * Delete an entire timestamp entry (removes all IDs).
     * @param {string|Date|number} timestamp - The timestamp to delete.
     * @returns {Promise<boolean>} True if deleted, false if not found.
     */
    async delete(timestamp) {
        const normalizedTimestamp = this.#normalizeTimestamp(timestamp);
        if (!normalizedTimestamp) { return false; }

        if (this.dataset && typeof this.dataset.remove === 'function') {
            const result = await this.dataset.remove(normalizedTimestamp);
            debug(`Deleted timestamp entry: ${normalizedTimestamp}`);
            return result;
        }
        return false;
    }

    /**
     * Check if a timestamp key exists.
     * @param {string|Date|number} timestamp - The timestamp to check.
     * @returns {Promise<boolean>} Whether the timestamp has any document IDs.
     */
    async has(timestamp) {
        const normalizedTimestamp = this.#normalizeTimestamp(timestamp);
        if (!normalizedTimestamp) { return false; }
        return this.dataset.doesExist(normalizedTimestamp);
    }

    /**
     * List timestamp keys (YYYY-MM-DD) by a prefix.
     * Example: prefix '2023-10' lists all timestamp keys in October 2023.
     * @param {string} prefix - Timestamp prefix.
     * @returns {Promise<Array<string>>} Array of timestamp keys.
     */
    async list(prefix) {
        if (!prefix || typeof prefix !== 'string') {
            throw new Error('A valid string timestamp prefix is required for list.');
        }
        const keys = [];
        if (this.dataset && typeof this.dataset.getKeys === 'function') {
            // LMDB getKeys with start/end to simulate prefix scan
            for await (const key of this.dataset.getKeys({ start: prefix, end: prefix + '\\uffff' })) {
                keys.push(key);
            }
        } else {
            console.error('[TimestampIndex.list ERROR] this.dataset.getKeys is not a function or dataset is undefined.');
        }
        return keys;
    }

    /**
     * List all stored timestamp keys (YYYY-MM-DD).
     * @returns {Promise<Array<string>>} Array of all timestamp keys.
     */
    async listAll() {
        const keys = [];
        if (this.dataset && typeof this.dataset.getKeys === 'function') {
            for await (const key of this.dataset.getKeys()) {
                keys.push(key);
            }
        } else {
            console.error('[TimestampIndex.listAll ERROR] this.dataset.getKeys is not a function or dataset is undefined.');
        }
        return keys;
    }

    /**
     * Find document IDs by predefined timeframe and optionally filter by action.
     * @param {string} timeframe - Timeframe: 'today', 'yesterday', 'thisWeek', 'thisMonth', 'thisYear'.
     * @param {string} [action] - Optional action filter (created, updated, deleted).
     * @returns {Promise<Array<number>>} Array of document IDs.
     */
    async findByTimeframe(timeframe, action = null) {
        const now = new Date();
        let startDate, endDate;

        switch (timeframe) {
            case 'today':
                startDate = endDate = now;
                break;
            case 'yesterday':
                startDate = endDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                break;
            case 'thisWeek': {
                const dayOfWeek = now.getDay();
                const startOfWeek = new Date(now.getTime() - dayOfWeek * 24 * 60 * 60 * 1000);
                startDate = startOfWeek;
                endDate = now;
                break;
            }
            case 'thisMonth': {
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = now;
                break;
            }
            case 'thisYear': {
                startDate = new Date(now.getFullYear(), 0, 1);
                endDate = now;
                break;
            }
            default:
                throw new Error(`Invalid timeframe: ${timeframe}. Must be one of: today, yesterday, thisWeek, thisMonth, thisYear`);
        }

        if (action) {
            return await this.findByRangeAndAction(action, startDate, endDate);
        }
        return await this.findByRange(startDate, endDate);
    }

    // ========================================
    // Private Methods
    // ========================================

    /**
     * Retrieve bitmap for a timestamp key.
     * @param {string} normalizedTimestamp - Normalized timestamp (YYYY-MM-DD).
     * @returns {Promise<RoaringBitmap32|null>} Bitmap or null if not found.
     */
    async #getBitmap(normalizedTimestamp) {
        const buffer = await this.dataset.get(normalizedTimestamp);
        if (!buffer || !Buffer.isBuffer(buffer)) { return null; }

        try {
            return RoaringBitmap32.deserialize(buffer, 'portable');
        } catch (e) {
            debug(`Error deserializing bitmap for ${normalizedTimestamp}: ${e.message}`);
            return null;
        }
    }

    /**
     * Normalize timestamp to YYYY-MM-DD format.
     * @param {string|Date|number} timestamp - Input timestamp.
     * @returns {string|null} Normalized timestamp or null if invalid.
     */
    #normalizeTimestamp(timestamp) {
        if (timestamp === null || timestamp === undefined) { return null; }

        try {
            let date;
            if (timestamp instanceof Date) {
                date = timestamp;
            } else if (typeof timestamp === 'number') {
                date = new Date(timestamp);
            } else if (typeof timestamp === 'string') {
                // Try parseISO for better ISO string handling
                date = parseISO(timestamp);
                if (isNaN(date.getTime())) {
                    date = new Date(timestamp);
                }
            } else {
                return null;
            }

            if (isNaN(date.getTime())) {
                throw new Error('Invalid date value');
            }

            const year = date.getFullYear();
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const day = date.getDate().toString().padStart(2, '0');
            return `${year}-${month}-${day}`;
        } catch (e) {
            debug(`Error normalizing timestamp '${String(timestamp)}': ${e.message}`);
            return null;
        }
    }

    #isValidAction(action) {
        return VALID_ACTIONS.includes(action);
    }
}
