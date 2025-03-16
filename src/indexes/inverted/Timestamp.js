'use strict';

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

export default class TimestampIndex {

    constructor(backingStore, actionBitmaps) {
        if (!backingStore) { throw new Error('backingStore reference required'); }
        if (!actionBitmaps) { throw new Error('actionBitmaps reference required'); }
        this.store = backingStore;
        this.actionBitmaps = actionBitmaps;
    }

    /**
     * Get the number of documents in the index
     * @returns {number} The number of documents in the index
     */
    getCount() {
        return this.store.getCount();
    }

    /**
     * Insert a document ID with its timestamp and action
     * @param {string} action - The action type (created, updated, deleted)
     * @param {string} timestamp - ISO timestamp string
     * @param {string|number} id - Document ID
     */
    insert(action, timestamp, id) {
        if (!action || !timestamp || !id) {
            throw new Error('action, timestamp, and id are required');
        }

        if (typeof timestamp !== 'string') {
            throw new Error('timestamp must be a string');
        }

        // Validate action
        if (!this.actionBitmaps[action]) {
            throw new Error(`Invalid action: ${action}. Must be one of: created, updated, deleted`);
        }

        // Store timestamp => id mapping
        this.store.set(timestamp, id);

        // Add document ID to the appropriate action bitmap
        this.actionBitmaps[action].tick(id);
    }

    /**
     * Get document ID by exact timestamp
     * @param {string} timestamp - ISO timestamp string
     * @returns {Promise<string|number>} Document ID
     */
    async get(timestamp) {
        return this.store.get(timestamp);
    }

    /**
     * Find document IDs by timestamp range
     * @param {string} rangeFrom - Starting timestamp
     * @param {string} rangeTo - Ending timestamp
     * @returns {Promise<Array>} Array of document IDs
     */
    async findByRange(rangeFrom, rangeTo) {
        if (!rangeFrom) {
            throw new Error("A starting range (rangeFrom) is required.");
        }
        if (!rangeTo) {
            throw new Error("An ending range (rangeTo) is required.");
        }

        const documentIds = [];

        for await (const { key, value } of this.store.getRange({ start: rangeFrom, end: rangeTo })) {
            documentIds.push(value);
        }

        return documentIds;
    }

    /**
     * Find document IDs by timestamp range and action
     * @param {string} action - The action type (created, updated, deleted)
     * @param {string} rangeFrom - Starting timestamp
     * @param {string} rangeTo - Ending timestamp
     * @returns {Promise<Array>} Array of document IDs
     */
    async findByRangeAndAction(action, rangeFrom, rangeTo) {
        if (!action) {
            throw new Error("An action is required.");
        }

        // Validate action
        if (!this.actionBitmaps[action]) {
            throw new Error(`Invalid action: ${action}. Must be one of: created, updated, deleted`);
        }

        // Get all document IDs in the timestamp range
        const rangeIds = await this.findByRange(rangeFrom, rangeTo);

        // Get the action bitmap
        const actionBitmap = this.actionBitmaps[action];

        // Filter IDs by checking if they exist in the action bitmap
        return rangeIds.filter(id => actionBitmap.has(id));
    }

    /**
     * Delete a timestamp entry and remove the ID from action bitmaps if needed
     * @param {string} timestamp - ISO timestamp string
     * @param {boolean} removeFromBitmaps - Whether to remove the ID from action bitmaps
     * @returns {Promise<boolean>} Success status
     */
    async delete(timestamp, removeFromBitmaps = true) {
        const id = await this.get(timestamp);

        if (id && removeFromBitmaps) {
            // Remove from all action bitmaps
            Object.values(this.actionBitmaps).forEach(bitmap => {
                if (bitmap.has(id)) {
                    bitmap.remove(id);
                }
            });
        }

        return this.store.delete(timestamp);
    }

    /**
     * Check if a timestamp exists
     * @param {string} timestamp - ISO timestamp string
     * @returns {Promise<boolean>} Whether the timestamp exists
     */
    async has(timestamp) {
        return this.store.has(timestamp);
    }

    /**
     * List document IDs by timestamp prefix
     * @param {string} prefix - Timestamp prefix (e.g., '2025', '202502', etc.)
     * @returns {Promise<Array>} Array of document IDs
     */
    async list(prefix) {
        if (!prefix) {
            throw new Error("A timestamp prefix is required.");
        }

        const documentIds = [];

        // For prefix-based queries, use the prefix as the lower bound
        // and append '\uffff' to capture all keys starting with the prefix
        // Should work with:
        // 2025 # all documents from 2025
        // 202502 # all documents from February 2025
        // 20250210 # all documents from February 10, 2025
        // 2025021015 # all documents from February 10, 2025 at 15:00
        // 202502101545 # all documents from February 10, 2025 at 15:45
        // 20250210154523 # all documents from February 10, 2025 at 15:45:23
        // 20250210154523.1234 # all documents from February 10, 2025 at 15:45:23.1234
        const lowerBound = prefix;
        const upperBound = prefix + '\uffff';

        for await (const { key, value } of this.store.getRange({ start: lowerBound, end: upperBound })) {
            documentIds.push(value);
        }

        return documentIds;
    }

    /**
     * List document IDs by timestamp prefix and action
     * @param {string} action - The action type (created, updated, deleted)
     * @param {string} prefix - Timestamp prefix (e.g., '2025', '202502', etc.)
     * @returns {Promise<Array>} Array of document IDs
     */
    async listByAction(action, prefix) {
        if (!action) {
            throw new Error("An action is required.");
        }

        // Validate action
        if (!this.actionBitmaps[action]) {
            throw new Error(`Invalid action: ${action}. Must be one of: created, updated, deleted`);
        }

        // Get all document IDs matching the prefix
        const prefixIds = await this.list(prefix);

        // Get the action bitmap
        const actionBitmap = this.actionBitmaps[action];

        // Filter IDs by checking if they exist in the action bitmap
        return prefixIds.filter(id => actionBitmap.has(id));
    }

    /**
     * Get all document IDs for a specific action
     * @param {string} action - The action type (created, updated, deleted)
     * @returns {Array} Array of document IDs
     */
    getByAction(action) {
        if (!action) {
            throw new Error("An action is required.");
        }

        // Validate action
        if (!this.actionBitmaps[action]) {
            throw new Error(`Invalid action: ${action}. Must be one of: created, updated, deleted`);
        }

        // Return all IDs in the action bitmap
        return this.actionBitmaps[action].toArray();
    }

    static isWithinTimeFrame(dateString, timeFrameIdentifier) {
        const date = parseISO(dateString);
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
