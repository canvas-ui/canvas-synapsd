'use strict';

import debugInstance from 'debug';
import { createRequire } from 'module';
import TimelineIndex from '../indexes/inverted/Timeline.js';

const debug = debugInstance('canvas:synapsd:filters');
const require = createRequire(import.meta.url);
const { RoaringBitmap32 } = require('roaring');

// Filter grammar. Uniform surface `t:<name>:<spec>` (temporal), `g:` (glob),
// `re:` (regexp). Sigil algebra matches paths/features: default anyOf (OR),
// '+' = allOf (gate), '!' = noneOf (exclude). Anything else is treated as a
// raw bitmap key (ANDed). Glob/regexp are recognised but not yet implemented.

const CRUD_TIMEFRAMES = new Set([
    'now', 'today', 'yesterday', 'tomorrow',
    'lastWeek', 'thisWeek', 'nextWeek',
    'lastMonth', 'thisMonth', 'nextMonth',
    'lastYear', 'thisYear', 'nextYear',
    'lastDecade', 'thisDecade', 'nextDecade',
    'lastCentury', 'thisCentury', 'nextCentury',
    'lastMillennium', 'thisMillennium', 'nextMillennium',
]);

function splitSigil(token) {
    const t = String(token).trim();
    if (t.startsWith('+')) { return { sigil: 'allOf', body: t.slice(1).trim() }; }
    if (t.startsWith('!')) { return { sigil: 'noneOf', body: t.slice(1).trim() }; }
    return { sigil: 'anyOf', body: t };
}

// Resolve a timeline token body (already stripped of `t:`) to { name, start, end }.
// Relative crud timeframes resolve to absolute bounds here, at call time.
function parseTimelineToken(rest) {
    const segs = rest.split(':');
    let name, specStr;
    if (segs[0] === 'crud') {
        name = `crud:${segs[1]}`;
        specStr = segs.slice(2).join(':');
    } else {
        name = segs[0];
        specStr = segs.slice(1).join(':');
    }
    if (!name || !specStr) { return null; }

    if (name.startsWith('crud:') && CRUD_TIMEFRAMES.has(specStr)) {
        const { start, end } = TimelineIndex.getTimeframeBounds(specStr);
        return { name, start, end };
    }
    if (specStr.includes('..')) {
        const [start, end] = specStr.split('..');
        return { name, start, end };
    }
    return { name, start: specStr, end: specStr };
}

/**
 * Partition a filter token array into bitmap-key filters (ANDed) and
 * sigil-tagged timeline filters.
 * @param {Array} filterArray
 * @returns {{ bitmapFilters: Array, timelineFilters: Array<{sigil,name,start,end}> }}
 */
export function parseFilters(filterArray) {
    const bitmapFilters = [];
    const timelineFilters = [];

    for (const filter of filterArray) {
        if (typeof filter !== 'string') {
            bitmapFilters.push(filter);
            continue;
        }

        const { sigil, body } = splitSigil(filter);

        if (body.startsWith('t:')) {
            const parsed = parseTimelineToken(body.slice(2));
            if (parsed) { timelineFilters.push({ sigil, ...parsed }); }
        } else if (body.startsWith('g:') || body.startsWith('re:')) {
            const kind = body.startsWith('g:') ? 'glob' : 'regexp';
            throw new Error(`Filter "${kind}" is not yet implemented`);
        } else {
            bitmapFilters.push(filter);
        }
    }

    return { bitmapFilters, timelineFilters };
}

/**
 * Resolve one timeline filter to a bitmap of matching document IDs.
 * @param {{name,start,end}} filter
 * @param {Object} timelineIndex
 * @returns {Promise<RoaringBitmap32>}
 */
export async function applyTimelineFilter(filter, timelineIndex) {
    if (!timelineIndex) { return new RoaringBitmap32(); }
    try {
        const ids = await timelineIndex.queryInterval(filter.name, filter.start, filter.end);
        return ids && ids.length > 0 ? new RoaringBitmap32(ids) : new RoaringBitmap32();
    } catch (error) {
        debug(`Error applying timeline filter: ${error.message}`);
        return new RoaringBitmap32();
    }
}
