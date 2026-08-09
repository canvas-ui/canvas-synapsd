import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import SynapsD from '../src/index.js';

// searchByVector: the vector-in twin of the text search path. The caller
// (embedd for an uploaded image, a sensor pipeline for a camera frame,
// getDocumentVector for "more like this") supplies the query vector; synapsd
// only scopes + scans + materializes. Exercised with a small-dim fake image
// space — no model, no worker.

const NOTE = (title) => ({ schema: 'data/schema/note', data: { title, content: title } });
const DIM = 8;
const IMG_SPACE = {
    image: {
        table: 'vec_image_test', model: 'test-img', dim: DIM, annIndex: false,
        bitmapKey: 'internal/embed/vectors/image/test-img',
        seenKey: 'internal/embed/seen/image/test-img',
    },
};
const vec = (values) => {
    const v = new Array(DIM).fill(0);
    values.forEach((x, i) => { v[i] = x; });
    return v;
};
const E1 = vec([1]);                 // unit x
const NEAR_E1 = vec([0.9, 0.1]);     // cosine distance ~0.006 from E1
const E2 = vec([0, 1]);              // orthogonal: cosine distance 1 from E1

describe('searchByVector / getDocumentVector', () => {
    let dbPath;
    let db;
    let a; let b; let c;

    beforeEach(async () => {
        dbPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-search-vec-'));
        db = new SynapsD({
            path: dbPath,
            backupOnOpen: false,
            backupOnClose: false,
            semantic: { enabled: true, spaces: IMG_SPACE },
        });
        await db.start();

        a = await db.put(NOTE('a'), { context: { path: '/Photos' } });
        b = await db.put(NOTE('b'), { context: { path: '/Photos' } });
        c = await db.put(NOTE('c'), { context: { path: '/Other' } });
        const now = new Date().toISOString();
        await db.storeDocumentEmbeddings(a, 'data/schema/note', now, [{ chunkId: 0, text: '', vector: E1 }], { space: 'image' });
        await db.storeDocumentEmbeddings(b, 'data/schema/note', now, [{ chunkId: 0, text: '', vector: NEAR_E1 }], { space: 'image' });
        await db.storeDocumentEmbeddings(c, 'data/schema/note', now, [{ chunkId: 0, text: '', vector: E2 }], { space: 'image' });
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (dbPath) { await fs.rm(dbPath, { recursive: true, force: true }); dbPath = null; }
    });

    test('kNN order, distance floor, ids envelope', async () => {
        const res = await db.searchByVector(E1, {}, { idsOnly: true });
        expect(res.error).toBe(null);
        expect(res.slice(0, 2)).toEqual([a, b]);          // best-first
        expect(res).toContain(c);                          // no floor → top-K includes orthogonal

        const floored = await db.searchByVector(E1, {}, { idsOnly: true, maxDistance: 0.5 });
        expect([...floored]).toEqual([a, b]);              // orthogonal c dropped
        expect(floored.count).toBe(2);

        // withDistances → .debug.distances, best-first, interpretable cosine.
        const dbg = await db.searchByVector(E1, {}, { idsOnly: true, withDistances: true, minDistance: 0, maxDistance: 2 });
        expect(dbg.debug.distances[0].id).toBe(a);
        expect(dbg.debug.distances[0].distance).toBeCloseTo(0, 3);
    });

    test('structured scope + ids bucket push down into the scan', async () => {
        // Context scope: /Other only → the nearest hit inside the scope is c.
        const scoped = await db.searchByVector(E1, { context: { path: '/Other' } }, { idsOnly: true });
        expect([...scoped]).toEqual([c]);

        // id-set bucket composes the same way (sensor/kNN handoff shape).
        const idScoped = await db.searchByVector(E1, { ids: [b, c] }, { idsOnly: true, maxDistance: 0.5 });
        expect([...idScoped]).toEqual([b]);

        // Empty scope short-circuits without touching Lance.
        const none = await db.searchByVector(E1, { context: { path: '/Nowhere' } }, { idsOnly: true });
        expect(none.count).toBe(0);
    });

    test('materialized docs come back parsed, in kNN order', async () => {
        const docs = await db.searchByVector(E1, {}, { maxDistance: 0.5 });
        expect(docs.error).toBe(null);
        expect(docs.map((d) => d.data.title)).toEqual(['a', 'b']);
        expect(docs.totalCount).toBe(2);
    });

    test('getDocumentVector + excludeIds = "more like this" without self-match', async () => {
        const stored = await db.getDocumentVector(a, 'image');
        expect(stored).toHaveLength(DIM);
        expect(stored[0]).toBeCloseTo(1, 5);

        const similar = await db.searchByVector(stored, {}, { idsOnly: true, maxDistance: 0.5, excludeIds: [a] });
        expect([...similar]).toEqual([b]);                 // a filtered, b promoted to rank 0

        expect(await db.getDocumentVector(999999, 'image')).toBe(null);
    });

    test('argument + space guards', async () => {
        await expect(db.searchByVector([1, 2, 3], {})).rejects.toThrow(/dim/);         // dim mismatch
        await expect(db.searchByVector([], {})).rejects.toThrow(/query vector/);       // empty
        await expect(db.searchByVector(['x'], {})).rejects.toThrow(/query vector/);    // non-numeric
        const missing = await db.searchByVector(E1, {}, { space: 'nope' });
        expect(missing.error).toMatch(/not available/);
        expect(missing.count).toBe(0);
    });
});
