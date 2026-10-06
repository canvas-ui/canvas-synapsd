import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:search-queue');

/**
 * Write-behind queue for everything that lives in Lance: FTS rows, dense
 * vectors, and their compaction/maintenance.
 *
 * Why: the database write lock serializes every document write. Lance work
 * used to run inside it — a single-document FTS upsert does a predicate
 * delete that scans every table fragment, and each one-row append adds a
 * fragment, so a plain `put` grew to 16 s on a busy workspace and every other
 * write (a 14 ms paste) queued behind it. Search indexing is derived data and
 * may lag the source of truth by a moment; user writes must not wait for it.
 *
 * Model:
 * - Writers enqueue and return. Entries coalesce per document (last write
 *   wins; a delete supersedes a pending upsert).
 * - One lane: batches flush in order, after `delayMs` or once `maxBatch`
 *   entries are pending. A flush does ONE delete + ONE append per table, then
 *   applies the presence/seen bitmap bookkeeping in a single short critical
 *   section on the write lock.
 * - Deletes resolve with whether the Lance rows are gone — document deletion
 *   gates id recycling on that, asynchronously.
 * - Reads (FTS/vector queries) call `settle()` first: pending writes flush
 *   before the query runs (read-your-writes), bounded by `readWaitMs` so a
 *   long compaction on the lane never stalls a search.
 * - `exclusive(fn)` runs maintenance (optimize, clears, backfills) on the
 *   lane between batches.
 *
 * Lock order is lane → write lock, never the reverse: nothing holding the
 * write lock may await the lane (enqueue methods never await).
 */
export default class SearchWriteQueue {
    #getLance; #vectors; #bitmapIndex; #writes;
    #delayMs; #maxBatch; #readWaitMs; #highWater;
    #fts = new Map();      // id -> { doc } | { delete: true }
    #vec = new Map();      // space -> Map(id -> { upsert } | { delete: true })
    #waiters = [];         // { ids:Set<number>, resolve } — delete completion
    #embedWaiters = [];    // { space, id, resolve } — embedding stored
    #lane = Promise.resolve();
    #timer = null;
    #flushQueued = null;
    #accepting = true;

    constructor({ getLance, vectors, bitmapIndex, writes, delayMs = 250, maxBatch = 500, readWaitMs = 1500, highWater = 2000 }) {
        this.#getLance = getLance;
        this.#vectors = vectors;
        this.#bitmapIndex = bitmapIndex;
        this.#writes = writes;
        this.#delayMs = delayMs;
        this.#maxBatch = maxBatch;
        this.#readWaitMs = readWaitMs;
        this.#highWater = highWater;
    }

    get pending() {
        let n = this.#fts.size;
        for (const m of this.#vec.values()) { n += m.size; }
        return n;
    }

    open() { this.#accepting = true; }

    // ── Enqueue (never awaits: safe inside the write lock) ───────────────────

    /** Index (or re-index) documents' FTS rows. */
    upsertText(docs = []) {
        if (!this.#accepting) { return; }
        for (const doc of docs) {
            if (doc?.id) { this.#fts.set(Number(doc.id), { doc }); }
        }
        this.#schedule();
    }

    /**
     * Remove documents' FTS + vector rows. Resolves true once they are gone
     * (false if a Lance delete failed) — the gate for recycling their ids.
     */
    deleteDocs(ids = []) {
        const list = ids.map(Number).filter(Boolean);
        if (!list.length) { return Promise.resolve(true); }
        if (!this.#accepting) { return Promise.resolve(false); }
        for (const id of list) {
            this.#fts.set(id, { delete: true });
            for (const space of this.#vectors.openedNames()) { this.#space(space).set(id, { delete: true }); }
            // A pending embedding for a doc being deleted must not land after it.
            for (const m of this.#vec.values()) { if (m.get(id) && !m.get(id).delete) { m.set(id, { delete: true }); } }
        }
        const done = new Promise((resolve) => this.#waiters.push({ ids: new Set(list), resolve }));
        this.#schedule();
        return done;
    }

    /**
     * Store a document's chunk vectors in a space. Resolves true as soon as the
     * write is accepted — the embedder runs one document at a time, so waiting
     * out the batch delay would cap it at a few docs/s. Backpressure instead:
     * past `highWater` pending entries it resolves only once written (true) or
     * dropped (false), so vectors cannot pile up in memory faster than Lance
     * absorbs them.
     */
    storeEmbeddings(space, docId, schema, updatedAt, chunks, opts = {}) {
        const id = Number(docId);
        if (!id || !this.#accepting) { return Promise.resolve(false); }
        if (this.#fts.get(id)?.delete) { return Promise.resolve(false); }
        this.#space(space).set(id, { upsert: { docId: id, schema, updatedAt, chunks: Array.isArray(chunks) ? chunks : [], model: opts.model } });
        const done = new Promise((resolve) => this.#embedWaiters.push({ space, id, resolve }));
        this.#schedule();
        return this.pending > this.#highWater ? done : Promise.resolve(true);
    }

    // ── Lane ─────────────────────────────────────────────────────────────────

    /** Run maintenance on the lane, after everything already queued. */
    exclusive(fn) {
        return this.#run(async () => {
            await this.#flushNow();
            return fn();
        });
    }

    /** Flush whatever is pending now; resolves when it is written. */
    flush() {
        if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
        if (!this.#flushQueued) {
            this.#flushQueued = this.#run(() => this.#flushNow()).finally(() => {
                this.#flushQueued = null;
                // Entries that arrived after the drain loop's last check would
                // otherwise wait for the next enqueue to schedule them.
                if (this.pending > 0) { this.#schedule(); }
            });
        }
        return this.#flushQueued;
    }

    /** Read barrier: pending writes land before a query, within readWaitMs. */
    async settle() {
        if (this.pending === 0) { return; }
        let timer;
        const cap = new Promise((resolve) => { timer = setTimeout(resolve, this.#readWaitMs); });
        try {
            await Promise.race([this.flush().catch(() => {}), cap]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Stop accepting, write out everything pending (shutdown). */
    async close() {
        this.#accepting = false;
        await this.flush().catch((e) => debug(`close flush failed: ${e.message}`));
        await this.#lane;
    }

    #space(space) {
        if (!this.#vec.has(space)) { this.#vec.set(space, new Map()); }
        return this.#vec.get(space);
    }

    #schedule() {
        if (this.pending >= this.#maxBatch) { void this.flush(); return; }
        if (this.#timer || this.#flushQueued) { return; }
        this.#timer = setTimeout(() => { this.#timer = null; void this.flush(); }, this.#delayMs);
        this.#timer.unref?.();
    }

    #run(task) {
        const result = this.#lane.then(task);
        this.#lane = result.catch((e) => debug(`lane task failed: ${e.message}`));
        return result;
    }

    async #flushNow() {
        while (this.pending > 0) {
            const fts = this.#fts; this.#fts = new Map();
            const vec = this.#vec; this.#vec = new Map();
            const waiters = this.#waiters; this.#waiters = [];
            const embedWaiters = this.#embedWaiters; this.#embedWaiters = [];
            await this.#writeBatch(fts, vec, waiters, embedWaiters);
        }
    }

    async #writeBatch(fts, vec, waiters, embedWaiters) {
        const failed = new Set(); // ids whose delete did not complete
        const bitmapOps = [];     // [op, key, ids]
        const seen = new Map();   // seenKey -> ids

        const lance = this.#getLance();
        if (fts.size && lance) {
            const upserts = []; const deletes = [];
            for (const [id, entry] of fts) { if (entry.delete) { deletes.push(id); } else { upserts.push(entry.doc); } }
            const res = await lance.writeBatch({ upserts, deletes });
            if (res.ok) {
                bitmapOps.push(['tick', lance.presenceKey, res.tick], ['untick', lance.presenceKey, res.untick]);
            } else {
                deletes.forEach((id) => failed.add(id));
            }
        }

        const stored = new Set(); // `${space}:${id}` written
        for (const [space, entries] of vec) {
            const vi = await this.#vectors.get(space);
            const upserts = []; const deletes = [];
            for (const [id, entry] of entries) { if (entry.delete) { deletes.push(id); } else { upserts.push(entry.upsert); } }
            if (!vi) { deletes.forEach((id) => failed.add(id)); continue; }
            const res = await vi.writeBatch({ upserts, deletes });
            if (!res.ok) { deletes.forEach((id) => failed.add(id)); continue; }
            bitmapOps.push(['tick', vi.presenceKey, res.tick], ['untick', vi.presenceKey, res.untick]);
            // Every processed embedding (even 0 chunks — a deliberate skip) is
            // marked seen, or reconcile re-fetches it forever.
            const seenKey = this.#vectors.seenKey(space);
            for (const u of upserts) { stored.add(`${space}:${u.docId}`); }
            if (upserts.length) { seen.set(seenKey, [...(seen.get(seenKey) || []), ...upserts.map((u) => u.docId)]); }
        }
        for (const [key, ids] of seen) { bitmapOps.push(['tick', key, ids]); }

        const applicable = bitmapOps.filter(([, key, ids]) => key && ids.length);
        if (applicable.length) {
            try {
                await this.#writes.withWriteLock(async () => {
                    for (const [op, key, ids] of applicable) {
                        try { await this.#bitmapIndex[op](key, ids); } catch (e) { debug(`bitmap ${op} ${key} failed: ${e.message}`); }
                    }
                });
            } catch (e) {
                debug(`bitmap bookkeeping skipped: ${e.message}`);
            }
        }

        for (const { ids, resolve } of waiters) { resolve(![...ids].some((id) => failed.has(id))); }
        for (const { space, id, resolve } of embedWaiters) { resolve(stored.has(`${space}:${id}`)); }
    }
}
