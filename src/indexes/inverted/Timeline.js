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

// Open-interval sentinels. An ongoing interval ("born 1912, still alive") stores
// its end as the max signed value, so the overlap test `end >= range.start` is
// always true on the upper side — it extends to +∞ with no query changes. The
// symmetric OPEN_START covers "since forever" (-∞, end]. These are scale-agnostic
// (already the BSI extreme), so they're stored verbatim in the bounded endpoint's
// scale tier and never scale-converted.
const OPEN_END_VALUE = (1n << 63n) - 1n;   // +∞ / ongoing
const OPEN_START_VALUE = -(1n << 63n);     // -∞ / since forever

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

// Membership plane (tsm) — tiled coverings, Pilosa time-quantum shaped, with
// an ADAPTIVE floor (settled 2026-08-18, supersedes fixed-per-timeline): the
// finest cell scale of a covering comes from each ENTRY's own notation
// ('1769' → year, '1769-08-15' → day, '541 MYA' → Myr), not from timeline
// config. One timeline carries geological eras, lifespans and single events
// at once, each tiled at its own precision — and rebuilds derive everything
// from rows alone, nothing config-dependent. Queries likewise decompose at
// the QUERY's notation-derived floor; the {c,a} two-plane probe is
// floor-agnostic (see the plane note below), so mixed floors stay sound.
// Sub-day floors clamp to 'day': the next tier below is 'second' (no
// hour/minute tier yet), and a day→second fan-out of 86400 would turn a
// single misaligned boundary into tens of thousands of cell writes.
const TSM_TILE_SCALES = new Set(['Gyr', 'Myr', 'Kyr', 'year', 'month', 'day']);
// union   → one flat id array across all timelines + scales
// layers  → { name: { scale: [ids] } } (per timeline, per scale)
// grouped → { name: [ids] } (per timeline, scales pre-unioned) — e.g. "zeitgeist
//           of year 600": one id list per timeline overlapping that instant
const RANGE_MODES = new Set(['union', 'layers', 'grouped']);

/**
 * TimelineIndex maps source/domain timelines to internal scale tiers.
 *
 * Public timelines stay sane (`wikipedia`, `britannica`, `crud:updated`).
 * Internally, every timeline owns lazily-created Dual-BSI tiers:
 * `internal/ts/<timeline>/<scale>/start|end`.
 */
export default class TimelineIndex {
    constructor(bitmapIndex, options = {}) {
        if (!bitmapIndex) { throw new Error('BitmapIndex required for TimelineIndex'); }
        this.bitmapIndex = bitmapIndex;
        this.timelines = {};
        // Point-event ("instant") timelines store a SINGLE BSI per tier (the
        // timestamp) instead of the interval Dual-BSI (start+end). For an instant
        // start === end, so the end BSI is pure duplication — a point tier halves
        // the bitmaps and slice-writes. crud:* lifecycle stamps are point by
        // convention; extra names can be registered via options.pointTimelines.
        this.#pointTimelines = new Set(options.pointTimelines || []);
        debug(`TimelineIndex initialized with tiered Dual-BSI (${BIT_DEPTH}-bit per tier)`);
    }

    #pointTimelines;

    // A timeline is point-mode (single-BSI instants) when its name is a crud:*
    // lifecycle stamp or explicitly registered. Deterministic by name so the mode
    // is stable across restarts without persisting it.
    #isPointTimeline(name) {
        return name.startsWith('crud:') || this.#pointTimelines.has(name);
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
        // 'internal/ts' and 'internal/tsm' are sibling namespaces (the range
        // scan is segment-bounded, so 'ts' does not match 'tsm') — but the
        // timeline-name segment sits at the same depth in both.
        const keys = [
            ...await this.bitmapIndex.listBitmaps('internal/ts'),
            ...await this.bitmapIndex.listBitmaps('internal/tsm'),
        ];
        const names = keys.map(key => this.#decodeTimelineKey(key.split('/')[2])).filter(Boolean);
        return [...new Set(names)];
    }

    hasTimeline(name) {
        this.#assertTimelineName(name);
        const key = this.#timelineKey(name);
        return this.bitmapIndex.hasBitmap(`internal/ts/${key}/meta`)
            || this.bitmapIndex.hasBitmap(`internal/tsm/${key}/meta`)
            || SCALES.some(scale =>
                this.bitmapIndex.hasBitmap(`internal/ts/${key}/${scale}/start/ebm`)
                || this.bitmapIndex.hasBitmap(`internal/ts/${key}/${scale}/ts/ebm`));
    }

    async deleteTimeline(name) {
        this.#assertTimelineName(name);
        const timelineKey = this.#timelineKey(name);
        const keys = [
            ...await this.bitmapIndex.listBitmaps(`internal/ts/${timelineKey}`),
            ...await this.bitmapIndex.listBitmaps(`internal/tsm/${timelineKey}`),
        ];
        if (keys.length === 0) {return false;}

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
            const ebmKey = tier.point ? tier.point.ebmKey : tier.start.ebmKey;
            const ebm = await this.bitmapIndex.getBitmap(ebmKey, false);
            if (ebm) { union.orInPlace(ebm); }
        }

        // Docs present only via non-primary positions (membership plane).
        if (this.bitmapIndex.hasBitmap(this.#tsmMetaKey(timelineName))) {
            const keys = await this.bitmapIndex.listBitmaps(`internal/tsm/${this.#timelineKey(timelineName)}`);
            const coverKeys = keys.filter((key) => this.#parseTsmKey(key)?.plane === 'c');
            union.orInPlace(await this.bitmapIndex.OR(coverKeys));
            for (const scale of this.#openScales(timelineName)) {
                const tier = this.#openTier(timelineName, scale);
                for (const bsi of [tier.start, tier.end]) {
                    const ebm = await this.bitmapIndex.getBitmap(bsi.ebmKey, false);
                    if (ebm) { union.orInPlace(ebm); }
                }
            }
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
    // endVal omitted (undefined) → instant (end = start). Pass an explicit open
    // marker (null / Infinity / 'ongoing') to record an open-ended interval.
    async insert(timelineName, id, startOrInterval, endVal) {
        this.#assertTimelineName(timelineName);
        if (id === undefined || id === null) { throw new Error('ID required for insert'); }
        if (startOrInterval === undefined || startOrInterval === null) { throw new Error('start required for insert'); }

        const interval = this.#normalizeInterval(startOrInterval, endVal);
        await this.createTimeline(timelineName);

        // crud:* are high-frequency lifecycle stamps (created/updated/deleted) fed
        // from JS Dates → ms scale. ms precision is spurious for them and widens
        // the BSI tier (~41 slice bitmaps vs ~31 at second) plus that many extra
        // slice writes per insert. Pin them to 'second'. Range queries are
        // unaffected: queryInterval scans every scale tier and converts the range.
        const writeScale = (timelineName.startsWith('crud:') && (interval.scale === 'ms' || interval.scale === 'ns'))
            ? 'second'
            : interval.scale;
        const start = writeScale === interval.scale ? interval.start : this.#convertValue({ scale: interval.scale, value: interval.start }, writeScale);
        const end = writeScale === interval.scale ? interval.end : this.#convertValue({ scale: interval.scale, value: interval.end }, writeScale);

        const tier = this.#getTier(timelineName, writeScale);

        if (tier.point) {
            // Instant: collapse to a single timestamp (start === end for a point;
            // a stray interval into a point timeline records its start instant).
            await tier.point.setValue(id, this.#encodeSigned(start));
            debug(`Set ID ${id} in point timeline '${timelineName}/${writeScale}' @${start}`);
        } else {
            await Promise.all([
                tier.start.setValue(id, this.#encodeSigned(start)),
                tier.end.setValue(id, this.#encodeSigned(end)),
            ]);
            debug(`Set ID ${id} in timeline '${timelineName}/${writeScale}' [${start}, ${end}]`);
        }
        return true;
    }

    async remove(timelineName, id, options = {}) {
        this.#assertTimelineName(timelineName);
        if (id === undefined || id === null) { return false; }

        const scales = this.#selectScales(options.scales || options.scale);
        await Promise.all(scales.flatMap((scale) => {
            const tier = this.#getTier(timelineName, scale);
            return tier.point
                ? [tier.point.removeValue(id)]
                : [tier.start.removeValue(id), tier.end.removeValue(id)];
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
    // Multi-position membership plane (tsm)
    // ========================================
    //
    // Several positions/ranges per document on one timeline. The dual-BSI above
    // stays the canonical sortable value plane holding ONE primary interval per
    // document; every additional position lives here, as tiled coverings:
    //
    //   internal/tsm/<timeline>/<scale>/c/<cellId>   "cover" plane
    //   internal/tsm/<timeline>/<scale>/a/<cellId>   "ancestor" plane
    //
    // Ingest decomposes an interval into its minimal hierarchical covering at
    // the ENTRY's own floor — its notation-derived scale, clamped to 'day'
    // (coarse cells mid-span, floor cells at the boundaries — the FeatureBase
    // viewsByTimeRange walk, generalized over our scale tiers and used at
    // ingest too, not just query time). Each covering cell is ticked in the
    // cover plane; its ancestors up to Gyr are ticked in the ancestor plane
    // ("this document has presence somewhere inside this coarse cell" — the
    // generalization of Pilosa writing an instant into every YMDH view).
    //
    // Query decomposes the range the same way and probes, for each query cell q
    // (q ⊆ range by construction):
    //   - cover(q) and anc(q): any tick at exactly q means presence inside q;
    //   - cover(ancestor(q)) for each ancestor: a COVER tick on a coarser cell
    //     means the document's interval contains that whole cell, hence q.
    // The two planes are what keep this sound: an ANCESTOR tick on a coarser
    // cell only says "presence somewhere inside", which does not imply overlap
    // with q — so ancestors of query cells are probed in the cover plane only.
    //
    // Precision follows the notation on BOTH sides (no row refinement in v1,
    // Pilosa precedent): an entry is stored as if rounded outward to whole
    // cells at its own floor, a query is answered as if rounded outward to
    // whole cells at its own floor — you get out the precision you put in.
    // Cell bitmaps hold doc ids, so results AND natively with context/feature/
    // geo filters. Everything here is L3: disposable, re-derived from rows.

    // Adaptive covering floor: the notation-derived scale itself when it is a
    // legal tile scale, else clamped to 'day' (sub-day notations: ISO
    // datetimes, Dates, epoch numbers).
    #tileFloor(scale) {
        const normalized = this.#normalizeScale(scale);
        return TSM_TILE_SCALES.has(normalized) ? normalized : 'day';
    }

    /**
     * Insert additional (non-primary) interval positions for a document into a
     * timeline's membership plane. Bounded intervals tile into {c,a} coverings;
     * open-ended intervals route to the open-interval sidecar (per-scale
     * dual-BSI, min/max collapse per doc — see the sidecar note below), so a
     * document can carry any number of ongoing facts on one timeline.
     *
     * @param {string} timelineName
     * @param {number} id document id
     * @param {Array} intervals - same value grammar as insert(): '1769-08-15',
     *        { start, end }, { scale, value }, Date, ...
     */
    async insertEntries(timelineName, id, intervals) {
        this.#assertTimelineName(timelineName);
        if (id === undefined || id === null) { throw new Error('ID required for insertEntries'); }
        const list = Array.isArray(intervals) ? intervals : [intervals];
        if (list.length === 0) { return true; }

        const keys = new Set();
        // side ('start'|'end') -> scale -> batch-collapsed sidecar value.
        const open = { start: new Map(), end: new Map() };
        for (const raw of list) {
            const interval = this.#normalizeEntryInterval(raw);
            if (interval.start === OPEN_START_VALUE || interval.end === OPEN_END_VALUE) {
                this.#collapseOpen(open, interval);
                continue;
            }
            for (const key of this.#tsmKeysForNormalized(interval, timelineName)) { keys.add(key); }
        }
        if (keys.size === 0 && open.start.size === 0 && open.end.size === 0) { return true; }

        await this.createTimeline(timelineName);
        // Presence marker: lets every query short-circuit the tsm probe for the
        // (overwhelmingly common) timelines that have no multi-position data.
        await this.bitmapIndex.createBitmap(this.#tsmMetaKey(timelineName));
        if (keys.size > 0) { await this.bitmapIndex.tickMany([...keys], id); }
        await this.#writeOpenSidecar(timelineName, id, open);
        debug(`tsm: set ID ${id} in '${timelineName}' across ${keys.size} cells (${list.length} intervals)`);
        return true;
    }

    /**
     * Remove a document from membership cells derived from the given intervals.
     * Tolerant by design: unticking a cell the document never occupied is a
     * no-op, and a malformed interval is skipped rather than thrown — this runs
     * on the way OUT (update/delete), where refusing would strand the row.
     *
     * Open intervals clear the doc's collapsed sidecar value for their
     * (side, scale): exact for the document write path (which removes ALL of
     * the row's entries and re-inserts the new set, re-deriving the collapse),
     * tolerant for a manual partial removal (re-insert the remaining open
     * entries to restore the marker).
     */
    async removeEntries(timelineName, id, intervals) {
        this.#assertTimelineName(timelineName);
        if (id === undefined || id === null) { return false; }
        if (!this.bitmapIndex.hasBitmap(this.#tsmMetaKey(timelineName))) { return true; }

        const keys = new Set();
        const openRemovals = [];
        for (const raw of (Array.isArray(intervals) ? intervals : [intervals])) {
            try {
                const interval = this.#normalizeEntryInterval(raw);
                if (interval.start === OPEN_START_VALUE || interval.end === OPEN_END_VALUE) {
                    openRemovals.push({
                        side: interval.end === OPEN_END_VALUE ? 'start' : 'end',
                        scale: interval.scale,
                    });
                    continue;
                }
                for (const key of this.#tsmKeysForNormalized(interval, timelineName)) { keys.add(key); }
            } catch (error) {
                debug(`tsm: skipping unremovable interval on '${timelineName}': ${error.message}`);
            }
        }
        if (keys.size > 0) { await this.bitmapIndex.untickMany([...keys], id); }
        for (const { side, scale } of openRemovals) {
            await this.#openTier(timelineName, scale)[side].removeValue(id);
        }
        return true;
    }

    /**
     * Decompose an interval/range into its minimal covering at the range's own
     * notation-derived floor. Public for tests, debugging and UIs that want to
     * see the tiling. (`timelineName` kept for signature stability; the floor
     * is adaptive, nothing timeline-specific remains.)
     *
     * @returns {{floor: string, cells: Array<{scale: string, cell: string}>}}
     */
    decomposeRange(timelineName, startOrInterval, endVal = undefined) {
        this.#assertTimelineName(timelineName);
        const range = (endVal === undefined)
            ? this.#normalizeEntryInterval(startOrInterval)
            : this.#normalizeInterval(startOrInterval, endVal);
        this.#assertBoundedInterval(range);
        const floor = this.#tileFloor(range.scale);
        const cells = this.#coverCells(range, floor);
        return { floor, cells: cells.map((c) => ({ scale: c.scale, cell: c.value.toString() })) };
    }

    // A raw entry value with no positional end: a bare value ('1769', a Date)
    // is an INSTANT, while an interval object carries its own start/end.
    // #normalizeInterval alone can't make that call — its missing-end default
    // is null, which reads as an open interval.
    #normalizeEntryInterval(raw) {
        const isIntervalObject = raw && typeof raw === 'object'
            && !(raw instanceof Date) && !Array.isArray(raw)
            && ('start' in raw || 'end' in raw);
        return isIntervalObject
            ? this.#normalizeInterval(raw)
            : this.#normalizeInterval({ start: raw, end: raw });
    }

    // Cover + ancestor keys for one normalized BOUNDED interval, at the
    // interval's own floor. Open intervals never reach here — insertEntries/
    // removeEntries partition them into the sidecar first.
    #tsmKeysForNormalized(interval, timelineName) {
        const floor = this.#tileFloor(interval.scale);
        const keys = [];
        for (const cell of this.#coverCells(interval, floor)) {
            keys.push(this.#tsmKey(timelineName, 'c', cell));
            for (const anc of this.#ancestorCells(cell)) {
                keys.push(this.#tsmKey(timelineName, 'a', anc));
            }
        }
        return keys;
    }

    #assertBoundedInterval(interval) {
        if (interval.start === OPEN_START_VALUE || interval.end === OPEN_END_VALUE) {
            throw new Error(
                'Open-ended intervals cannot be tiled; they live in the ' +
                'membership plane\'s open-interval sidecar, which decomposeRange ' +
                'does not cover',
            );
        }
    }

    // ── Open-interval sidecar ────────────────────────────────────────────
    //
    // Open-ended entries cannot be tiled (±∞ has no finite covering, and cell
    // identity matching cannot encode a one-sided comparison — that is what
    // BSI slice algebra does), so non-primary open intervals live in
    // per-scale dual-BSI sidecar tiers INSIDE the tsm plane:
    //
    //   internal/tsm/<tl>/open/<scale>/start   per doc: the start of its
    //                                          ongoing ([s,+∞)) entries
    //   internal/tsm/<tl>/open/<scale>/end     per doc: the end of its
    //                                          since-forever ((-∞,e]) entries
    //
    // ONE value per (doc, scale, side) is lossless for membership because
    // open intervals absorb: [s1,+∞) ∪ [s2,+∞) = [min(s1,s2),+∞) — so insert
    // min-collapses starts (max for ends) and the ROW keeps every entry + ref
    // verbatim; only the index collapses, and the index answers membership
    // only. Tiers are lazy and per-scale like everywhere else (adaptive: an
    // entry's tier is its notation-derived scale); a doc with ongoing facts
    // at several scales occupies several tiers and queries fan across them.
    // (-∞,+∞) stores as an ongoing entry whose start is the -∞ sentinel.

    #openTier(timelineName, scale) {
        const timeline = this.getTimeline(timelineName);
        const normalizedScale = this.#normalizeScale(scale);
        const cacheKey = `open/${normalizedScale}`;
        if (!timeline.has(cacheKey)) {
            const key = this.#timelineKey(timelineName);
            timeline.set(cacheKey, {
                start: new BitSlicedIndex(`internal/tsm/${key}/open/${normalizedScale}/start`, this.bitmapIndex, BIT_DEPTH),
                end: new BitSlicedIndex(`internal/tsm/${key}/open/${normalizedScale}/end`, this.bitmapIndex, BIT_DEPTH),
            });
        }
        return timeline.get(cacheKey);
    }

    // Scales with materialized sidecar tiers (either side).
    #openScales(name) {
        const key = this.#timelineKey(name);
        return SCALES.filter((scale) =>
            this.bitmapIndex.hasBitmap(`internal/tsm/${key}/open/${scale}/start/ebm`)
            || this.bitmapIndex.hasBitmap(`internal/tsm/${key}/open/${scale}/end/ebm`));
    }

    // Fold one normalized open interval into the batch collapse accumulator.
    #collapseOpen(open, interval) {
        const side = interval.end === OPEN_END_VALUE ? 'start' : 'end';
        const value = side === 'start' ? interval.start : interval.end;
        const perScale = open[side];
        const prior = perScale.get(interval.scale);
        if (prior === undefined) { perScale.set(interval.scale, value); return; }
        perScale.set(interval.scale, side === 'start'
            ? (value < prior ? value : prior)
            : (value > prior ? value : prior));
    }

    // Merge the batch collapse into the stored per-doc sidecar values.
    // setValue overwrites, so re-read the prior value and keep the absorbing
    // bound (min start / max end) — repeated inserts stay lossless.
    async #writeOpenSidecar(timelineName, id, open) {
        for (const side of ['start', 'end']) {
            for (const [scale, value] of open[side]) {
                const bsi = this.#openTier(timelineName, scale)[side];
                const one = new RoaringBitmap32([Number(id)]);
                const existing = await bsi.getValues(one);
                let merged = value;
                if (existing.has(Number(id))) {
                    const prior = existing.get(Number(id)) - SIGNED_OFFSET;
                    merged = side === 'start'
                        ? (prior < merged ? prior : merged)
                        : (prior > merged ? prior : merged);
                }
                await bsi.setValue(id, this.#encodeSigned(merged));
                debug(`tsm sidecar: doc ${id} '${timelineName}' open/${scale}/${side} = ${merged}`);
            }
        }
    }

    // Sidecar probe: ongoing docs ([s,+∞)) overlap the query iff s <= q.end;
    // since-forever docs ((-∞,e]) iff e >= q.start. An open query side drops
    // its bound — every doc in that BSI matches ([qs,+∞) overlaps every
    // [s,+∞)). Range endpoints convert outward to each tier's scale; a value
    // outside a tier's 64-bit window cannot match that tier and is skipped.
    async #querySidecar(name, range) {
        const union = new RoaringBitmap32();
        for (const scale of this.#openScales(name)) {
            const tier = this.#openTier(name, scale);
            if (range.end === OPEN_END_VALUE) {
                const ebm = await this.bitmapIndex.getBitmap(tier.start.ebmKey, false);
                if (ebm) { union.orInPlace(ebm); }
            } else {
                try {
                    const r = this.#convertRangeToScale({ scale: range.scale, start: range.end, end: range.end }, scale);
                    union.orInPlace(await tier.start.query('<=', this.#encodeSigned(r.end)));
                } catch { /* out of tier window */ }
            }
            if (range.start === OPEN_START_VALUE) {
                const ebm = await this.bitmapIndex.getBitmap(tier.end.ebmKey, false);
                if (ebm) { union.orInPlace(ebm); }
            } else {
                try {
                    const r = this.#convertRangeToScale({ scale: range.scale, start: range.start, end: range.start }, scale);
                    union.orInPlace(await tier.end.query('>=', this.#encodeSigned(r.start)));
                } catch { /* out of tier window */ }
            }
        }
        return union;
    }

    /**
     * Greedy minimal covering of a bounded interval: walk left to right, at
     * each position emitting the COARSEST cell that starts exactly here and
     * ends within the interval, then jump past it. Equivalent to FeatureBase's
     * viewsByTimeRange up-then-down walk (fine cells until boundary-aligned,
     * coarse cells mid-span, fine again at the tail), but expressed as one loop
     * and reused over our scale tiers — deep time included, where a calendar
     * walk can't follow. Calendar correctness (month lengths, leap years, the
     * Jan-31-plus-a-month family of edge cases) comes from the civil-calendar
     * conversion helpers, not from date arithmetic on a walking cursor.
     *
     * @param {{scale, start, end}} range normalized interval
     * @param {string} floor finest cell scale for this covering (the range's
     *        notation-derived floor, day-clamped)
     * @returns {Array<{scale: string, value: BigInt}>}
     */
    #coverCells(range, floor) {
        const floorIndex = SCALE_ORDER.get(floor);
        // Convert to floor scale: floors when the interval is finer than the
        // floor (outward rounding — the documented precision), expands to full
        // periods when coarser (a 'year' entry covers all its days).
        const r = this.#convertRangeToScale(range, floor);

        const cells = [];
        let t = r.start;
        while (t <= r.end) {
            let chosen = { scale: floor, value: t, endAtFloor: t };
            for (let k = 0; k < floorIndex; k++) {
                const scale = SCALES[k];
                const coarseValue = this.#convertValue({ scale: floor, value: t }, scale);
                const bounds = this.#convertRangeToScale({ scale, start: coarseValue, end: coarseValue }, floor);
                if (bounds.start === t && bounds.end <= r.end) {
                    chosen = { scale, value: coarseValue, endAtFloor: bounds.end };
                    break; // scales iterate coarse→fine; first fit is the coarsest
                }
            }
            cells.push({ scale: chosen.scale, value: chosen.value });
            t = chosen.endAtFloor + 1n;
        }
        return cells;
    }

    // All strictly-coarser cells containing this cell, up to Gyr.
    #ancestorCells(cell) {
        const ancestors = [];
        const cellIndex = SCALE_ORDER.get(cell.scale);
        for (let k = 0; k < cellIndex; k++) {
            ancestors.push({
                scale: SCALES[k],
                value: this.#convertValue({ scale: cell.scale, value: cell.value }, SCALES[k]),
            });
        }
        return ancestors;
    }

    // Union of documents whose non-primary positions overlap the range.
    async #queryMultiBitmap(name, range) {
        if (!this.bitmapIndex.hasBitmap(this.#tsmMetaKey(name))) { return new RoaringBitmap32(); }

        // Query floor = the QUERY's notation-derived scale (day-clamped) —
        // symmetric with ingest. Mixed floors are sound because cells nest:
        // finer-stored docs surface via a(q), coarser-stored ones via cover
        // ticks on q's ancestors.
        const floor = this.#tileFloor(range.scale);
        const openStart = range.start === OPEN_START_VALUE;
        const openEnd = range.end === OPEN_END_VALUE;
        const sidecar = await this.#querySidecar(name, range);

        if (openStart || openEnd) {
            // A half-open query range has no finite covering — enumerate the
            // timeline's cover-plane cells (its cell inventory, not its docs)
            // and union those overlapping the bounded side. Cover cells alone
            // are complete: every stored point lies inside some cover cell.
            const result = await this.#queryMultiOpen(name, range, floor, openStart, openEnd);
            result.orInPlace(sidecar);
            return result;
        }

        let cells;
        try {
            cells = this.#coverCells(range, floor);
        } catch {
            return sidecar;
        }

        const keys = new Set();
        for (const cell of cells) {
            keys.add(this.#tsmKey(name, 'c', cell));
            keys.add(this.#tsmKey(name, 'a', cell));
            for (const anc of this.#ancestorCells(cell)) {
                keys.add(this.#tsmKey(name, 'c', anc)); // cover plane ONLY — see plane note above
            }
        }
        const result = await this.bitmapIndex.OR([...keys]);
        result.orInPlace(sidecar);
        return result;
    }

    async #queryMultiOpen(name, range, floor, openStart, openEnd) {
        const prefix = `internal/tsm/${this.#timelineKey(name)}`;
        const allKeys = await this.bitmapIndex.listBitmaps(prefix);

        let boundedAtFloor = null;
        if (!(openStart && openEnd)) {
            const boundedValue = openStart ? range.end : range.start;
            try {
                boundedAtFloor = this.#convertRangeToScale(
                    { scale: range.scale, start: boundedValue, end: boundedValue }, floor);
            } catch {
                return new RoaringBitmap32();
            }
        }

        const selected = [];
        for (const key of allKeys) {
            const parsed = this.#parseTsmKey(key);
            if (!parsed || parsed.plane !== 'c') { continue; }
            if (boundedAtFloor === null) { selected.push(key); continue; } // (-∞, +∞)
            let bounds;
            try {
                bounds = this.#convertRangeToScale(
                    { scale: parsed.scale, start: parsed.value, end: parsed.value }, floor);
            } catch { continue; }
            const overlaps = openEnd
                ? bounds.end >= boundedAtFloor.start   // [start, +∞)
                : bounds.start <= boundedAtFloor.end;  // (-∞, end]
            if (overlaps) { selected.push(key); }
        }
        return await this.bitmapIndex.OR(selected);
    }

    #tsmKey(name, plane, cell) {
        return `internal/tsm/${this.#timelineKey(name)}/${cell.scale.toLowerCase()}/${plane}/${cell.value.toString()}`;
    }

    #tsmMetaKey(name) {
        return `internal/tsm/${this.#timelineKey(name)}/meta`;
    }

    // internal/tsm/<tl>/<scale>/<plane>/<cell> -> {scale, plane, value} or null.
    #parseTsmKey(key) {
        const parts = key.split('/');
        if (parts.length !== 6) { return null; }
        const scale = SCALE_ALIASES[parts[3]];
        const plane = parts[4];
        if (!scale || (plane !== 'c' && plane !== 'a')) { return null; }
        try { return { scale, plane, value: BigInt(parts[5]) }; } catch { return null; }
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
        if (mode === 'grouped') {
            return await this.#queryIntervalGrouped(names, scales, range);
        }

        const union = new RoaringBitmap32();
        const bitmaps = await Promise.all([
            ...names.flatMap(name => (
                scales.map(scale => this.#queryIntervalBitmap(name, scale, range))
            )),
            // Multi-position membership plane (non-primary entries).
            ...names.map(name => this.#queryMultiBitmap(name, range)),
        ]);

        for (const bitmap of bitmaps) {
            union.orInPlace(bitmap);
        }

        return union.toArray();
    }

    /**
     * Per-bucket document counts for one or more timelines — the data behind a
     * density rail / histogram UI. Buckets are caller-supplied intervals (the
     * UI already knows its visible periods), so no calendar math lives here.
     *
     * @param {string|string[]} timelineNames - names, or '*' for all
     * @param {Array<{start, end}>} buckets - same value grammar as insert/queryInterval
     * @param {RoaringBitmap32|null} filterBitmap - optional candidate set (context/
     *        feature/filter scope) each bucket count is intersected with
     * @returns {Promise<Array<{start, end, counts: Object<string, number>, total: number}>>}
     *          one entry per input bucket (order preserved); zero-count timelines
     *          are omitted from `counts`
     */
    async histogram(timelineNames, buckets = [], filterBitmap = null) {
        const names = await this.#resolveTimelineNames(timelineNames);
        const results = buckets.map((b) => ({ start: b.start, end: b.end, counts: {}, total: 0 }));

        for (const name of names) {
            // Only scan tiers that exist on disk — otherwise every bucket fans
            // across all 9 scales for a timeline that typically has 1-2 tiers.
            const scales = this.#existingScales(name);
            const hasMulti = this.bitmapIndex.hasBitmap(this.#tsmMetaKey(name));
            if (scales.length === 0 && !hasMulti) { continue; }

            for (let i = 0; i < buckets.length; i++) {
                let range;
                try {
                    range = this.#normalizeInterval({ start: buckets[i].start, end: buckets[i].end });
                } catch {
                    continue; // malformed bucket → counts stay empty for it
                }
                const bitmaps = await Promise.all([
                    ...scales.map((scale) => this.#queryIntervalBitmap(name, scale, range)),
                    this.#queryMultiBitmap(name, range),
                ]);
                const union = new RoaringBitmap32();
                for (const bitmap of bitmaps) { union.orInPlace(bitmap); }
                if (filterBitmap) { union.andInPlace(filterBitmap); }
                if (union.size > 0) {
                    results[i].counts[name] = union.size;
                    results[i].total += union.size;
                }
            }
        }

        return results;
    }

    // Scale tiers a timeline actually has data for (point ts or interval start).
    #existingScales(name) {
        this.#assertTimelineName(name);
        const key = this.#timelineKey(name);
        return SCALES.filter((scale) =>
            this.bitmapIndex.hasBitmap(`internal/ts/${key}/${scale}/start/ebm`)
            || this.bitmapIndex.hasBitmap(`internal/ts/${key}/${scale}/ts/ebm`));
    }

    /**
     * Observed scale tiers across BOTH planes (BSI value tiers + tsm cover
     * cells), coarse→fine. Informational — floors are adaptive, so this is
     * "what this timeline's data has materialized", not configuration.
     */
    async getScales(name) {
        const observed = new Set(this.#existingScales(name));
        if (this.bitmapIndex.hasBitmap(this.#tsmMetaKey(name))) {
            const keys = await this.bitmapIndex.listBitmaps(`internal/tsm/${this.#timelineKey(name)}`);
            for (const key of keys) {
                const parsed = this.#parseTsmKey(key);
                if (parsed?.plane === 'c') { observed.add(parsed.scale); }
            }
            for (const scale of this.#openScales(name)) { observed.add(scale); }
        }
        return SCALES.filter((scale) => observed.has(scale));
    }

    /**
     * Sort keys for a candidate id set: id -> BigInt comparable across scale
     * tiers (ms since epoch; coarse tiers key on their period start, so "1984"
     * sorts before "1984-06-15" — stable and correct for ordering). Instant
     * timelines read the single ts BSI; interval timelines sort by start. Ids
     * with no value in any tier are absent from the map — the caller decides
     * where unsortable docs land.
     *
     * @param {string} timelineName
     * @param {RoaringBitmap32} idsBitmap - candidate document ids
     * @returns {Promise<Map<number, BigInt>>}
     */
    async getSortKeys(timelineName, idsBitmap) {
        this.#assertTimelineName(timelineName);
        const keys = new Map();
        // Coarse → fine, so when an id carries values in several tiers the
        // finest (most precise) key wins.
        for (const scale of SCALES) {
            const tier = this.#getTier(timelineName, scale);
            const bsi = tier.point || tier.start;
            const values = await bsi.getValues(idsBitmap);
            for (const [id, encoded] of values) {
                keys.set(id, this.#sortKeyMs(scale, encoded - SIGNED_OFFSET));
            }
        }
        return keys;
    }

    // Convert a tier-scale value to an ms-scale BigInt sort key (period start
    // for coarse scales). Purely for comparison in JS — never re-encoded into a
    // BSI, so deep-time keys may exceed the 64-bit window without harm.
    #sortKeyMs(scale, value) {
        // Open-interval sentinels are already the numeric extremes; keep them.
        if (value === OPEN_START_VALUE || value === OPEN_END_VALUE) { return value; }
        if (scale === 'ms') { return value; }
        if (scale === 'ns') { return this.#floorDiv(value, 1000000n); }
        // Deep-time tiers collapse to years first, then take the period start.
        let fromScale = scale;
        let fromValue = value;
        if (scale === 'Gyr') { fromScale = 'year'; fromValue = value * 1000000000n; }
        else if (scale === 'Myr') { fromScale = 'year'; fromValue = value * 1000000n; }
        else if (scale === 'Kyr') { fromScale = 'year'; fromValue = value * 1000n; }
        const ms = this.#convertCalendarBoundary(fromScale, 'ms', fromValue, 'start');
        return ms !== null ? ms : fromValue;
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

    // Per-timeline id list, scales pre-unioned. One overlap query per (name, scale)
    // OR'd into a single bitmap per name. Empty timelines are included as [] so the
    // caller sees every requested timeline.
    async #queryIntervalGrouped(names, scales, range) {
        const grouped = {};
        for (const name of names) {
            this.#assertTimelineName(name);
            const union = new RoaringBitmap32();
            const bitmaps = await Promise.all([
                ...scales.map(scale => this.#queryIntervalBitmap(name, scale, range)),
                this.#queryMultiBitmap(name, range),
            ]);
            for (const bitmap of bitmaps) { union.orInPlace(bitmap); }
            grouped[name] = union.toArray();
        }
        return grouped;
    }

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

            // Multi-position matches surface under a pseudo-layer: they come
            // from mixed-granularity cells, not from one BSI scale tier.
            const multi = await this.#queryMultiBitmap(name, range);
            if (multi.size > 0) { layers[name].multi = multi.toArray(); }
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

        // A range value that doesn't fit this scale's 64-bit window (e.g. year 1500
        // expressed in ns) can't match anything stored at this tier — skip it
        // rather than throwing. Queries fan across all scales, so far-from-epoch or
        // deep-time ranges are answered by the coarse tiers and the fine tiers no-op.
        let tierRange, encStart, encEnd;
        try {
            tierRange = this.#convertRangeToScale(range, scale);
            encStart = this.#encodeSigned(tierRange.start);
            encEnd = this.#encodeSigned(tierRange.end);
        } catch {
            return new RoaringBitmap32();
        }

        const tier = this.#getTier(name, scale);

        if (tier.point) {
            // Instant in [start, end]: ts >= start AND ts <= end on the single BSI.
            const [geStart, leEnd] = await Promise.all([
                tier.point.query('>=', encStart),
                tier.point.query('<=', encEnd),
            ]);
            return RoaringBitmap32.and(geStart, leEnd);
        }

        // Interval overlap: start <= range.end AND end >= range.start.
        const [startMatches, endMatches] = await Promise.all([
            tier.start.query('<=', encEnd),
            tier.end.query('>=', encStart),
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

        // Query convenience: an omitted/null end means "to +∞" (everything from
        // start onwards); a null start means "from -∞". Pass both through as an
        // interval object so #normalizeInterval's open handling applies. (A point
        // query still works by passing the same value for start and end, which is
        // what the filter layer does.)
        return {
            range: this.#normalizeInterval({ start: queryStart ?? null, end: queryEnd ?? null }),
            queryOptions: options,
        };
    }

    #selectQueryScales(queryScale, options = {}) {
        if (options.scale || options.scales) { return this.#selectScales(options.scales || options.scale); }
        if (!queryScale) {return [...SCALES];}
        this.#normalizeScale(queryScale);
        return [...SCALES];
    }

    #selectScales(scales) {
        if (!scales) {return [...SCALES];}
        const selected = Array.isArray(scales) ? scales : [scales];
        return selected.map(scale => this.#normalizeScale(scale));
    }

    // ========================================
    // Normalization
    // ========================================

    #normalizeInterval(startOrInterval, endVal = null) {
        // Resolve raw start/end inputs while distinguishing three cases per side:
        //   value      → bounded
        //   null / ∞   → open (handled by #openKind, side-aware)
        //   undefined  → omitted; end defaults to start (an instant)
        const isIntervalObject = startOrInterval
            && typeof startOrInterval === 'object'
            && !(startOrInterval instanceof Date)
            && !Array.isArray(startOrInterval)
            && ('start' in startOrInterval || 'end' in startOrInterval);

        let startInput, endInput;
        if (isIntervalObject) {
            startInput = ('start' in startOrInterval) ? startOrInterval.start : startOrInterval.end;
            endInput = ('end' in startOrInterval) ? startOrInterval.end : startOrInterval.start;
        } else {
            startInput = startOrInterval;
            // Positional: undefined end → instant (end = start); explicit null → open.
            endInput = (endVal === undefined) ? startOrInterval : endVal;
        }

        // Open intervals: one endpoint is unbounded (+∞ / -∞). The scale comes from
        // the bounded side; the open side is stored as a sentinel (not scale-converted).
        const startOpen = this.#openKind(startInput, 'start');
        const endOpen = this.#openKind(endInput, 'end');

        if (endOpen === 'end' && startOpen === 'start') {
            // (-∞, +∞): "always". Stored without a meaningful scale; use 'year'.
            return { scale: 'year', start: OPEN_START_VALUE, end: OPEN_END_VALUE };
        }
        if (endOpen === 'end') {
            const bounded = this.#normalizeEndpoint(startInput);
            return { scale: bounded.scale, start: this.#convertValue(bounded, bounded.scale), end: OPEN_END_VALUE };
        }
        if (startOpen === 'start') {
            const bounded = this.#normalizeEndpoint(endInput);
            return { scale: bounded.scale, start: OPEN_START_VALUE, end: this.#convertValue(bounded, bounded.scale) };
        }
        // Reject nonsensical orientations (e.g. start:+∞ or end:-∞).
        if (startOpen || endOpen) { throw new Error('Invalid open interval: use end:+∞ (ongoing) or start:-∞ (since forever)'); }

        const start = this.#normalizeEndpoint(startInput);
        const end = this.#normalizeEndpoint(endInput, start.scale);
        const scale = start.scale === end.scale ? start.scale : this.#coarserScale(start.scale, end.scale);

        const startValue = this.#convertValue(start, scale);
        const endValue = this.#convertValue(end, scale);
        if (startValue > endValue) { throw new Error('Invalid timeline interval: start must be <= end'); }

        return { scale, start: startValue, end: endValue };
    }

    // Detect unbounded endpoints. Returns 'end' for +∞ (ongoing/present),
    // 'start' for -∞, else null. `side` ('start'|'end') is the position the value
    // occupies, so an explicit `null` means "open on this side". Also accepts
    // Infinity, ±'inf'/'infinity', '∞', 'ongoing', 'present' (and unwraps
    // { value } / { scale, value }).
    #openKind(input, side) {
        let v = input;
        if (input && typeof input === 'object' && !(input instanceof Date) && !Array.isArray(input)) {
            if ('value' in input) { v = input.value; } else { return null; }
        }
        if (v === null) { return side; }
        if (v === Infinity) { return 'end'; }
        if (v === -Infinity) { return 'start'; }
        if (typeof v === 'string') {
            const s = v.trim().toLowerCase();
            if (s === '∞' || s === '+∞' || /^\+?(inf|infinity|ongoing|present)$/.test(s)) { return 'end'; }
            if (s === '-∞' || /^-(inf|infinity)$/.test(s)) { return 'start'; }
        }
        return null;
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
            if (!Number.isInteger(input)) { throw new Error('Timeline numbers must be integers or explicit scaled objects'); }
            return { scale: 'ms', value: BigInt(input) };
        }
        if (typeof input !== 'string') { throw new Error(`Unsupported timeline value: ${String(input)}`); }

        const value = input.trim();
        if (!value) { throw new Error('Timeline value cannot be empty'); }

        const relative = this.#parseRelativeAge(value);
        if (relative) {return relative;}

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
        if (typeof input === 'bigint') {return input;}
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
        if (!match) {return null;}

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
        if (calendarRange) {return calendarRange;}

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
        if (sourceScale === target) {return endpoint.value;}

        const sourceIndex = SCALE_ORDER.get(sourceScale);
        const targetIndex = SCALE_ORDER.get(target);
        if (sourceIndex < targetIndex) {
            throw new Error(`Cannot upsample ${sourceScale} timeline value to ${target}; precision would be fake`);
        }

        const calendarValue = this.#convertCalendarValue(sourceScale, target, endpoint.value);
        if (calendarValue !== null) {return calendarValue;}

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
            if (this.#isPointTimeline(timelineName)) {
                timeline.set(normalizedScale, {
                    point: new BitSlicedIndex(`internal/ts/${key}/${normalizedScale}/ts`, this.bitmapIndex, BIT_DEPTH),
                });
            } else {
                timeline.set(normalizedScale, {
                    start: new BitSlicedIndex(`internal/ts/${key}/${normalizedScale}/start`, this.bitmapIndex, BIT_DEPTH),
                    end: new BitSlicedIndex(`internal/ts/${key}/${normalizedScale}/end`, this.bitmapIndex, BIT_DEPTH),
                });
            }
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
        if (!key) {return null;}
        return key.replace(/_x([0-9a-f]+)_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }

    #decimalToBigInt(value) {
        if (!value.includes('.')) {return BigInt(value);}
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
        if (start === null || end === null) {return null;}
        return { start, end };
    }

    #convertCalendarBoundary(sourceScale, targetScale, value, boundary) {
        // Deep-time tiers route through 'year' (exact powers of 1000), THEN
        // through the civil calendar — never through the approximate 31-day /
        // 12-month chain, so a Kyr cell's day-bounds agree with its year cells'.
        if (['Gyr', 'Myr', 'Kyr'].includes(sourceScale)
            && SCALE_ORDER.get(targetScale) > SCALE_ORDER.get('year')) {
            const factor = this.#factorBetween(sourceScale, 'year');
            const yearValue = boundary === 'start' ? value * factor : ((value + 1n) * factor) - 1n;
            return this.#convertCalendarBoundary('year', targetScale, yearValue, boundary);
        }
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
            if (boundary === 'start') {
                const { year, month } = this.#civilMonth(value);
                return this.#daysFromCivil(year, month, 1n);
            }
            // End boundary: first day of the NEXT month, minus one — resolved
            // via #civilMonth so December rolls into January of the next year
            // instead of handing daysFromCivil an out-of-range month 13.
            const next = this.#civilMonth(value + 1n);
            return this.#daysFromCivil(next.year, next.month, 1n) - 1n;
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
        if (sourceScale === 'day' && targetScale === 'month') {return this.#monthFromDay(value);}
        if (sourceScale === 'day' && targetScale === 'year') {return this.#yearFromDay(value);}
        if (sourceScale === 'month' && targetScale === 'year') {return this.#floorDiv(value, 12n);}
        if (sourceScale === 'second' && targetScale === 'day') {return this.#floorDiv(value, 86400n);}
        if (sourceScale === 'ms' && targetScale === 'day') {return this.#floorDiv(value, 86400000n);}
        if (sourceScale === 'ns' && targetScale === 'day') {return this.#floorDiv(value, 86400000000000n);}
        if (sourceScale === 'ms' && targetScale === 'second') {return this.#floorDiv(value, 1000n);}
        if (sourceScale === 'ns' && targetScale === 'second') {return this.#floorDiv(value, 1000000000n);}
        if (sourceScale === 'ns' && targetScale === 'ms') {return this.#floorDiv(value, 1000000n);}
        if (['second', 'ms', 'ns'].includes(sourceScale) && ['month', 'year'].includes(targetScale)) {
            return this.#convertCalendarValue('day', targetScale, this.#convertCalendarValue(sourceScale, 'day', value));
        }
        if (sourceScale === 'day' && ['Gyr', 'Myr', 'Kyr'].includes(targetScale)) {return this.#convertValue({ scale: 'year', value: this.#yearFromDay(value) }, targetScale);}
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
