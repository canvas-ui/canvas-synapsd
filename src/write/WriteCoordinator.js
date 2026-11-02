import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import debugInstance from 'debug';
import { EVENTS, createEvent } from '../utils/events.js';
import { normalizeBitmapKeys } from '../indexes/bitmaps/lib/keys.js';
const debug = debugInstance('canvas:synapsd');

// Every public write queues on ONE lock, so a quick write (a paste = linkMany)
// can sit behind seconds of unrelated work (ingest batches, embedding upserts,
// vector compaction). When that happens the waiter cannot tell why; these
// reports name who held the lock meanwhile.
const HISTORY = 256;
// synapsd's own source root: frames under it are synapsd, the first one
// outside is the caller worth naming (canvas-server's mail ingest, …).
const SRC_URL = new URL('..', import.meta.url).href;
const SRC_DIR = fileURLToPath(SRC_URL);

/** `SynapsD.linkMany` + first caller outside synapsd, from a lazily formatted stack. */
function describeCaller(trace) {
    const frames = String(trace?.stack || '').split('\n').slice(1).map((line) => line.trim());
    const own = (frame) => frame.includes(SRC_DIR) || frame.includes(SRC_URL);
    const method = frames.find((f) => !/WriteCoordinator\.js/.test(f) && !/node:internal/.test(f));
    const caller = frames.find((f) => !own(f) && !/node:internal|node_modules[\\/](?!canvas-)/.test(f));
    const name = (frame) => frame ? (/^at (?:async )?([^\s(]+)/.exec(frame)?.[1] || frame.replace(/^at /, '')) : null;
    return { method: name(method), caller: name(caller) };
}

// Owns document write serialization, native transactions, membership buffering,
// and event publication. Reverse memberships are durable inside the transaction;
// collection bitmaps normally flush after commit. Compound operations can opt
// into atomic bitmap persistence with cache restoration on rollback.
export default class WriteCoordinator {
    #backend; #bitmapIndex; #getSynapses; #restoreTrees; #restoreDevices; #publish;
    #writeContext = new AsyncLocalStorage();
    #writeTail = Promise.resolve();
    #accepting = true;
    #onSlowWrite; #slowWriteMs;
    #history = []; // recent ops that held the lock: { trace, start, end }
    #active = null;
    #waiting = new Set();
    #watchdog = null;
    constructor({ backend, bitmapIndex, getSynapses, restoreTrees, restoreDevices, publish, onSlowWrite = null, slowWriteMs = 1000 }) {
        this.#onSlowWrite = typeof onSlowWrite === 'function' ? onSlowWrite : null;
        this.#slowWriteMs = Number(slowWriteMs) > 0 ? Number(slowWriteMs) : 1000;
        this.#backend = backend;
        this.#bitmapIndex = bitmapIndex;
        this.#getSynapses = getSynapses;
        this.#restoreTrees = restoreTrees;
        this.#restoreDevices = restoreDevices;
        this.#publish = publish;
    }
    emit(...args) {
        const context = this.#writeContext.getStore();
        if (context?.active) { context.events.push(() => this.#publish(...args)); return false; }
        return this.#publish(...args);
    }
    emitTreeEvent(tree, eventName, payload) {
        const context = this.#writeContext.getStore();
        if (context?.active) { context.events.push(() => tree.emit(eventName, payload)); return; }
        tree.emit(eventName, payload);
    }

    // External indexes cannot join LMDB. Queue their work only after the
    // enclosing transaction commits, never for a rolled-back document.
    afterCommit(action) {
        const context = this.#writeContext.getStore();
        if (context?.active) { context.events.push(action); return; }
        action();
    }

    // Public document mutations queue before reads, ID allocation, or writes.
    async withWriteLock(action) {
        if (!this.#accepting) { throw new Error('Database is shutting down or closed'); }
        return this.#enqueue(action);
    }

    closeAndDrain(action) {
        this.#accepting = false;
        return this.#enqueue(action);
    }

    async #enqueue(action) {
        // Captured, not formatted: V8 only builds the string if .stack is read,
        // which happens solely when this op ends up in a slow-write report.
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 30;
        const trace = new Error('write');
        Error.stackTraceLimit = limit;
        const queuedAt = performance.now();
        const pending = { trace, queuedAt };
        this.#waiting.add(pending);
        if (!this.#watchdog && (this.#onSlowWrite || debug.enabled)) {
            this.#watchdog = setInterval(() => {
                const now = performance.now();
                const active = this.#active;
                if (!active || now - active.start < this.#slowWriteMs) return;
                const report = {
                    ...describeCaller(active.trace), pending: true,
                    waitMs: Math.round(active.start - active.queuedAt), aheadCount: 0, ahead: [],
                    holdMs: Math.round(now - active.start), queuedCount: this.#waiting.size,
                    waiting: [...this.#waiting].slice(0, 5).map(op => ({ ...describeCaller(op.trace), waitMs: Math.round(now - op.queuedAt) })),
                };
                debug('Write still pending: %o', report);
                try { this.#onSlowWrite?.(report); } catch { /* diagnostic only */ }
            }, Math.max(100, this.#slowWriteMs));
            this.#watchdog.unref?.();
        }

        const previous = this.#writeTail;
        let release;
        this.#writeTail = new Promise(resolve => { release = resolve; });
        await previous;
        const start = performance.now();
        this.#waiting.delete(pending);
        this.#active = { trace, start, queuedAt };
        const context = { locked: true, active: false, memberships: [], events: [] };
        try {
            return await this.#writeContext.run(context, action);
        } finally {
            context.locked = false;
            this.#active = null;
            if (!this.#waiting.size) { clearInterval(this.#watchdog); this.#watchdog = null; }
            release();
            this.#record(trace, queuedAt, start, performance.now());
        }
    }

    #record(trace, queuedAt, start, end) {
        this.#history.push({ trace, start, end });
        if (this.#history.length > HISTORY) {this.#history.shift();}
        const waitMs = start - queuedAt;
        const holdMs = end - start;
        if (!this.#onSlowWrite && !debug.enabled) {return;}
        if (waitMs + holdMs < this.#slowWriteMs) {return;}
        // Who held the lock while this op waited, longest first.
        const ahead = this.#history
            .filter((op) => op.trace !== trace && op.end > queuedAt && op.start < start)
            .sort((a, b) => (b.end - b.start) - (a.end - a.start));
        const report = {
            ...describeCaller(trace),
            waitMs: Math.round(waitMs),
            holdMs: Math.round(holdMs),
            aheadCount: ahead.length,
            ahead: ahead.slice(0, 5).map((op) => ({ ...describeCaller(op.trace), holdMs: Math.round(op.end - op.start) })),
        };
        debug('Slow write: %o', report);
        try { this.#onSlowWrite?.(report); } catch { /* diagnostics never break a write */ }
    }

    /**
     * Run an LMDB transaction with rollback-safe bitmap membership.
     *
     * Bitmap ticks/unticks issued inside `txBody` (via #add/#removeDocumentMembership
     * and clearSynapses) are buffered, not applied, while the transaction runs. They
     * are flushed to the bitmap index only after the transaction commits — so a
     * rollback leaves no phantom ticks in the shared bitmap cache. The synapse
     * reverse index is still written transactionally inside `txBody`.
     * With `atomicMemberships`, flush before commit and restore cached objects
     * on failure instead; bitmap errors then abort the whole mutation.
     *
     * Internal nested work shares the transaction. Public writes, including ones
     * initiated by event listeners, enter the queue as independent operations.
     */
    async withDeferredMembership(txBody, { atomicMemberships = false } = {}) {
        const transact = async () => {
            const context = this.#writeContext.getStore();
            if (context.active) { return txBody(); }
            context.active = true;
            context.memberships = [];
            context.events = [];
            const cachedBitmaps = atomicMemberships ? new Map(this.#bitmapIndex.cache) : [];
            let result;
            try {
                // Bind inside the queued native callback as well: LMDB may run
                // callbacks from several callers on the same async resource.
                result = await this.#backend.transaction(() => this.#writeContext.run(context, async () => {
                    const value = await txBody();
                    // Compound document mutations need forward memberships in
                    // the same commit as rows, reverse memberships and edges.
                    // A failed bitmap write aborts the entire operation; the
                    // catch below restores cached bitmap objects in place.
                    if (atomicMemberships) { await this.flushMembershipBuffer(context.memberships, { strict: true }); }
                    return value;
                }));
            } catch (error) {
                this.#bitmapIndex.restoreCache(cachedBitmaps);
                await this.#restoreTrees();
                await this.#restoreDevices();
                throw error;
            } finally {
                context.active = false;
            }
            const events = context.events;
            if (!atomicMemberships) { await this.flushMembershipBuffer(context.memberships); }
            for (const publish of events) { publish(); }
            return result;
        };
        return this.#writeContext.getStore()?.locked ? transact() : this.withWriteLock(transact);
    }

    async flushMembershipBuffer(buffer, { strict = false } = {}) {
        const changes = [];
        for (const { op, docId, keys } of buffer) {
            try {
                const affected = op === 'tick'
                    ? await this.#bitmapIndex.tickMany(keys, docId)
                    : await this.#bitmapIndex.untickMany(keys, docId);
                if (affected && affected.length) { changes.push({ docId, op, keys: affected }); }
            } catch (error) {
                if (strict) { throw error; }
                // Committed doc may now lack/keep a bitmap membership it should
                // not — recoverable by reindexing from the synapse reverse index.
                debug(`Post-commit bitmap ${op} failed for doc ${docId}: ${error.message}`);
            }
        }
        this.emitMembershipChanged(changes);
    }

    /** Buffer a bitmap membership op if a deferred-membership tx is active, else apply now. */
    async applyMembership(op, docId, keys) {
        const context = this.#writeContext.getStore();
        if (context?.active) {
            context.memberships.push({ op, docId, keys });
            return;
        }
        const affected = op === 'tick'
            ? await this.#bitmapIndex.tickMany(keys, docId)
            : await this.#bitmapIndex.untickMany(keys, docId);
        if (affected && affected.length) {
            this.emitMembershipChanged([{ docId, op, keys: affected }]);
        }
    }

    // Post-commit signal of the exact collection bitmap keys that changed, so a
    // QuerySession can precisely invalidate only the operands that touched them.
    // Keys are collection-vocabulary (context/<treeId>/<layerId>, vfs/<treeId>/<nodeId>,
    // feature keys) — the same vocabulary resolveCandidates() reports as collectionKeys.
    emitMembershipChanged(changes) {
        if (!changes || changes.length === 0) { return; }
        this.emit(EVENTS.MEMBERSHIP_CHANGED, createEvent(EVENTS.MEMBERSHIP_CHANGED, { changes }));
    }

    async addDocumentMembership(docId, bitmapKeys) {
        const keys = normalizeBitmapKeys(bitmapKeys);
        if (keys.length === 0) {
            return [];
        }
        // Synapse reverse index stays in-tx (durable truth); bitmap tick is deferred.
        const added = await this.#getSynapses().createSynapses(docId, keys, { syncBitmaps: false });
        await this.applyMembership('tick', docId, keys);
        return added;
    }

    async removeDocumentMembership(docId, bitmapKeys) {
        const keys = normalizeBitmapKeys(bitmapKeys);
        if (keys.length === 0) {
            return false;
        }
        await this.#getSynapses().removeSynapses(docId, keys, { syncBitmaps: false });
        await this.applyMembership('untick', docId, keys);
        return true;
    }
}
