import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/abstraction/note';

// Unique content per note so checksum dedup never folds two inserts into one doc.
function note(tag) {
    return { schema: NOTE_SCHEMA, data: { title: tag, content: `content-${tag}-${Math.random()}` } };
}

// Freed document IDs must be recycled (regression: allocator was counter-only,
// ids grew monotonically forever and roaring density degraded). The
// internal/gc/deleted bitmap is a strict free-id pool, popped densest-first.
describe('SynapsD document-id GC / reuse', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-idgc-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('a deleted id is reused by the next insert', async () => {
        const [id1] = await db.putMany([note('a')]);
        await db.delete(id1);

        const [id2] = await db.putMany([note('b')]);
        expect(id2).toBe(id1);
    });

    test('reuse is densest-first (lowest freed id wins), then the counter', async () => {
        const [a] = await db.putMany([note('a')]);
        const [b] = await db.putMany([note('b')]);
        const [c] = await db.putMany([note('c')]);
        expect(a).toBeLessThan(b);
        expect(b).toBeLessThan(c);

        await db.delete(c);
        await db.delete(b);
        // pool = {b, c}

        const [d] = await db.putMany([note('d')]);
        expect(d).toBe(b); // minimum of the pool

        const [e] = await db.putMany([note('e')]);
        expect(e).toBe(c);

        const [f] = await db.putMany([note('f')]);
        expect(f).toBeGreaterThan(c); // pool empty -> counter
    });

    test('batch insert drains the pool first, then tops up from the counter', async () => {
        const created = await db.putMany([note('a'), note('b'), note('c')]);
        const sorted = [...created].sort((x, y) => x - y);

        const del = await db.deleteMany(created);
        expect(del.successful.map(s => s.id).sort((x, y) => x - y)).toEqual(sorted);
        // pool = {a, b, c}

        const next = await db.putMany([note('d'), note('e'), note('f'), note('g'), note('h')]);
        // first three drain the pool densest-first; remaining two come from counter
        expect(next.slice(0, 3)).toEqual(sorted);
        expect(next[3]).toBeGreaterThan(sorted[2]);
        expect(next[4]).toBe(next[3] + 1);
    });

    test('free pool survives restart (admission is persisted)', async () => {
        const [a] = await db.putMany([note('a')]);
        await db.putMany([note('b')]);
        await db.delete(a);

        await db.shutdown();
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();

        const [reused] = await db.putMany([note('c')]);
        expect(reused).toBe(a);
    });

    test('the free pool grows on delete and shrinks on reuse', async () => {
        const ids = await db.putMany([note('a'), note('b')]);
        await db.deleteMany(ids);
        expect(db.deletedDocumentsBitmap.size).toBe(2);

        // Reusing an id removes it from the pool.
        await db.putMany([note('c')]);
        expect(db.deletedDocumentsBitmap.size).toBe(1);
    });
});
