import { AsyncLocalStorage } from 'node:async_hooks';
import debugInstance from 'debug';
import { EVENTS, createEvent } from '../utils/events.js';
import { normalizeBitmapKeys } from '../indexes/bitmaps/lib/keys.js';
const debug = debugInstance('canvas:synapsd');

// Owns document write serialization, native transactions, membership buffering,
// and event publication. Reverse memberships are durable inside the transaction;
// collection bitmaps flush after commit, retaining the existing recovery policy.
export default class WriteCoordinator {
    #backend; #bitmapIndex; #getSynapses; #restoreTrees; #restoreDevices; #publish;
    #writeContext = new AsyncLocalStorage();
    #writeTail = Promise.resolve();
    constructor({ backend, bitmapIndex, getSynapses, restoreTrees, restoreDevices, publish }) {
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


    // Public document mutations queue before reads, ID allocation, or writes.
    async withWriteLock(action) {
        const previous = this.#writeTail;
        let release;
        this.#writeTail = new Promise(resolve => { release = resolve; });
        await previous;
        const context = { locked: true, active: false, memberships: [], events: [] };
        try {
            return await this.#writeContext.run(context, action);
        } finally {
            context.locked = false;
            release();
        }
    }

    /**
     * Run an LMDB transaction with rollback-safe bitmap membership.
     *
     * Bitmap ticks/unticks issued inside `txBody` (via #add/#removeDocumentMembership
     * and clearSynapses) are buffered, not applied, while the transaction runs. They
     * are flushed to the bitmap index only after the transaction commits — so a
     * rollback leaves no phantom ticks in the shared bitmap cache. The synapse
     * reverse index is still written transactionally inside `txBody`.
     *
     * Internal nested work shares the transaction. Public writes, including ones
     * initiated by event listeners, enter the queue as independent operations.
     */
    async withDeferredMembership(txBody) {
        const transact = async () => {
            const context = this.#writeContext.getStore();
            if (context.active) { return txBody(); }
            context.active = true;
            context.memberships = [];
            context.events = [];
            let result;
            try {
                // Bind inside the queued native callback as well: LMDB may run
                // callbacks from several callers on the same async resource.
                result = await this.#backend.transaction(() => this.#writeContext.run(context, txBody));
            } catch (error) {
                this.#bitmapIndex.restoreCache();
                await this.#restoreTrees();
                await this.#restoreDevices();
                throw error;
            } finally {
                context.active = false;
            }
            const events = context.events;
            await this.flushMembershipBuffer(context.memberships);
            for (const publish of events) { publish(); }
            return result;
        };
        return this.#writeContext.getStore()?.locked ? transact() : this.withWriteLock(transact);
    }

    async flushMembershipBuffer(buffer) {
        const changes = [];
        for (const { op, docId, keys } of buffer) {
            try {
                const affected = op === 'tick'
                    ? await this.#bitmapIndex.tickMany(keys, docId)
                    : await this.#bitmapIndex.untickMany(keys, docId);
                if (affected && affected.length) { changes.push({ docId, op, keys: affected }); }
            } catch (error) {
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
            return false;
        }
        // Synapse reverse index stays in-tx (durable truth); bitmap tick is deferred.
        await this.#getSynapses().createSynapses(docId, keys, { syncBitmaps: false });
        await this.applyMembership('tick', docId, keys);
        return true;
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
