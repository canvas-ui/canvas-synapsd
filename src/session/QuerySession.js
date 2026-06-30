'use strict';

import debugInstance from 'debug';
import { createRequire } from 'module';
import { setTimeout, clearTimeout } from 'node:timers';
import { EVENTS } from '../utils/events.js';
import { CRUD_TIMEFRAMES } from '../utils/filters.js';
import TimelineIndex from '../indexes/inverted/Timeline.js';

const require = createRequire(import.meta.url);
const { RoaringBitmap32 } = require('roaring');
const debug = debugInstance('canvas:synapsd:query-session');

/**
 * QuerySession — a long-running, refinable query over a SynapsD instance.
 *
 * A session is an ordered map of cues (labelled sub-specs). Each cue is resolved
 * once via db.resolveCandidates() to a bitmap + the collection keys it consulted.
 * The combined result is the hard-AND of cue bitmaps. The session never duplicates
 * query logic — it only orchestrates resolveCandidates / rank and caches operands.
 *
 * Two modes, same container:
 *   - frozen (default): relative timeframes are resolved to absolute bounds at
 *     add()/patch() time and never slide. A stable agent-working-memory snapshot.
 *   - live: coarse (temporal) cues re-resolve on each recompute so windows slide;
 *     stable cues still use precise key-touch invalidation.
 *
 * Live invalidation is precise: the session subscribes to the db's
 * `membership.changed` signal (collection-vocabulary keys). A write only dirties
 * cues whose collection keys it touched (plus all coarse cues). A write touching
 * no cue's keys produces no recompute and no emit.
 *
 * Emit modes (the 'change' event payload):
 *   - delta (default): { added:number[], removed:number[], count }
 *   - ids:             { ids:number[]|null, count }   (null = unconstrained)
 *   - page:            { docs, count, totalCount }    (materialized page)
 */
export default class QuerySession {
    #db;
    #mode;
    #emit;
    #combinator;
    #debounceMs;
    #pageOpts;

    // label -> { spec, frozenSpec, bitmap, collectionKeys, coarse, dirty }
    #operands = new Map();
    #combined = null;            // RoaringBitmap32 | null (null = unconstrained)
    #prevIds = new RoaringBitmap32();
    #keyIndex = new Map();       // collectionKey -> Set<label>
    #coarseLabels = new Set();
    #listeners = new Set();

    #onMembership;               // bound db handler (for off())
    #debounceTimer = null;
    #recomputing = false;
    #rerunPending = false;
    #closed = false;
    #labelSeq = 0;

    constructor(db, {
        mode = 'frozen',
        emit = 'delta',
        combinator = 'and',
        debounceMs = 0,
        limit,
        offset,
    } = {}) {
        if (!db) { throw new Error('QuerySession requires a SynapsD instance'); }
        if (mode !== 'frozen' && mode !== 'live') { throw new Error(`Invalid session mode: ${mode}`); }
        if (!['delta', 'ids', 'page'].includes(emit)) { throw new Error(`Invalid emit mode: ${emit}`); }
        if (combinator !== 'and') { throw new Error(`Unsupported combinator: ${combinator} (v1 supports 'and')`); }

        this.#db = db;
        this.#mode = mode;
        this.#emit = emit;
        this.#combinator = combinator;
        this.#debounceMs = Math.max(0, debounceMs | 0);
        this.#pageOpts = { limit, offset };

        // Subscribe to the precise per-key membership signal for live invalidation.
        this.#onMembership = (evt) => this.#handleMembershipChanged(evt);
        this.#db.on(EVENTS.MEMBERSHIP_CHANGED, this.#onMembership);
    }

    // ── introspection ────────────────────────────────────────────────────────
    get mode() { return this.#mode; }
    get emitMode() { return this.#emit; }
    get size() { return this.#operands.size; }
    labels() { return [...this.#operands.keys()]; }

    // ── mutation ─────────────────────────────────────────────────────────────

    /** Add a cue. Returns its label (generated when not supplied). */
    async add(spec, label) {
        this.#assertOpen();
        const lbl = label != null ? String(label) : `op_${this.#labelSeq++}`;
        const frozenSpec = this.#mode === 'frozen' ? this.#freezeSpec(spec) : spec;
        const operand = { spec, frozenSpec, bitmap: null, collectionKeys: [], coarse: false, dirty: false };
        this.#operands.set(lbl, operand);
        await this.#resolveOperand(lbl, operand);
        await this.#recompute();
        return lbl;
    }

    /** Remove a cue by label. */
    async remove(label) {
        this.#assertOpen();
        const lbl = String(label);
        const operand = this.#operands.get(lbl);
        if (!operand) { return false; }
        this.#unindexOperand(lbl, operand);
        this.#operands.delete(lbl);
        this.#coarseLabels.delete(lbl);
        await this.#recompute();
        return true;
    }

    /** Shallow-merge partialSpec into a cue's spec buckets and re-resolve it. */
    async patch(label, partialSpec) {
        this.#assertOpen();
        const lbl = String(label);
        const operand = this.#operands.get(lbl);
        if (!operand) { throw new Error(`No such operand: ${lbl}`); }
        const merged = this.#mergeSpec(operand.spec, partialSpec);
        this.#unindexOperand(lbl, operand);
        operand.spec = merged;
        operand.frozenSpec = this.#mode === 'frozen' ? this.#freezeSpec(merged) : merged;
        await this.#resolveOperand(lbl, operand);
        await this.#recompute();
        return lbl;
    }

    /** Drop all cues; combined becomes the unconstrained sentinel. */
    async clear() {
        this.#assertOpen();
        this.#operands.clear();
        this.#keyIndex.clear();
        this.#coarseLabels.clear();
        await this.#recompute();
    }

    // ── read (lazy materialization) ──────────────────────────────────────────

    /** Combined survivor count. Cheap — no document load. */
    async count() {
        this.#assertOpen();
        await this.#refreshLiveCoarse();
        return this.#combined === null
            ? await this.#db.documents.getCount()
            : this.#combined.size;
    }

    /** Combined survivor ids, or null when unconstrained (all docs). */
    ids() {
        this.#assertOpen();
        return this.#combined === null ? null : this.#combined.toArray();
    }

    /**
     * Materialize a page of the combined set. match=null slices the bitmap (no
     * Lance); a string runs fts/vector/hybrid scoped to the combined bitmap.
     */
    async materialize(match = null, { limit, offset, mode } = {}) {
        this.#assertOpen();
        await this.#refreshLiveCoarse();
        const opts = {
            limit: limit ?? this.#pageOpts.limit,
            offset: offset ?? this.#pageOpts.offset,
        };
        if (mode) { opts.mode = mode; }
        return await this.#db.rank(this.#combined, match, opts);
    }

    // ── events ───────────────────────────────────────────────────────────────

    /** Register a change listener. Returns an unsubscribe function. */
    on(eventName, cb) {
        if (eventName !== 'change') { throw new Error(`QuerySession only emits 'change' (got '${eventName}')`); }
        if (typeof cb !== 'function') { throw new Error('listener must be a function'); }
        this.#listeners.add(cb);
        return () => this.#listeners.delete(cb);
    }

    /** Tear down: unsubscribe from db, drop timers and listeners. Idempotent. */
    close() {
        if (this.#closed) { return; }
        this.#closed = true;
        this.#db.off(EVENTS.MEMBERSHIP_CHANGED, this.#onMembership);
        if (this.#debounceTimer) { clearTimeout(this.#debounceTimer); this.#debounceTimer = null; }
        this.#listeners.clear();
    }

    // ── lifecycle (serialize / rehydrate) ────────────────────────────────────

    /** Plain-JSON snapshot of the spec list (no bitmaps). */
    serialize() {
        return {
            version: 1,
            mode: this.#mode,
            emit: this.#emit,
            combinator: this.#combinator,
            debounceMs: this.#debounceMs,
            pageOpts: this.#pageOpts,
            operands: [...this.#operands.entries()].map(([label, op]) => ({
                label, spec: op.spec, frozenSpec: op.frozenSpec, coarse: op.coarse,
            })),
            prevIds: this.#combined === null ? null : this.#combined.toArray(),
        };
    }

    /** Rebuild a session from serialize() output, re-resolving operands. */
    static async rehydrate(db, json, opts = {}) {
        if (!json || typeof json !== 'object') { throw new Error('rehydrate requires a serialized session object'); }
        const session = new QuerySession(db, {
            mode: json.mode,
            emit: json.emit,
            combinator: json.combinator,
            debounceMs: json.debounceMs,
            ...(json.pageOpts || {}),
            ...opts,
        });
        // Restore prior snapshot so the first recompute emits a correct delta
        // (against what the session previously matched) rather than "all added".
        if (Array.isArray(json.prevIds)) { session.#prevIds = new RoaringBitmap32(json.prevIds); }

        for (const o of (json.operands || [])) {
            const operand = { spec: o.spec, frozenSpec: o.frozenSpec ?? o.spec, bitmap: null, collectionKeys: [], coarse: false, dirty: false };
            session.#operands.set(o.label, operand);
            await session.#resolveOperand(o.label, operand);
            session.#labelSeq++;
        }
        await session.#recompute();
        return session;
    }

    // ── internals ────────────────────────────────────────────────────────────

    #assertOpen() { if (this.#closed) { throw new Error('QuerySession is closed'); } }

    async #resolveOperand(label, operand) {
        const { bitmap, collectionKeys, coarse } = await this.#db.resolveCandidates(operand.frozenSpec);
        operand.bitmap = bitmap;
        operand.collectionKeys = collectionKeys || [];
        operand.coarse = !!coarse;
        operand.dirty = false;
        this.#indexOperand(label, operand);
        if (operand.coarse) { this.#coarseLabels.add(label); } else { this.#coarseLabels.delete(label); }
    }

    #indexOperand(label, operand) {
        for (const k of operand.collectionKeys) {
            let set = this.#keyIndex.get(k);
            if (!set) { set = new Set(); this.#keyIndex.set(k, set); }
            set.add(label);
        }
    }

    #unindexOperand(label, operand) {
        for (const k of operand.collectionKeys) {
            const set = this.#keyIndex.get(k);
            if (set) { set.delete(label); if (set.size === 0) { this.#keyIndex.delete(k); } }
        }
    }

    // A write ticked some collection keys. Dirty only the cues that consulted one
    // of them (plus all coarse cues). No intersection → nothing dirty → no recompute.
    #handleMembershipChanged(evt) {
        if (this.#closed) { return; }
        const changes = evt?.changes;
        if (!Array.isArray(changes) || changes.length === 0) { return; }

        let anyDirty = false;
        for (const ch of changes) {
            for (const k of (ch.keys || [])) {
                const labels = this.#keyIndex.get(k);
                if (labels) {
                    for (const l of labels) { const op = this.#operands.get(l); if (op) { op.dirty = true; anyDirty = true; } }
                }
            }
        }
        for (const l of this.#coarseLabels) { const op = this.#operands.get(l); if (op) { op.dirty = true; anyDirty = true; } }

        if (anyDirty) { this.#scheduleRecompute(); }
    }

    #scheduleRecompute() {
        if (this.#debounceTimer) { return; }
        const run = () => { this.#debounceTimer = null; void this.#recompute(); };
        // debounceMs=0 still defers to coalesce a burst within one put flush.
        this.#debounceTimer = setTimeout(run, this.#debounceMs);
        if (typeof this.#debounceTimer?.unref === 'function') { this.#debounceTimer.unref(); }
    }

    async #refreshLiveCoarse() {
        // In live mode a read must reflect the current (sliding) window even if no
        // membership signal arrived. Re-resolve dirty/coarse operands, then recombine.
        if (this.#mode !== 'live') { return; }
        let changed = false;
        for (const [label, op] of this.#operands) {
            if (op.coarse || op.dirty) {
                this.#unindexOperand(label, op);
                await this.#resolveOperand(label, op);
                changed = true;
            }
        }
        if (changed) { this.#combine(); }
    }

    async #recompute() {
        if (this.#recomputing) { this.#rerunPending = true; return; }
        this.#recomputing = true;
        try {
            do {
                this.#rerunPending = false;

                // Re-resolve operands flagged dirty (key-touched), and — in live mode —
                // all coarse (temporal) operands so sliding windows are current.
                for (const [label, op] of this.#operands) {
                    if (op.dirty || (this.#mode === 'live' && op.coarse)) {
                        this.#unindexOperand(label, op);
                        await this.#resolveOperand(label, op);
                    }
                }

                this.#combine();
                this.#diffAndEmit();
            } while (this.#rerunPending);
        } finally {
            this.#recomputing = false;
        }
    }

    // Hard-AND of operand bitmaps. null operand bitmap = no constraint (skip).
    // Zero constraining operands → combined = null (unconstrained / all docs).
    #combine() {
        let combined = null;
        for (const op of this.#operands.values()) {
            if (op.bitmap === null) { continue; }
            if (combined === null) { combined = op.bitmap.clone(); }
            else { combined.andInPlace(op.bitmap); }
        }
        this.#combined = combined;
    }

    #diffAndEmit() {
        const combined = this.#combined;
        if (combined === null) {
            // Unconstrained: no meaningful added/removed set. Emit count only when
            // the constraint state actually changed (prev had members → now all).
            if (this.#prevIds.size > 0 || this.#emit !== 'delta') {
                this.#prevIds = new RoaringBitmap32();
                void this.#fire([], []);
            }
            return;
        }

        const prev = this.#prevIds;
        const added = combined.clone(); added.andNotInPlace(prev);
        const removed = prev.clone(); removed.andNotInPlace(combined);
        if (added.isEmpty && removed.isEmpty) { return; }

        this.#prevIds = combined.clone();
        void this.#fire(added.toArray(), removed.toArray());
    }

    async #fire(added, removed) {
        if (this.#listeners.size === 0) { return; }
        let payload;
        if (this.#emit === 'delta') {
            payload = { added, removed, count: this.#combined === null ? null : this.#combined.size };
        } else if (this.#emit === 'ids') {
            payload = { ids: this.#combined === null ? null : this.#combined.toArray(), count: this.#combined === null ? null : this.#combined.size };
        } else { // page
            const docs = await this.#db.rank(this.#combined, null, { limit: this.#pageOpts.limit, offset: this.#pageOpts.offset });
            payload = { docs, count: docs.count, totalCount: docs.totalCount };
        }
        for (const cb of this.#listeners) {
            try { cb(payload); } catch (e) { debug(`change listener threw: ${e.message}`); }
        }
    }

    // ── spec helpers ─────────────────────────────────────────────────────────

    // Rewrite relative crud timeframe filter tokens (t:crud:<action>:thisWeek) into
    // absolute day-granular ranges so a frozen window never slides. Day granularity
    // is exact for all CRUD_TIMEFRAMES except `now` (1h → current day); acceptable v1.
    #freezeSpec(spec) {
        if (!spec || typeof spec !== 'object') { return spec; }
        const filters = spec.filters;
        if (!Array.isArray(filters) || filters.length === 0) { return spec; }
        let touched = false;
        const frozen = filters.map((tok) => {
            const f = this.#freezeFilterToken(tok);
            if (f !== tok) { touched = true; }
            return f;
        });
        return touched ? { ...spec, filters: frozen } : spec;
    }

    #freezeFilterToken(token) {
        if (typeof token !== 'string') { return token; }
        const m = token.match(/^([+!]?)t:(.+)$/);
        if (!m) { return token; }
        const [, sigil, body] = m;
        const segs = body.split(':');
        const tf = segs[segs.length - 1];
        if (!CRUD_TIMEFRAMES.has(tf)) { return token; } // absolute or unknown — leave
        const { start, end } = TimelineIndex.getTimeframeBounds(tf);
        const prefix = segs.slice(0, -1).join(':');
        return `${sigil}t:${prefix}:${isoDay(start)}..${isoDay(end)}`;
    }

    // Shallow per-bucket merge for patch(): paths/features arrays concat, filters
    // concat, scalar options overwrite. Good enough for v1 refinement.
    #mergeSpec(base, partial) {
        const out = { ...base };
        for (const [k, v] of Object.entries(partial || {})) {
            if (Array.isArray(v) && Array.isArray(out[k])) { out[k] = [...out[k], ...v]; }
            else { out[k] = v; }
        }
        return out;
    }
}

function isoDay(d) {
    const dt = d instanceof Date ? d : new Date(d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
