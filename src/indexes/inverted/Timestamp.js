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

    constructor(store, cache = new Map()) {
        if (!store) { throw new Error('A Map() like store reference required'); }
        this.store = store;
        this.cache = cache;
    }

    async get(checksum) {
        return this.store.get(checksum);
    }

    async set(checksum, id) {
        this.store.set(checksum, id);
    }

    async delete(checksum) {
        return this.store.delete(checksum);
    }

    async has(checksum) {
        return this.store.has(checksum);
    }

    // Should work with:
    // 2025 # all documents from 2025
    // 202502 # all documents from February 2025
    // 20250210 # all documents from February 10, 2025
    // 2025021015 # all documents from February 10, 2025 at 15:00
    // 202502101545 # all documents from February 10, 2025 at 15:45
    // 20250210154523 # all documents from February 10, 2025 at 15:45:23
    // 20250210154523.1234 # all documents from February 10, 2025 at 15:45:23.1234
    async list(rangeFrom, rangeTo) {
        if (!rangeFrom) {
            throw new Error("A starting range (rangeFrom) is required.");
        }

        // For prefix-based queries use 'rangeFrom' as the lower bound.
        const lowerBound = rangeFrom;

        // If 'rangeTo' is not provided, we assume a prefix query and append '\uffff' to capture all keys starting with rangeFrom.
        const upperBound = (rangeTo || rangeFrom) + '\uffff';

        const documentIds = [];

        // Use LMDB's range query API with "start" and "end".
        // It is assumed that keys in this dataset have the format "timestamp[/objectID]" and that the stored value
        // is the document ID. For example:
        //   "20250210154523.1234" (or "202502101545/123456") => documentID
        for await (const { key, value } of this.store.getRange({ start: lowerBound, end: upperBound })) {
            documentIds.push(value);
        }

        return documentIds;
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
