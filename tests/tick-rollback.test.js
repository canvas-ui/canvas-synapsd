import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/abstraction/note';
const note = (title) => ({ schema: NOTE_SCHEMA, data: { title, content: title } });

// Semantic disabled: this suite exercises the bitmap/synapse transaction path
// only, so we skip the ~130MB embedding-model download and the native Lance
// teardown entirely — keeps the rollback assertions fast and deterministic.
async function open(rootPath) {
    const db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
    await db.start();
    return db;
}

describe('SynapsD bitmap tick rollback safety', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-rollback-'));
        db = await open(rootPath);
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('an aborted transaction leaves no phantom bitmap tick (cache or disk)', async () => {
        // Inject a failure on the 2nd document.put of a batch. Doc 1 passes through
        // #indexDocument (membership buffered) before doc 2 aborts the transaction.
        // Pre-fix, doc 1's tick mutated the shared bitmap cache + putSync and was
        // never rolled back, leaving 'tag/phantom' permanently holding a doc that
        // was never committed.
        const realPut = db.documents.put.bind(db.documents);
        let calls = 0;
        db.documents.put = async (id, val) => {
            calls++;
            if (calls === 2) { throw new Error('injected failure on 2nd doc'); }
            return realPut(id, val);
        };

        await expect(db.putMany(
            [note('rollback-A'), note('rollback-B')],
            { context: { path: '/Rollback/Zone' }, features: ['tag/phantom'] },
        )).rejects.toThrow();

        db.documents.put = realPut;

        // No doc committed → no tick may survive, in the live cache or a query.
        const phantom = await db.bitmapIndex.getBitmap('tag/phantom', false);
        expect(phantom?.isEmpty ?? true).toBe(true);
        expect(await db.list({ features: { allOf: ['tag/phantom'] } })).toHaveLength(0);

        // Restart proves nothing leaked to disk either.
        await db.shutdown();
        db = await open(rootPath);
        const phantomDisk = await db.bitmapIndex.getBitmap('tag/phantom', false);
        expect(phantomDisk?.isEmpty ?? true).toBe(true);
    });

    test('a committed write ticks bitmaps and survives restart', async () => {
        const id = await db.put(note('alpha'), { context: { path: '/Projects/Alpha' }, features: ['tag/red'] });
        await db.link(id, { features: ['tag/linked'] });
        await db.unlink(id, { context: null, features: ['tag/red'] });

        const keys = await db.synapses.listSynapses(id);
        expect(keys).toContain('tag/linked');
        expect(keys).not.toContain('tag/red');
        for (const key of keys) {
            const bmp = await db.bitmapIndex.getBitmap(key, false);
            expect(bmp?.has(id)).toBe(true);
        }
        const red = await db.bitmapIndex.getBitmap('tag/red', false);
        expect(red?.has(id) ?? false).toBe(false);

        await db.shutdown();
        db = await open(rootPath);
        expect((await db.list({ features: { allOf: ['tag/linked'] } })).map((d) => d.id)).toEqual([id]);
        expect(await db.list({ features: { allOf: ['tag/red'] } })).toHaveLength(0);
    });
});
