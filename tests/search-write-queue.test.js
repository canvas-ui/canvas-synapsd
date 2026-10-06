'use strict';

import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import SearchWriteQueue from '../src/write/SearchWriteQueue.js';

const note = (title, content = title) => ({ schema: 'data/schema/note', data: { title, content } });
// File docs carry their searchable text in metadata.text (see blob-text-fts.test.js).
const fileDoc = (name, text) => ({
    schema: 'data/schema/file',
    data: {},
    checksumArray: [`sha256/${name}`],
    locations: [{ url: `stored://workspace:data/${name}`, metadata: { filename: name } }],
    metadata: { contentType: 'text/markdown', filename: name, text: { content: text, truncated: false, mimeType: 'text/markdown' } },
});
const ids = (hits) => [...(hits?.data ?? hits)];

// ── Unit: queue semantics against fake stores ──────────────────────────────

function fakes({ ftsOk = true, readWaitMs, highWater = 0 } = {}) {
    const calls = [];
    const lockLog = [];
    let locked = false;
    const lance = {
        presenceKey: 'internal/lance/fts',
        async writeBatch({ upserts, deletes }) {
            calls.push({ table: 'fts', upserts: upserts.map((d) => d.id), deletes });
            return ftsOk ? { ok: true, tick: upserts.map((d) => d.id), untick: deletes } : { ok: false, tick: [], untick: [] };
        },
    };
    const vectors = {
        openedNames: () => ['text'],
        seenKey: (space) => `internal/embed/seen/${space}`,
        async get() {
            return {
                presenceKey: 'internal/embed/vectors/text',
                async writeBatch({ upserts, deletes }) {
                    calls.push({ table: 'vec', upserts: upserts.map((u) => u.docId), deletes });
                    return { ok: true, tick: upserts.map((u) => u.docId), untick: deletes };
                },
            };
        },
    };
    const bitmapIndex = {
        async tick(key, ids) { lockLog.push({ op: 'tick', key, ids, locked }); },
        async untick(key, ids) { lockLog.push({ op: 'untick', key, ids, locked }); },
    };
    const writes = {
        async withWriteLock(fn) { locked = true; try { return await fn(); } finally { locked = false; } },
    };
    const queue = new SearchWriteQueue({ getLance: () => lance, vectors, bitmapIndex, writes, delayMs: 10_000, highWater, ...(readWaitMs ? { readWaitMs } : {}) });
    return { queue, calls, lockLog };
}

describe('SearchWriteQueue', () => {
    test('coalesces per document and writes one batch per table', async () => {
        const { queue, calls } = fakes();
        queue.upsertText([{ id: 1 }, { id: 2 }]);
        queue.upsertText([{ id: 1 }]);          // re-index of 1 collapses
        expect(queue.pending).toBe(2);
        await queue.flush();
        expect(calls).toEqual([{ table: 'fts', upserts: [1, 2], deletes: [] }]);
        expect(queue.pending).toBe(0);
    });

    test('a delete supersedes a pending upsert and pending embeddings', async () => {
        const { queue, calls } = fakes();
        queue.upsertText([{ id: 7 }]);
        const embedded = queue.storeEmbeddings('text', 7, 'data/schema/note', null, [{ chunkId: 0, vector: [1] }]);
        const gone = queue.deleteDocs([7]);
        await queue.flush();
        await expect(gone).resolves.toBe(true);
        await expect(embedded).resolves.toBe(false);
        expect(calls).toEqual([
            { table: 'fts', upserts: [], deletes: [7] },
            { table: 'vec', upserts: [], deletes: [7] },
        ]);
    });

    test('embeddings are acknowledged on enqueue below the high-water mark', async () => {
        const { queue, calls } = fakes({ highWater: 100 });
        await expect(queue.storeEmbeddings('text', 11, 'data/schema/note', null, [])).resolves.toBe(true);
        expect(calls).toHaveLength(0); // accepted, not yet written
        await queue.flush();
        expect(calls).toEqual([{ table: 'vec', upserts: [11], deletes: [] }]);
    });

    test('a failed Lance delete reports the ids as not clean (no recycling)', async () => {
        const { queue } = fakes({ ftsOk: false });
        const gone = queue.deleteDocs([3]);
        await queue.flush();
        await expect(gone).resolves.toBe(false);
    });

    test('bitmap bookkeeping is applied under the write lock, seen ledger included', async () => {
        const { queue, lockLog } = fakes();
        queue.upsertText([{ id: 4 }]);
        const stored = queue.storeEmbeddings('text', 5, 'data/schema/note', null, []);
        await queue.flush();
        await expect(stored).resolves.toBe(true);
        expect(lockLog.length).toBeGreaterThan(0);
        expect(lockLog.every((entry) => entry.locked)).toBe(true);
        expect(lockLog).toContainEqual({ op: 'tick', key: 'internal/embed/seen/text', ids: [5], locked: true });
    });

    test('exclusive maintenance runs after queued writes, on the lane', async () => {
        const { queue, calls } = fakes();
        queue.upsertText([{ id: 9 }]);
        const order = [];
        await queue.exclusive(async () => { order.push(['optimize', calls.length]); });
        expect(order).toEqual([['optimize', 1]]); // the pending batch landed first
    });

    test('settle waits for pending writes, but a busy lane never stalls a read past readWaitMs', async () => {
        const { queue, calls } = fakes({ readWaitMs: 100 });
        queue.upsertText([{ id: 1 }]);
        await queue.settle();                    // idle lane: the write lands first
        expect(calls).toHaveLength(1);

        const compaction = queue.exclusive(() => new Promise((resolve) => setTimeout(resolve, 600)));
        queue.upsertText([{ id: 2 }]);
        const started = Date.now();
        await queue.settle();                    // lane busy: give up at the cap
        const waited = Date.now() - started;
        expect(waited).toBeGreaterThanOrEqual(90);
        expect(waited).toBeLessThan(500);
        await compaction;
        await queue.flush();
        expect(calls).toHaveLength(2);
    });
});

// ── Integration: the database writes behind, reads see their writes ───────

describe('write-behind search indexing', () => {
    let rootPath;
    let db;

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    async function open(options = {}) {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-search-queue-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, ...options });
        await db.start();
    }

    test('a search right after a put finds it (read-your-writes)', async () => {
        await open({ searchQueue: { delayMs: 60_000 } }); // only the read barrier can flush it
        const id = await db.put(fileDoc('birds.md', 'pelican migration routes'));
        expect(ids(await db.search({ query: 'pelican migration', mode: 'fts', idsOnly: true }))).toContain(id);
    });

    test('updates re-index and deletes drop out of search', async () => {
        await open();
        const id = await db.put(fileDoc('q3.md', 'quarterly figures'));
        await db.put({ id, ...fileDoc('q3-v2.md', 'annual summary') });
        expect(ids(await db.search({ query: 'quarterly figures', mode: 'fts', idsOnly: true }))).not.toContain(id);
        expect(ids(await db.search({ query: 'annual summary', mode: 'fts', idsOnly: true }))).toContain(id);

        await db.delete(id);
        expect(ids(await db.search({ query: 'annual summary', mode: 'fts', idsOnly: true }))).not.toContain(id);
    });

    test('a put never waits for search-index compaction', async () => {
        const reports = [];
        await open({ onSlowWrite: (r) => reports.push(r), slowWriteMs: 0.001 });
        await db.putMany(Array.from({ length: 50 }, (_, i) => note(`seed ${i}`)));
        const optimizing = db.optimizeLance();
        await db.put(note('during compaction'));
        await optimizing;
        // No document write ever queued behind the optimize on the write lock.
        expect(reports.some((r) => r.ahead.some((op) => /optimize/i.test(op.method || '')))).toBe(false);
    });

    test('shutdown writes out queued rows (survive a restart)', async () => {
        await open({ searchQueue: { delayMs: 60_000 } });
        const id = await db.put(fileDoc('kept.md', 'persisted through restart'));
        await db.shutdown();
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
        expect(ids(await db.search({ query: 'persisted through restart', mode: 'fts', idsOnly: true }))).toContain(id);
    });
});
