'use strict';

// Utils
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:edges');

import { predicateId, predicateName, allPredicateIds } from './predicates.js';

/**
 * EdgeIndex — typed, directed, N:N edges between documents.
 *
 * Storage is three LMDB DBIs on the shared root env. Both adjacency DBIs store
 * the SAME predicate id; direction is simply which one you scan:
 *
 *   edges_fwd   dupSort   key [fromId, predId]         value toId
 *   edges_inv   dupSort   key [toId,   predId]         value fromId
 *   edge_meta   plain     key [fromId, predId, toId]   value { src, ts, conf? }
 *
 * dupSort gives us sorted, deduped value sets: putting the same (key, value)
 * twice is a no-op, so edge writes are idempotent for free, and out-degree is
 * an O(1)-ish B-tree count rather than a scan.
 *
 * This layer is DOCUMENT-UNAWARE by design: it speaks uint32 node ids and
 * predicates, nothing else. No schema knowledge, no bitmaps, no rows. Anything
 * document-shaped (deriving edges from `data.relations`, membership
 * inheritance) belongs to the ingest layer above it.
 *
 * PROVENANCE RULE — asserted edges write NO meta record. Absence of a meta row
 * means `src:'doc'` (i.e. the edge is owned by a document's `data.relations`),
 * which `edge()` synthesizes so the convention never leaks to callers.
 * Extractor/agent edges MUST pass `{src:'extractor:<name>'|'agent:<hookId>'}`.
 * `removeEdges({src})` + re-running the extractor is therefore a complete L3
 * rebuild path for edges, and it can never touch asserted ones.
 *
 * ITERATOR CAVEAT — a live LMDB iterator pins a read transaction. Drain it
 * promptly and never hold one across an `await`. Every method here that scans
 * before mutating materializes its work list FIRST, then writes; long scans
 * pass `snapshot: false`.
 */

// Long scans over PLAIN stores opt out of the snapshot so a slow reader can't
// pin an old txn against concurrent writers.
//
// ⚠️ dupSort stores REFUSE this — lmdb throws "Can not disable snapshot on a
// dupSort data store" (verified on 3.5.2, 2026-08-02). So this applies to
// edge_meta only; the two adjacency DBIs are always scanned under a snapshot,
// which makes draining-before-mutating mandatory rather than merely tidy.
const LONG_SCAN = { snapshot: false };

export default class EdgeIndex {

    #fwd;
    #inv;
    #meta;

    /**
     * @param {object} fwdDataset  dupSort dataset, keys [fromId, predId]
     * @param {object} invDataset  dupSort dataset, keys [toId, predId]
     * @param {object} metaDataset plain dataset, keys [fromId, predId, toId]
     */
    constructor(fwdDataset, invDataset, metaDataset) {
        if (!fwdDataset || !invDataset || !metaDataset) {
            throw new Error('EdgeIndex requires edges_fwd, edges_inv and edge_meta datasets');
        }
        this.#fwd = fwdDataset;
        this.#inv = invDataset;
        this.#meta = metaDataset;
        debug('EdgeIndex initialized');
    }

    /**
     * Internal helpers
     */

    #normId(value) {
        const id = Number(value);
        if (!Number.isInteger(id) || id <= 0) {
            throw new Error(`Invalid document id: ${value}`);
        }
        return id;
    }

    #triple(from, predicate, to) {
        return {
            from: this.#normId(from),
            pid: predicateId(predicate),
            to: this.#normId(to),
        };
    }

    /**
     * Writes
     */

    /**
     * Create an edge `from --predicate--> to`. Idempotent: dupSort dedups the
     * (key, value) pair, so repeat calls are no-ops.
     * @param {number} from
     * @param {string} predicate
     * @param {number} to
     * @param {{src: string, conf?: number}} [meta] provenance; OMIT for asserted
     *        edges derived from a document's `data.relations`.
     */
    link(from, predicate, to, meta = null) {
        const { from: f, pid, to: t } = this.#triple(from, predicate, to);

        this.#fwd.putSync([f, pid], t);
        this.#inv.putSync([t, pid], f);

        if (meta) {
            if (!meta.src) { throw new Error('Edge meta requires a "src" (e.g. "extractor:foo")'); }
            if (meta.src === 'doc') {
                throw new Error('src:"doc" is implicit for asserted edges — omit meta instead of passing it');
            }
            this.#meta.putSync([f, pid, t], { ts: Date.now(), ...meta });
        }

        debug(`link: ${f} --${predicate}--> ${t}${meta ? ` (${meta.src})` : ''}`);
        return true;
    }

    /**
     * Remove the edge `from --predicate--> to`, both mirrors and any meta row.
     */
    unlink(from, predicate, to) {
        const { from: f, pid, to: t } = this.#triple(from, predicate, to);

        this.#fwd.removeValueSync([f, pid], t);
        this.#inv.removeValueSync([t, pid], f);
        this.#meta.removeSync([f, pid, t]);

        debug(`unlink: ${f} --${predicate}--> ${t}`);
        return true;
    }

    /**
     * Batch link. In-batch duplicates are free — dupSort dedups them.
     * @param {Array<{from:number, p:string, to:number, meta?:object}>} edges
     */
    linkMany(edges = []) {
        let count = 0;
        for (const edge of Array.isArray(edges) ? edges : []) {
            this.link(edge.from, edge.p, edge.to, edge.meta ?? null);
            count++;
        }
        return count;
    }

    /**
     * Batch unlink.
     * @param {Array<{from:number, p:string, to:number}>} edges
     */
    unlinkMany(edges = []) {
        let count = 0;
        for (const edge of Array.isArray(edges) ? edges : []) {
            this.unlink(edge.from, edge.p, edge.to);
            count++;
        }
        return count;
    }

    /**
     * Reads
     */

    /**
     * Point edge-existence check.
     * @returns {boolean}
     */
    exists(from, predicate, to) {
        const { from: f, pid, to: t } = this.#triple(from, predicate, to);
        return this.#fwd.doesExistValue([f, pid], t);
    }

    /**
     * Fetch one edge with its provenance.
     * @returns {{from:number, p:string, to:number, meta:object}|null}
     */
    edge(from, predicate, to) {
        const { from: f, pid, to: t } = this.#triple(from, predicate, to);
        if (!this.#fwd.doesExistValue([f, pid], t)) { return null; }

        // Absence of a meta row IS the asserted-edge convention; synthesize it
        // so callers never have to know that.
        const meta = this.#meta.get([f, pid, t]) ?? { src: 'doc' };
        return { from: f, p: predicate, to: t, meta };
    }

    /**
     * Lazily iterate outgoing edge targets, in sorted id order.
     *
     * NOTE: `predicate` is REQUIRED here (the plan sketched it as optional).
     * Making it optional would force a polymorphic yield shape — bare ids with a
     * predicate, {p, to} pairs without one — which is a bug factory at the
     * callsite. Use `edgesOf(id)` for the all-predicates view.
     *
     * @param {number} id
     * @param {string} predicate
     * @param {{start?:number, limit?:number}} [opts] `start` seeks into the dup
     *        set (exclusive of nothing — it is a seek, so pass the last id you
     *        saw and skip it), `limit` caps yielded values.
     * @yields {number} target node ids
     */
    *outgoing(id, predicate, opts = {}) {
        yield* this.#adjacent(this.#fwd, id, predicate, opts);
    }

    /**
     * Lazily iterate incoming edge sources, in sorted id order. Same contract
     * as `outgoing`, scanning edges_inv.
     * @yields {number} source node ids
     */
    *incoming(id, predicate, opts = {}) {
        yield* this.#adjacent(this.#inv, id, predicate, opts);
    }

    *#adjacent(dataset, id, predicate, opts = {}) {
        const node = this.#normId(id);
        const pid = predicateId(predicate);

        const rangeOptions = {};
        if (opts.start !== undefined) { rangeOptions.start = opts.start; }
        // Reverse dup-set iteration had a historical start-ignoring bug in lmdb;
        // forward-only is deliberate. Do not add a `reverse` option here.

        const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : Infinity;
        let yielded = 0;

        for (const value of dataset.getValues([node, pid], rangeOptions)) {
            if (yielded >= limit) { break; }
            yield value;
            yielded++;
        }
    }

    /**
     * Out/in-degree straight off the B-tree.
     * @param {number} id
     * @param {string} predicate
     * @param {'out'|'in'} [dir='out']
     * @returns {number}
     */
    degree(id, predicate, dir = 'out') {
        const node = this.#normId(id);
        const pid = predicateId(predicate);
        const dataset = dir === 'in' ? this.#inv : this.#fwd;
        return dataset.getValuesCount([node, pid]);
    }

    /**
     * Every edge touching `id`, both directions, across all predicates.
     * @returns {{outgoing: Array<{p:string,to:number}>, incoming: Array<{p:string,from:number}>}}
     */
    edgesOf(id) {
        const node = this.#normId(id);
        const outgoing = [];
        const incoming = [];

        for (const { key, value } of this.#fwd.getRange({ start: [node], end: [node + 1] })) {
            outgoing.push({ p: predicateName(key[1]), to: value });
        }
        for (const { key, value } of this.#inv.getRange({ start: [node], end: [node + 1] })) {
            incoming.push({ p: predicateName(key[1]), from: value });
        }

        return { outgoing, incoming };
    }

    /**
     * Lifecycle
     */

    /**
     * Drop every edge touching `id`, in both directions, plus its meta rows.
     * Called from the document delete path.
     *
     * Materializes the work list before mutating — mutating while an iterator
     * holds its read txn is how you get a half-cleaned graph.
     */
    deleteNode(id) {
        const node = this.#normId(id);

        // 1. Collect first (drain the iterators), then write. Not optional:
        //    dupSort stores cannot disable the snapshot, so these iterators hold
        //    a read txn for their whole lifetime.
        const outgoing = [];
        for (const { key, value } of this.#fwd.getRange({ start: [node], end: [node + 1] })) {
            outgoing.push({ pid: key[1], to: value });
        }
        const incoming = [];
        for (const { key, value } of this.#inv.getRange({ start: [node], end: [node + 1] })) {
            incoming.push({ pid: key[1], from: value });
        }

        // 2. Clean the mirrors held by our partners.
        for (const { pid, to } of outgoing) {
            this.#inv.removeValueSync([to, pid], node);
            this.#meta.removeSync([node, pid, to]);
        }
        for (const { pid, from } of incoming) {
            this.#fwd.removeValueSync([from, pid], node);
            this.#meta.removeSync([from, pid, node]);
        }

        // 3. Drop our own anchor keys wholesale (removeSync without a value
        //    removes the entire dup set for that key).
        for (const pid of allPredicateIds()) {
            this.#fwd.removeSync([node, pid]);
            this.#inv.removeSync([node, pid]);
        }

        debug(`deleteNode: dropped ${outgoing.length} outgoing + ${incoming.length} incoming edges for ${node}`);
        return outgoing.length + incoming.length;
    }

    /**
     * Bulk-remove DERIVED edges by provenance. This is the L3 rebuild path:
     * `removeEdges({src})` then re-run the extractor.
     *
     * Asserted edges are unreachable here by construction — they have no meta
     * row, and this scans edge_meta.
     *
     * @param {{src: string, p?: string}} selector at least one selector is
     *        required; a no-selector call would be a silent full wipe, so it
     *        throws. Use `clear()` if that is genuinely what you want.
     * @returns {number} edges removed
     */
    removeEdges(selector = {}) {
        const { src, p } = selector;

        if (!src && !p) {
            throw new Error('removeEdges requires at least one selector ({src} and/or {p}) — use clear() for a full wipe');
        }
        if (src === 'doc') {
            throw new Error('removeEdges cannot target src:"doc" — asserted edges are owned by their document, delete or update the row instead');
        }

        const pid = p !== undefined ? predicateId(p) : null;

        // Collect first — we are about to delete out from under this scan.
        const doomed = [];
        for (const { key, value } of this.#meta.getRange(LONG_SCAN)) {
            const [from, keyPid, to] = key;
            if (pid !== null && keyPid !== pid) { continue; }
            if (src && value?.src !== src) { continue; }
            doomed.push({ from, pid: keyPid, to });
        }

        for (const { from, pid: edgePid, to } of doomed) {
            this.#fwd.removeValueSync([from, edgePid], to);
            this.#inv.removeValueSync([to, edgePid], from);
            this.#meta.removeSync([from, edgePid, to]);
        }

        debug(`removeEdges: removed ${doomed.length} edges (src=${src ?? '*'}, p=${p ?? '*'})`);
        return doomed.length;
    }

    /**
     * Drop the entire edge plane. L3 is derived — this is recoverable by
     * replaying ingest derivation plus the extractors.
     */
    clear() {
        this.#fwd.clearSync();
        this.#inv.clearSync();
        this.#meta.clearSync();
        debug('clear: all edge datasets dropped');
        return true;
    }
}
