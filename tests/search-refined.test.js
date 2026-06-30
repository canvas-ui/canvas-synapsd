import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE = (title) => ({ schema: 'data/abstraction/note', data: { title, content: title } });
const sorted = (a) => [...a].sort((x, y) => x - y);

// Lance/FTS is not available in the test env. These cover the structured (slice)
// branches + graceful degradation; the fts fold is verified against the live server.
describe('searchRefined (stateless multi-query fold) — non-FTS branches', () => {
    let rootPath, db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-refined-'));
        const LanceIndex = (await import('../src/indexes/lance/index.js')).default;
        LanceIndex.prototype.initialize = async function () {};
        LanceIndex.prototype.backfill = async function () {};
        LanceIndex.prototype.addMany = async function () {};
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('no text queries → structured base listing (slice path)', async () => {
        const a1 = await db.put(NOTE('a1'), { context: { path: '/Alpha' } });
        await db.put(NOTE('b1'), { context: { path: '/Beta' } });

        const res = await db.searchRefined([], { context: { path: '/Alpha' } }, { limit: 10 });
        expect(res.error).toBeNull();
        expect(sorted(res.map((d) => d.id))).toEqual([a1]);
    });

    test('empty/whitespace queries are ignored', async () => {
        const a1 = await db.put(NOTE('a1'), { context: { path: '/Alpha' } });
        const res = await db.searchRefined(['', '   '], { context: { path: '/Alpha' } }, {});
        expect(res.error).toBeNull();
        expect(res.map((d) => d.id)).toEqual([a1]);
    });

    test('multi-query without FTS degrades to a clean error, not a crash', async () => {
        await db.put(NOTE('a1'), { context: { path: '/Alpha' } });
        const res = await db.searchRefined(['car', 'red'], { context: { path: '/Alpha' } }, {});
        expect(res.error).toBe('FTS not initialized');
        expect(res).toHaveLength(0);
    });

    test('single query routes through rank (FTS error path, no fold)', async () => {
        await db.put(NOTE('a1'), { context: { path: '/Alpha' } });
        // mode:'fts' avoids the dense embedder (unavailable in test env); rank's
        // fts branch reports 'FTS not initialized' when Lance is not ready.
        const res = await db.searchRefined(['car'], { context: { path: '/Alpha' } }, { mode: 'fts' });
        expect(res.error).toBe('FTS not initialized');
    });
});
