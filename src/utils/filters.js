'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:filters');

/**
 * Parse filterArray into bitmap filters and datetime filters
 * @param {Array} filterArray
 * @returns {{ bitmapFilters: Array, datetimeFilters: Array }}
 */
export function parseFilters(filterArray) {
    const bitmapFilters = [];
    const datetimeFilters = [];

    for (const filter of filterArray) {
        if (typeof filter === 'object' && filter !== null && filter.type === 'datetime') {
            datetimeFilters.push(filter);
        } else if (typeof filter === 'string' && filter.startsWith('datetime:')) {
            const parsed = parseDatetimeFilterString(filter);
            if (parsed) { datetimeFilters.push(parsed); }
        } else {
            bitmapFilters.push(filter);
        }
    }

    return { bitmapFilters, datetimeFilters };
}

/**
 * Parse string-based datetime filter into object format
 * Formats:
 *   datetime:ACTION:TIMEFRAME (e.g., datetime:updated:today)
 *   datetime:ACTION:range:START:END (e.g., datetime:created:range:2023-10-01:2023-10-31)
 * @param {string} filterString
 * @returns {Object|null}
 */
export function parseDatetimeFilterString(filterString) {
    const parts = filterString.split(':');
    if (parts.length < 3) { return null; }

    const [, action, specType, ...rest] = parts;
    if (!['created', 'updated', 'deleted'].includes(action)) { return null; }

    if (specType === 'range' && rest.length === 2) {
        return { type: 'datetime', action, range: { start: rest[0], end: rest[1] } };
    }

    const validTimeframes = ['today', 'yesterday', 'thisWeek', 'thisMonth', 'thisYear'];
    if (validTimeframes.includes(specType)) {
        return { type: 'datetime', action, timeframe: specType };
    }

    return null;
}

/**
 * Apply datetime filter and return bitmap of matching document IDs
 * @param {Object} filter - Parsed datetime filter
 * @param {Object} timestampIndex - TimestampIndex instance
 * @returns {RoaringBitmap32|null}
 */
export async function applyDatetimeFilter(filter, timestampIndex) {
    if (!timestampIndex) { return null; }

    try {
        const action = filter.action;
        let ids = [];

        if (filter.timeframe) {
            ids = await timestampIndex.findByTimeframe(filter.timeframe, action);
        } else if (filter.range) {
            ids = await timestampIndex.findByRangeAndAction(action, filter.range.start, filter.range.end);
        }

        if (ids.length > 0) {
            const roaring = await import('roaring');
            const { RoaringBitmap32 } = roaring.default || roaring;
            return new RoaringBitmap32(ids);
        }

        return null;
    } catch (error) {
        debug(`Error applying datetime filter: ${error.message}`);
        return null;
    }
}
