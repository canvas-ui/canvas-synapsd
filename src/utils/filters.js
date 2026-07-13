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

export const CRUD_TIMEFRAMES = new Set([
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

    // Named wall-clock timeframes (today, thisWeek, …) resolve on ANY timeline —
    // crud lifecycle, but also wall-clock content axes like 'tasks' due dates
    // (t:tasks:today = "due today"). Deep-time axes simply won't match them.
    if (CRUD_TIMEFRAMES.has(specStr)) {
        const { start, end } = TimelineIndex.getTimeframeBounds(specStr);
        return { name, start, end };
    }
    if (specStr.includes('..')) {
        const [start, end] = specStr.split('..');
        return { name, start, end };
    }
    return { name, start: specStr, end: specStr };
}

// Resolve a geo token body (already stripped of `geo:`) to a typed filter.
// Forms:
//   geo:bbox:<minLat>,<minLon>,<maxLat>,<maxLon>   viewport / mapbox rect
//   geo:near:<lat>,<lon>,<radius[m|km]>            spherical-cap radius
//   geo:cell:<s2CellId>[,<s2CellId>...]            explicit S2 cells (decimal ids)
function parseGeoToken(rest) {
    const idx = rest.indexOf(':');
    if (idx < 0) { return null; }
    const kind = rest.slice(0, idx);
    const args = rest.slice(idx + 1).split(',').map((s) => s.trim()).filter(Boolean);

    if (kind === 'bbox' && args.length === 4) {
        const [minLat, minLon, maxLat, maxLon] = args.map(Number);
        if ([minLat, minLon, maxLat, maxLon].every(Number.isFinite)) {
            return { kind, minLat, minLon, maxLat, maxLon };
        }
    } else if (kind === 'near' && args.length === 3) {
        const lat = Number(args[0]);
        const lon = Number(args[1]);
        const radius = args[2].match(/^(\d+(?:\.\d+)?)(km|m)?$/i);
        if (Number.isFinite(lat) && Number.isFinite(lon) && radius) {
            const radiusMeters = Number(radius[1]) * (radius[2]?.toLowerCase() === 'km' ? 1000 : 1);
            return { kind, lat, lon, radiusMeters };
        }
    } else if (kind === 'cell' && args.length > 0 && args.every((a) => /^\d+$/.test(a))) {
        return { kind, cells: args };
    }
    return null;
}

/**
 * Partition a filter token array into bitmap-key filters (ANDed) and
 * sigil-tagged timeline / geo filters.
 * @param {Array} filterArray
 * @returns {{ bitmapFilters: Array, timelineFilters: Array<{sigil,name,start,end}>, geoFilters: Array<{sigil,kind,...}> }}
 */
export function parseFilters(filterArray) {
    const bitmapFilters = [];
    const timelineFilters = [];
    const geoFilters = [];

    for (const filter of filterArray) {
        if (typeof filter !== 'string') {
            bitmapFilters.push(filter);
            continue;
        }

        const { sigil, body } = splitSigil(filter);

        if (body.startsWith('t:')) {
            const parsed = parseTimelineToken(body.slice(2));
            if (parsed) { timelineFilters.push({ sigil, ...parsed }); }
        } else if (body.startsWith('geo:')) {
            const parsed = parseGeoToken(body.slice(4));
            if (parsed) { geoFilters.push({ sigil, ...parsed }); }
        } else if (body.startsWith('g:') || body.startsWith('re:')) {
            const kind = body.startsWith('g:') ? 'glob' : 'regexp';
            throw new Error(`Filter "${kind}" is not yet implemented`);
        } else {
            bitmapFilters.push(filter);
        }
    }

    return { bitmapFilters, timelineFilters, geoFilters };
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

/**
 * Resolve one geo filter to a bitmap of matching document IDs.
 * Candidate-set semantics: coverings are inclusive (may slightly overshoot the
 * region) — precise containment is the renderer's job via metadata.geo.
 * @param {{kind,...}} filter
 * @param {Object} geoIndex
 * @returns {Promise<RoaringBitmap32>}
 */
export async function applyGeoFilter(filter, geoIndex) {
    if (!geoIndex) { return new RoaringBitmap32(); }
    try {
        if (filter.kind === 'bbox') {
            return await geoIndex.queryBBox(filter.minLat, filter.minLon, filter.maxLat, filter.maxLon);
        }
        if (filter.kind === 'near') {
            return await geoIndex.queryRadius(filter.lat, filter.lon, filter.radiusMeters);
        }
        if (filter.kind === 'cell') {
            return await geoIndex.queryCells(filter.cells);
        }
        return new RoaringBitmap32();
    } catch (error) {
        debug(`Error applying geo filter: ${error.message}`);
        return new RoaringBitmap32();
    }
}
