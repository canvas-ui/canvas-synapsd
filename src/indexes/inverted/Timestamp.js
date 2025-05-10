'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:timestamp-index');
// RoaringBitmap32 is not directly used by TimestampIndex itself, but by callers if they use actionBitmaps results.
// For clarity, it's fine here, or could be removed if no direct instantiation happens within this file.
import roaring from 'roaring';
const { RoaringBitmap32 } = roaring;

// date-fns was in the original, keeping it for reference if needed, though #normalizeTimestamp uses Date()
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

export default class TimestampIndex {

    constructor(dataset, actionBitmaps) {
        if (!dataset) { throw new Error('TimestampIndex dataset required for timestamp:id mappings'); }
        if (!actionBitmaps || !VALID_ACTIONS.every(act => actionBitmaps[act] && typeof actionBitmaps[act].has === 'function')) {
            throw new Error('Valid actionBitmaps (created, updated, deleted), which are Bitmap instances, are required');
        }
        this.dataset = dataset; // This is the LMDB store for timestamp:id
        this.actionBitmaps = actionBitmaps; // { created: Bitmap, updated: Bitmap, deleted: Bitmap }
        debug('TimestampIndex initialized');
    }

    /**
     * Get the number of entries in the timestamp index.
     * Note: This counts timestamp keys, not unique document IDs.
     * @returns {Promise<number>} The number of entries.
     */
    async getCount() {
        return this.dataset.getCount();
    }

    /**
     * Insert a document ID with its timestamp and action.
     * @param {string} action - The action type (created, updated, deleted).
     * @param {string|Date|number} timestamp - The timestamp of the action.
     * @param {string|number} id - Document ID.
     * @returns {Promise<boolean>} True on success.
     */
    async insert(action, timestamp, id) {
        if (!this.#isValidAction(action)) {
            throw new Error(`Invalid action: ${action}. Must be one of ${VALID_ACTIONS.join(', ')}`);
        }
        const normalizedTimestamp = this.#normalizeTimestamp(timestamp);
        if (!normalizedTimestamp) { throw new Error('Invalid timestamp provided for insert'); }
        if (id === undefined || id === null) { throw new Error('ID required for insert'); }

        // Store timestamp -> id mapping.
        // The Db wrapper's put method is async.
        await this.dataset.put(normalizedTimestamp, id);
        debug(`Stored timestamp:${normalizedTimestamp} -> id:${id}`);

        const mainActionBitmap = this.actionBitmaps[action];
        if (mainActionBitmap) {
            mainActionBitmap.add(id); // Bitmap.add is synchronous
            // The main action bitmaps are assumed to be saved by SynapsD through BitmapIndex when SynapsD calls its methods.
            debug(`Ticked ID ${id} in main action bitmap '${action}' (key: ${mainActionBitmap.key})`);
        } else {
            // This case should ideally not happen due to constructor validation
            debug(`Warning: Main action bitmap for '${action}' not found during insert.`);
        }
        return true;
    }

    /**
     * Get document ID by exact normalized timestamp (YYYY-MM-DD).
     * @param {string|Date|number} timestamp - The timestamp to query.
     * @returns {Promise<string|number|undefined>} Document ID or undefined if not found.
     */
    async get(timestamp) {
        const normalizedTimestamp = this.#normalizeTimestamp(timestamp);
        if (!normalizedTimestamp) return undefined;
        return await this.dataset.get(normalizedTimestamp); // .get on Db wrapper is async
    }

    /**
     * Find document IDs by timestamp range.
     * Timestamps are normalized to YYYY-MM-DD for range keys.
     * @param {string|Date|number} startDate - Starting timestamp.
     * @param {string|Date|number} endDate - Ending timestamp.
     * @returns {Promise<Array<string|number>>} Array of document IDs.
     */
    async findByRange(startDate, endDate) {
        const normalizedStart = this.#normalizeTimestamp(startDate);
        const normalizedEnd = this.#normalizeTimestamp(endDate);

        if (!normalizedStart || !normalizedEnd) { throw new Error('Valid start and end dates required for findByRange'); }
        if (new Date(normalizedStart) > new Date(normalizedEnd)) { throw new Error('Start date must be before or same as end date for findByRange'); }

        const ids = [];
        // this.dataset.getRange is an async iterator from the Db wrapper
        if (this.dataset && typeof this.dataset.getRange === 'function') {
            for await (const { value } of this.dataset.getRange({ start: normalizedStart, end: normalizedEnd })) {
                ids.push(value);
            }
        } else {
            console.error('[TimestampIndex.findByRange ERROR] this.dataset.getRange is not a function or dataset is undefined.');
        }
        return ids;
    }

    /**
     * Find document IDs by timestamp range and action.
     * @param {string} action - The action type (created, updated, deleted).
     * @param {string|Date|number} startDate - Starting timestamp.
     * @param {string|Date|number} endDate - Ending timestamp.
     * @returns {Promise<Array<string|number>>} Array of document IDs.
     */
    async findByRangeAndAction(action, startDate, endDate) {
        if (!this.#isValidAction(action)) {
            throw new Error(`Invalid action: ${action}. Must be one of: ${VALID_ACTIONS.join(', ')}`);
        }
        const rangeIds = await this.findByRange(startDate, endDate);
        const actionBitmap = this.actionBitmaps[action];
        if (!actionBitmap) return []; // Should not happen due to constructor check

        return rangeIds.filter(id => actionBitmap.has(id));
    }

    /**
     * Delete a timestamp entry.
     * @param {string|Date|number} timestamp - The timestamp of the entry to delete.
     * @returns {Promise<boolean>} Success status.
     */
    async delete(timestamp) {
        const normalizedTimestamp = this.#normalizeTimestamp(timestamp);
        if (!normalizedTimestamp) return false;

        if (this.dataset && typeof this.dataset.remove === 'function') {
             return await this.dataset.remove(normalizedTimestamp);
        } else {
            console.error('[TimestampIndex.delete ERROR] this.dataset.remove is not a function or dataset is undefined.');
            return false;
        }
    }

    /**
     * Check if a timestamp key exists.
     * @param {string|Date|number} timestamp - The timestamp to check.
     * @returns {Promise<boolean>} Whether the timestamp key exists.
     */
    async has(timestamp) {
        const normalizedTimestamp = this.#normalizeTimestamp(timestamp);
        if (!normalizedTimestamp) return false;
        return this.dataset.doesExist(normalizedTimestamp); // doesExist is sync on Db wrapper
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

    #normalizeTimestamp(timestamp) {
        if (timestamp === null || timestamp === undefined) { return null; }
        try {
            let date;
            if (timestamp instanceof Date) {
                date = timestamp;
            } else {
                // Attempt to parse various string formats, including YYYY-MM-DD directly
                date = new Date(timestamp);
            }

            if (isNaN(date.getTime())) {
                // If new Date(timestamp) fails for formats like 'YYYY-MM-DD' if not UTC,
                // parseISO from date-fns is more robust for ISO and YYYY-MM-DD.
                // However, new Date() handles 'YYYY-MM-DD' well in most JS environments.
                // Adding a fallback or more specific parsing if issues arise.
                // For now, assume new Date() is sufficient.
                throw new Error('Invalid date value');
            }

            const year = date.getFullYear();
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const day = date.getDate().toString().padStart(2, '0');
            return `${year}/${month}/${day}`;
        } catch (e) {
            debug(`Error normalizing timestamp '${String(timestamp)}': ${e.message}`);
            return null; // Return null for unparseable/invalid dates
        }
    }

    #isValidAction(action) {
        return VALID_ACTIONS.includes(action);
    }

    // Static time frame checker - useful utility, not directly part of index logic
    // but was present in the original file context you provided.
    static isWithinTimeFrame(dateString, timeFrameIdentifier) {
        const date = parseISO(dateString); // parseISO is from date-fns
        const timeFrameChecks = {
            today: isToday,
            yesterday: isYesterday,
            thisWeek: isThisWeek,
            thisISOWeek: isThisISOWeek,
            thisMonth: isThisMonth,
            thisQuarter: isThisQuarter,
            thisYear: isThisYear,
        };
        return timeFrameChecks[timeFrameIdentifier]?.(date) ?? false;
    }
}
