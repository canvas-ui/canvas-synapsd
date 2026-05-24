'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:timestamp-index');
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Roaring = require('roaring');
const { RoaringBitmap32 } = Roaring;

import BitSlicedIndex from '../bitmaps/lib/BitSlicedIndex.js';

const BIT_DEPTH = 64;
const SIGNED_OFFSET = 1n << 63n;

const SCALE_ALIASES = {
    gyr: 'Gyr',
    gya: 'Gyr',
    by: 'Gyr',
    bya: 'Gyr',
    myr: 'Myr',
    mya: 'Myr',
    kyr: 'Kyr',
    kya: 'Kyr',
    year: 'year',
    years: 'year',
    y: 'year',
    month: 'month',
    months: 'month',
    day: 'day',
    days: 'day',
    d: 'day',
    second: 'second',
    seconds: 'second',
    sec: 'second',
    s: 'second',
    ms: 'ms',
    millisecond: 'ms',
    milliseconds: 'ms',
    ns: 'ns',
    nanosecond: 'ns',
    nanoseconds: 'ns',
};

const SCALES = ['Gyr', 'Myr', 'Kyr', 'year', 'month', 'day', 'second', 'ms', 'ns'];
const SCALE_ORDER = new Map(SCALES.map((scale, index) => [scale, index]));
const RANGE_MODES = new Set(['union', 'layers']);

/**
 * TimelineIndex maps source/domain timelines to internal scale tiers.
 *
 * Public timelines stay sane (`wikipedia`, `britannica`, `crud:updated`).
 * Internally, every timeline owns lazily-created Dual-BSI tiers:
 * `internal/ts/<timeline>/<scale>/start|end`.
 */
export default class TimelineIndex {
    constructor(bitmapIndex) {
        if (!bitmapIndex) { throw new Error('BitmapIndex required for TimelineIndex'); }
        this.bitmapIndex = bitmapIndex;
        this.timelines = {};
        debug(`TimelineIndex initialized with tiered Dual-BSI (${BIT_DEPTH}-bit per tier)`);
    }

    // ========================================
    // Timeline API
    // ========================================

    async createTimeline(name) {
        this.#assertTimelineName(name);
        this.getTimeline(name);
        await this.bitmapIndex.createBitmap(`internal/ts/${this.#timelineKey(name)}/meta`);
        return { name, scales: [...SCALES] };
    }

    getTimeline(name) {
        this.#assertTimelineName(name);
        if (!this.timelines[name]) { this.timelines[name] = new Map(); }
        return this.timelines[name];
    }

    async listTimelines() {
        const keys = await this.bitmapIndex.listBitmaps('internal/ts');
        const names = keys.map(key => this.#decodeTimelineKey(key.split('/')[2])).filter(Boolean);
        return [...new Set(names)];
    }

    hasTimeline(name) {
        this.#assertTimelineName(name);
        const key = this.#timelineKey(name);
        return this.bitmapIndex.hasBitmap(`internal/ts/${key}/meta`)
            || SCALES.some(scale => this.bitmapIndex.hasBitmap(`internal/ts/${key}/${scale}/start/ebm`));
    }

    async deleteTimeline(name) {
        this.#assertTimelineName(name);
        const keys = await this.bitmapIndex.listBitmaps(`internal/ts/${this.#timelineKey(name)}`);
        if (keys.length === 0) return false;

        for (const key of keys) {
            await this.bitmapIndex.deleteBitmap(key);
        }

        delete this.timelines[name];
        debug(`Deleted timeline '${name}' (removed ${keys.length} bitmaps)`);
        return true;
    }

    async getCount(timelineName) {
        this.#assertTimelineName(timelineName);
        const union = new RoaringBitmap32();

        for (const scale of SCALES) {
            const tier = this.#getTier(timelineName, scale);
            const ebm = await this.bitmapIndex.getBitmap(tier.start.ebmKey, false);
            if (ebm) { union.orInPlace(ebm); }
        }

        return union.size;
    }

    // ========================================
    // Index Writes
    // ========================================

    /**
     * Insert an interval into a named timeline.
     *
     * Supported shapes:
     * - insert('wikipedia', id, { start: '1720', end: '1720' })
     * - insert('geology', id, { start: '541 MYA', end: '252 MYA' })
     * - insert('crud:created', id, new Date())
     * - insert('wikipedia', id, '17200101', '17201231')
     */
    async insert(timelineName, id, startOrInterval, endVal = null) {
        this.#assertTimelineName(timelineName);
        if (id === undefined || id === null) { throw new Error('ID required for insert'); }
        if (startOrInterval === undefined || startOrInterval === null) { throw new Error('start required for insert'); }

        const interval = this.#normalizeInterval(startOrInterval, endVal);
        await this.createTimeline(timelineName);
        const tier = this.#getTier(timelineName, interval.scale);

        await Promise.all([
            tier.start.setValue(id, this.#encodeSigned(interval.start)),
            tier.end.setValue(id, this.#encodeSigned(interval.end)),
        ]);

        debug(`Set ID ${id} in timeline '${timelineName}/${interval.scale}' [${interval.start}, ${interval.end}]`);
        return true;
    }

    async remove(timelineName, id, options = {}) {
        this.#assertTimelineName(timelineName);
        if (id === undefined || id === null) { return false; }

        const scales = this.#selectScales(options.scales || options.scale);
        await Promise.all(scales.flatMap((scale) => {
            const tier = this.#getTier(timelineName, scale);
            return [tier.start.removeValue(id), tier.end.removeValue(id)];
        }));

        debug(`Removed ID ${id} from timeline '${timelineName}'`);
        return true;
    }

    async removeFromAll(id) {
        if (id === undefined || id === null) { return false; }

        const timelines = await this.listTimelines();
        await Promise.all(timelines.map(timelineName => this.remove(timelineName, id)));

        debug(`Removed ID ${id} from all timelines`);
        return true;
    }

    // ========================================
    // Queries
    // ========================================

    /**
     * Query document IDs whose intervals overlap a range in one or more timelines.
     *
     * Query shapes:
     * - queryInterval('wikipedia', '1720', '1720')
     * - queryInterval('*', { start: '1720', end: '1720' })
     * - queryInterval(['wikipedia', 'britannica'], { start: '1720', end: '1720' }, { mode: 'layers' })
     * - queryInterval('geology', { start: '541 MYA', end: '252 MYA' }, { scales: ['Myr'] })
     */
    async queryInterval(timelineNames, queryStart, queryEnd = null, options = {}) {
        const { range, queryOptions } = this.#normalizeFindArgs(queryStart, queryEnd, options);
        const names = await this.#resolveTimelineNames(timelineNames);
        const mode = queryOptions.mode || 'union';
        if (!RANGE_MODES.has(mode)) { throw new Error(`Invalid timeline query mode: ${mode}`); }

        const scales = this.#selectQueryScales(range.scale, queryOptions);
        if (mode === 'layers') {
            return await this.#queryIntervalLayers(names, scales, range);
        }

        const union = new RoaringBitmap32();
        const bitmaps = await Promise.all(names.flatMap(name => (
            scales.map(scale => this.#queryIntervalBitmap(name, scale, range))
        )));

        for (const bitmap of bitmaps) {
            union.orInPlace(bitmap);
        }

        return union.toArray();
    }

    // ========================================
    // Timeframe Utilities
    // ========================================

    static getTimeframeBounds(timeframe) {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        const date = now.getDate();
        const dayMs = 86400000;
        const startOfToday = new Date(year, month, date);
        const startOfWeek = (() => {
            const day = now.getDay() || 7;
            return new Date(year, month, date - day + 1);
        })();

        let start, end;

        switch (timeframe) {
            case 'now':
                start = new Date(year, month, date, now.getHours());
                end = new Date(start.getTime() + 3600000 - 1);
                break;
            case 'today':
                start = startOfToday;
                end = new Date(start.getTime() + dayMs - 1);
                break;
            case 'yesterday':
                start = new Date(year, month, date - 1);
                end = new Date(start.getTime() + dayMs - 1);
                break;
            case 'tomorrow':
                start = new Date(year, month, date + 1);
                end = new Date(start.getTime() + dayMs - 1);
                break;
            case 'lastWeek':
                start = new Date(startOfWeek.getTime() - (7 * dayMs));
                end = new Date(startOfWeek.getTime() - 1);
                break;
            case 'thisWeek': {
                start = startOfWeek;
                end = new Date(start.getTime() + 7 * dayMs - 1);
                break;
            }
            case 'nextWeek': {
                start = new Date(startOfWeek.getTime() + (7 * dayMs));
                end = new Date(start.getTime() + 7 * dayMs - 1);
                break;
            }
            case 'lastMonth':
                start = new Date(year, month - 1, 1);
                end = new Date(year, month, 0, 23, 59, 59, 999);
                break;
            case 'thisMonth':
                start = new Date(year, month, 1);
                end = new Date(year, month + 1, 0, 23, 59, 59, 999);
                break;
            case 'nextMonth':
                start = new Date(year, month + 1, 1);
                end = new Date(year, month + 2, 0, 23, 59, 59, 999);
                break;
            case 'lastYear':
                start = new Date(year - 1, 0, 1);
                end = new Date(year - 1, 11, 31, 23, 59, 59, 999);
                break;
            case 'thisYear':
                start = new Date(year, 0, 1);
                end = new Date(year, 11, 31, 23, 59, 59, 999);
                break;
            case 'nextYear':
                start = new Date(year + 1, 0, 1);
                end = new Date(year + 1, 11, 31, 23, 59, 59, 999);
                break;
            case 'lastDecade': {
                const decadeStart = Math.floor(year / 10) * 10;
                start = new Date(decadeStart - 10, 0, 1);
                end = new Date(decadeStart - 1, 11, 31, 23, 59, 59, 999);
                break;
            }
            case 'thisDecade': {
                const decadeStart = Math.floor(year / 10) * 10;
                start = new Date(decadeStart, 0, 1);
                end = new Date(decadeStart + 9, 11, 31, 23, 59, 59, 999);
                break;
            }
            case 'nextDecade': {
                const decadeStart = Math.floor(year / 10) * 10;
                start = new Date(decadeStart + 10, 0, 1);
                end = new Date(decadeStart + 19, 11, 31, 23, 59, 59, 999);
                break;
            }
            case 'lastCentury': {
                const centuryStart = Math.floor(year / 100) * 100;
                start = new Date(centuryStart - 100, 0, 1);
                end = new Date(centuryStart - 1, 11, 31, 23, 59, 59, 999);
                break;
            }
            case 'thisCentury': {
                const centuryStart = Math.floor(year / 100) * 100;
                start = new Date(centuryStart, 0, 1);
                end = new Date(centuryStart + 99, 11, 31, 23, 59, 59, 999);
                break;
            }
            case 'nextCentury': {
                const centuryStart = Math.floor(year / 100) * 100;
                start = new Date(centuryStart + 100, 0, 1);
                end = new Date(centuryStart + 199, 11, 31, 23, 59, 59, 999);
                break;
            }
            case 'lastMillennium': {
                const millStart = Math.floor(year / 1000) * 1000;
                start = new Date(millStart - 1000, 0, 1);
                end = new Date(millStart - 1, 11, 31, 23, 59, 59, 999);
                break;
            }
            case 'thisMillennium': {
                const millStart = Math.floor(year / 1000) * 1000;
                start = new Date(millStart, 0, 1);
                end = new Date(millStart + 999, 11, 31, 23, 59, 59, 999);
                break;
            }
            case 'nextMillennium': {
                const millStart = Math.floor(year / 1000) * 1000;
                start = new Date(millStart + 1000, 0, 1);
                end = new Date(millStart + 1999, 11, 31, 23, 59, 59, 999);
                break;
            }
            default:
                throw new Error(`Invalid timeframe: ${timeframe}`);
        }

        return { start: start.toISOString(), end: end.toISOString() };
    }

    // ========================================
    // Query Helpers
    // ========================================

    async #queryIntervalLayers(names, scales, range) {
        const layers = {};

        for (const name of names) {
            this.#assertTimelineName(name);
            layers[name] = {};

            for (const scale of scales) {
                const bitmap = await this.#queryIntervalBitmap(name, scale, range);
                const ids = bitmap.toArray();
                if (ids.length > 0) { layers[name][scale] = ids; }
            }
        }

        return layers;
    }

    async #resolveTimelineNames(timelineNames) {
        if (timelineNames === '*' || timelineNames === 'all') {
            return await this.listTimelines();
        }

        const names = Array.isArray(timelineNames) ? timelineNames : [timelineNames];
        for (const name of names) {
            this.#assertTimelineName(name);
        }
        return names;
    }

    async #queryIntervalBitmap(name, scale, range) {
        this.#assertTimelineName(name);
        const tierRange = this.#convertRangeToScale(range, scale);
        const tier = this.#getTier(name, scale);

        const [startMatches, endMatches] = await Promise.all([
            tier.start.query('<=', this.#encodeSigned(tierRange.end)),
            tier.end.query('>=', this.#encodeSigned(tierRange.start)),
        ]);

        return RoaringBitmap32.and(startMatches, endMatches);
    }

    #normalizeFindArgs(queryStart, queryEnd, options) {
        if (queryStart && typeof queryStart === 'object' && !(queryStart instanceof Date) && !Array.isArray(queryStart)) {
            if ('start' in queryStart || 'end' in queryStart) {
                const range = this.#normalizeInterval(queryStart);
                const queryOptions = queryEnd && typeof queryEnd === 'object' && !(queryEnd instanceof Date) ? queryEnd : options;
                return { range, queryOptions };
            }
        }

        return {
            range: this.#normalizeInterval({ start: queryStart, end: queryEnd ?? queryStart }),
            queryOptions: options,
        };
    }

    #selectQueryScales(queryScale, options = {}) {
        if (options.scale || options.scales) { return this.#selectScales(options.scales || options.scale); }
        if (!queryScale) return [...SCALES];
        this.#normalizeScale(queryScale);
        return [...SCALES];
    }

    #selectScales(scales) {
        if (!scales) return [...SCALES];
        const selected = Array.isArray(scales) ? scales : [scales];
        return selected.map(scale => this.#normalizeScale(scale));
    }

    // ========================================
    // Normalization
    // ========================================

    #normalizeInterval(startOrInterval, endVal = null) {
        const startInput = this.#extractEndpoint(startOrInterval, 'start');
        const endInput = this.#extractEndpoint(
            endVal !== null && endVal !== undefined ? endVal : startOrInterval,
            'end',
            startInput
        );

        const start = this.#normalizeEndpoint(startInput);
        const end = this.#normalizeEndpoint(endInput, start.scale);
        const scale = start.scale === end.scale ? start.scale : this.#coarserScale(start.scale, end.scale);

        const startValue = this.#convertValue(start, scale);
        const endValue = this.#convertValue(end, scale);
        if (startValue > endValue) { throw new Error(`Invalid timeline interval: start must be <= end`); }

        return { scale, start: startValue, end: endValue };
    }

    #extractEndpoint(input, field, fallback = null) {
        if (input && typeof input === 'object' && !(input instanceof Date) && !Array.isArray(input)) {
            if (field in input) { return input[field]; }
            if ('value' in input || 'scale' in input) { return input; }
        }
        return fallback || input;
    }

    #normalizeEndpoint(input, fallbackScale = null) {
        if (input && typeof input === 'object' && !(input instanceof Date) && !Array.isArray(input)) {
            const scale = input.scale ? this.#normalizeScale(input.scale) : fallbackScale;
            if (!scale) {
                return this.#inferEndpoint(input.value);
            }
            return { scale, value: this.#parseValueForScale(input.value, scale) };
        }

        const inferred = this.#inferEndpoint(input);
        if (fallbackScale && inferred.scale !== fallbackScale) {
            return { scale: fallbackScale, value: this.#convertValue(inferred, fallbackScale) };
        }
        return inferred;
    }

    #inferEndpoint(input) {
        if (typeof input === 'bigint') { return { scale: 'second', value: input }; }
        if (input instanceof Date) { return { scale: 'ms', value: BigInt(input.getTime()) }; }
        if (typeof input === 'number') {
            if (!Number.isFinite(input)) { throw new Error(`Invalid timeline number: ${input}`); }
            if (!Number.isInteger(input)) { throw new Error(`Timeline numbers must be integers or explicit scaled objects`); }
            return { scale: 'ms', value: BigInt(input) };
        }
        if (typeof input !== 'string') { throw new Error(`Unsupported timeline value: ${String(input)}`); }

        const value = input.trim();
        if (!value) { throw new Error('Timeline value cannot be empty'); }

        const relative = this.#parseRelativeAge(value);
        if (relative) return relative;

        if (/^-?\d{1,6}$/.test(value)) {
            return { scale: 'year', value: BigInt(value) - 1970n };
        }

        if (/^\d{8}$/.test(value)) {
            return { scale: 'day', value: this.#parseCompactDay(value) };
        }

        if (/^-?\d{1,6}-\d{2}$/.test(value)) {
            return { scale: 'month', value: this.#parseMonth(value) };
        }

        if (/^-?\d{1,6}-\d{2}-\d{2}$/.test(value)) {
            return { scale: 'day', value: this.#parseIsoDay(value) };
        }

        const ms = Date.parse(value);
        if (Number.isNaN(ms)) { throw new Error(`Unknown timeline value or scale: ${input}`); }

        return {
            scale: value.includes('.') ? 'ms' : 'second',
            value: value.includes('.') ? BigInt(ms) : BigInt(Math.floor(ms / 1000)),
        };
    }

    #parseValueForScale(input, scale) {
        if (typeof input === 'bigint') return input;
        if (typeof input === 'number') {
            if (!Number.isFinite(input) || !Number.isInteger(input)) {
                throw new Error(`Invalid ${scale} timeline value: ${input}`);
            }
            return BigInt(input);
        }
        if (input instanceof Date) {
            return this.#convertValue({ scale: 'ms', value: BigInt(input.getTime()) }, scale);
        }
        if (typeof input !== 'string') { throw new Error(`Invalid ${scale} timeline value: ${String(input)}`); }

        const inferred = this.#inferEndpoint(input);
        return this.#convertValue(inferred, scale);
    }

    #parseRelativeAge(value) {
        const match = value.match(/^(-?\d+(?:\.\d+)?)\s*(gya|gyr|bya|mya|myr|kya|kyr)$/i);
        if (!match) return null;

        const scale = this.#normalizeScale(match[2]);
        const amount = this.#decimalToBigInt(match[1]);
        return { scale, value: -amount };
    }

    #parseCompactDay(value) {
        const year = BigInt(value.slice(0, 4));
        const month = BigInt(value.slice(4, 6));
        const day = BigInt(value.slice(6, 8));
        return this.#daysFromCivil(year, month, day);
    }

    #parseIsoDay(value) {
        const [year, month, day] = value.split('-').map(part => BigInt(part));
        return this.#daysFromCivil(year, month, day);
    }

    #parseMonth(value) {
        const [year, month] = value.split('-').map(part => BigInt(part));
        if (month < 1n || month > 12n) { throw new Error(`Invalid month timeline value: ${value}`); }
        return ((year - 1970n) * 12n) + (month - 1n);
    }

    #convertRangeToScale(range, scale) {
        const sourceScale = this.#normalizeScale(range.scale);
        const targetScale = this.#normalizeScale(scale);
        if (sourceScale === targetScale) {
            return { start: range.start, end: range.end };
        }

        const calendarRange = this.#convertCalendarRange(sourceScale, targetScale, range);
        if (calendarRange) return calendarRange;

        const sourceIndex = SCALE_ORDER.get(sourceScale);
        const targetIndex = SCALE_ORDER.get(targetScale);

        if (sourceIndex < targetIndex) {
            const factor = this.#factorBetween(sourceScale, targetScale);
            return {
                start: range.start * factor,
                end: ((range.end + 1n) * factor) - 1n,
            };
        }

        const factor = this.#factorBetween(targetScale, sourceScale);
        return {
            start: this.#floorDiv(range.start, factor),
            end: this.#floorDiv(range.end, factor),
        };
    }

    #convertValue(endpoint, targetScale) {
        const sourceScale = this.#normalizeScale(endpoint.scale);
        const target = this.#normalizeScale(targetScale);
        if (sourceScale === target) return endpoint.value;

        const sourceIndex = SCALE_ORDER.get(sourceScale);
        const targetIndex = SCALE_ORDER.get(target);
        if (sourceIndex < targetIndex) {
            throw new Error(`Cannot upsample ${sourceScale} timeline value to ${target}; precision would be fake`);
        }

        const calendarValue = this.#convertCalendarValue(sourceScale, target, endpoint.value);
        if (calendarValue !== null) return calendarValue;

        return this.#floorDiv(endpoint.value, this.#factorBetween(target, sourceScale));
    }

    #coarserScale(a, b) {
        return SCALE_ORDER.get(a) <= SCALE_ORDER.get(b) ? a : b;
    }

    #factorBetween(coarserScale, finerScale) {
        const coarserIndex = SCALE_ORDER.get(coarserScale);
        const finerIndex = SCALE_ORDER.get(finerScale);
        if (coarserIndex > finerIndex) {
            throw new Error(`Cannot compute scale factor from ${coarserScale} to ${finerScale}`);
        }

        let factor = 1n;
        for (let i = coarserIndex; i < finerIndex; i++) {
            factor *= this.#adjacentScaleFactor(SCALES[i], SCALES[i + 1]);
        }
        return factor;
    }

    #adjacentScaleFactor(coarserScale, finerScale) {
        const key = `${coarserScale}:${finerScale}`;
        switch (key) {
            case 'Gyr:Myr': return 1000n;
            case 'Myr:Kyr': return 1000n;
            case 'Kyr:year': return 1000n;
            case 'year:month': return 12n;
            case 'month:day': return 31n;
            case 'day:second': return 86400n;
            case 'second:ms': return 1000n;
            case 'ms:ns': return 1000000n;
            default:
                throw new Error(`Unsupported adjacent timeline scale conversion: ${key}`);
        }
    }

    #normalizeScale(scale) {
        const normalized = SCALE_ALIASES[String(scale).trim().toLowerCase()];
        if (!normalized) { throw new Error(`Unknown timeline scale: ${scale}`); }
        return normalized;
    }

    #getTier(timelineName, scale) {
        const timeline = this.getTimeline(timelineName);
        const normalizedScale = this.#normalizeScale(scale);

        if (!timeline.has(normalizedScale)) {
            const key = this.#timelineKey(timelineName);
            timeline.set(normalizedScale, {
                start: new BitSlicedIndex(`internal/ts/${key}/${normalizedScale}/start`, this.bitmapIndex, BIT_DEPTH),
                end: new BitSlicedIndex(`internal/ts/${key}/${normalizedScale}/end`, this.bitmapIndex, BIT_DEPTH),
            });
        }

        return timeline.get(normalizedScale);
    }

    #encodeSigned(value) {
        const encoded = value + SIGNED_OFFSET;
        if (encoded < 0n || encoded >= (1n << BigInt(BIT_DEPTH))) {
            throw new Error(`Timeline value ${value} out of signed ${BIT_DEPTH}-bit range`);
        }
        return encoded;
    }

    #assertTimelineName(name) {
        if (!name || typeof name !== 'string') { throw new Error('Timeline name must be a non-empty string'); }
    }

    #timelineKey(name) {
        return name.replace(/[^a-zA-Z0-9_-]/g, char => `_x${char.charCodeAt(0).toString(16)}_`).toLowerCase();
    }

    #decodeTimelineKey(key) {
        if (!key) return null;
        return key.replace(/_x([0-9a-f]+)_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }

    #decimalToBigInt(value) {
        if (!value.includes('.')) return BigInt(value);
        return BigInt(Math.trunc(Number(value)));
    }

    #floorDiv(a, b) {
        const quotient = a / b;
        const remainder = a % b;
        return remainder !== 0n && a < 0n ? quotient - 1n : quotient;
    }

    #convertCalendarRange(sourceScale, targetScale, range) {
        const start = this.#convertCalendarBoundary(sourceScale, targetScale, range.start, 'start');
        const end = this.#convertCalendarBoundary(sourceScale, targetScale, range.end, 'end');
        if (start === null || end === null) return null;
        return { start, end };
    }

    #convertCalendarBoundary(sourceScale, targetScale, value, boundary) {
        if (sourceScale === 'year' && targetScale === 'month') {
            return boundary === 'start' ? value * 12n : ((value + 1n) * 12n) - 1n;
        }
        if (sourceScale === 'year' && targetScale === 'day') {
            const year = value + 1970n;
            return boundary === 'start'
                ? this.#daysFromCivil(year, 1n, 1n)
                : this.#daysFromCivil(year, 12n, 31n);
        }
        if (sourceScale === 'year' && ['second', 'ms', 'ns'].includes(targetScale)) {
            const day = this.#convertCalendarBoundary(sourceScale, 'day', value, boundary);
            return this.#convertCalendarBoundary('day', targetScale, day, boundary);
        }
        if (sourceScale === 'month' && targetScale === 'day') {
            const { year, month } = this.#civilMonth(value);
            return boundary === 'start'
                ? this.#daysFromCivil(year, month, 1n)
                : this.#daysFromCivil(year, month + 1n, 1n) - 1n;
        }
        if (sourceScale === 'month' && ['second', 'ms', 'ns'].includes(targetScale)) {
            const day = this.#convertCalendarBoundary(sourceScale, 'day', value, boundary);
            return this.#convertCalendarBoundary('day', targetScale, day, boundary);
        }
        if (sourceScale === 'day' && targetScale === 'second') {
            return boundary === 'start' ? value * 86400n : ((value + 1n) * 86400n) - 1n;
        }
        if (sourceScale === 'day' && targetScale === 'ms') {
            return boundary === 'start' ? value * 86400000n : ((value + 1n) * 86400000n) - 1n;
        }
        if (sourceScale === 'day' && targetScale === 'ns') {
            return boundary === 'start' ? value * 86400000000000n : ((value + 1n) * 86400000000000n) - 1n;
        }
        if (sourceScale === 'second' && targetScale === 'ms') {
            return boundary === 'start' ? value * 1000n : ((value + 1n) * 1000n) - 1n;
        }
        if (sourceScale === 'second' && targetScale === 'ns') {
            return boundary === 'start' ? value * 1000000000n : ((value + 1n) * 1000000000n) - 1n;
        }
        if (sourceScale === 'ms' && targetScale === 'ns') {
            return boundary === 'start' ? value * 1000000n : ((value + 1n) * 1000000n) - 1n;
        }

        const valueResult = this.#convertCalendarValue(sourceScale, targetScale, value);
        return valueResult;
    }

    #convertCalendarValue(sourceScale, targetScale, value) {
        if (sourceScale === 'day' && targetScale === 'month') return this.#monthFromDay(value);
        if (sourceScale === 'day' && targetScale === 'year') return this.#yearFromDay(value);
        if (sourceScale === 'month' && targetScale === 'year') return this.#floorDiv(value, 12n);
        if (sourceScale === 'second' && targetScale === 'day') return this.#floorDiv(value, 86400n);
        if (sourceScale === 'ms' && targetScale === 'day') return this.#floorDiv(value, 86400000n);
        if (sourceScale === 'ns' && targetScale === 'day') return this.#floorDiv(value, 86400000000000n);
        if (sourceScale === 'ms' && targetScale === 'second') return this.#floorDiv(value, 1000n);
        if (sourceScale === 'ns' && targetScale === 'second') return this.#floorDiv(value, 1000000000n);
        if (sourceScale === 'ns' && targetScale === 'ms') return this.#floorDiv(value, 1000000n);
        if (['second', 'ms', 'ns'].includes(sourceScale) && ['month', 'year'].includes(targetScale)) {
            return this.#convertCalendarValue('day', targetScale, this.#convertCalendarValue(sourceScale, 'day', value));
        }
        if (sourceScale === 'day' && targetScale === 'Gyr') return this.#convertValue({ scale: 'year', value: this.#yearFromDay(value) }, targetScale);
        if (sourceScale === 'month' && ['Gyr', 'Myr', 'Kyr'].includes(targetScale)) {
            return this.#convertValue({ scale: 'year', value: this.#floorDiv(value, 12n) }, targetScale);
        }
        if (['second', 'ms', 'ns'].includes(sourceScale) && ['Gyr', 'Myr', 'Kyr'].includes(targetScale)) {
            return this.#convertValue({ scale: 'year', value: this.#convertCalendarValue(sourceScale, 'year', value) }, targetScale);
        }
        return null;
    }

    #daysFromCivil(year, month, day) {
        if (month < 1n || month > 12n || day < 1n || day > 31n) {
            throw new Error('Invalid day timeline value');
        }

        year -= month <= 2n ? 1n : 0n;
        const era = this.#floorDiv(year, 400n);
        const yoe = year - era * 400n;
        const shiftedMonth = month + (month > 2n ? -3n : 9n);
        const doy = this.#floorDiv((153n * shiftedMonth) + 2n, 5n) + day - 1n;
        const doe = (yoe * 365n) + this.#floorDiv(yoe, 4n) - this.#floorDiv(yoe, 100n) + doy;
        return (era * 146097n) + doe - 719468n;
    }

    #civilFromDays(days) {
        const z = days + 719468n;
        const era = this.#floorDiv(z, 146097n);
        const doe = z - era * 146097n;
        const yoe = this.#floorDiv(doe - this.#floorDiv(doe, 1460n) + this.#floorDiv(doe, 36524n) - this.#floorDiv(doe, 146096n), 365n);
        const yearOfEra = yoe;
        const dayOfYear = doe - ((365n * yoe) + this.#floorDiv(yoe, 4n) - this.#floorDiv(yoe, 100n));
        const monthPrime = this.#floorDiv((5n * dayOfYear) + 2n, 153n);
        const day = dayOfYear - this.#floorDiv((153n * monthPrime) + 2n, 5n) + 1n;
        const month = monthPrime + (monthPrime < 10n ? 3n : -9n);
        const year = (era * 400n) + yearOfEra + (month <= 2n ? 1n : 0n);
        return { year, month, day };
    }

    #civilMonth(monthValue) {
        const yearOffset = this.#floorDiv(monthValue, 12n);
        const monthIndex = monthValue - (yearOffset * 12n);
        return { year: yearOffset + 1970n, month: monthIndex + 1n };
    }

    #monthFromDay(dayValue) {
        const { year, month } = this.#civilFromDays(dayValue);
        return ((year - 1970n) * 12n) + (month - 1n);
    }

    #yearFromDay(dayValue) {
        const { year } = this.#civilFromDays(dayValue);
        return year - 1970n;
    }
}
