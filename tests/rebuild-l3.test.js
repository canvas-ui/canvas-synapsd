import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE = 'data/abstraction/note';
const TAB = 'data/abstraction/tab';
const FILE = 'data/abstraction/file';

// The derived-plane invariant, executable: drop every derived structure and
// recompute it from documents + extractors, and the index must come back
// identical. If it does not, something is storing state that has no source.
//
// This used to live in migrate-v3.test.js, which was deleted with the engine's
// migration code (2026-08-04). It is not a migration test — `rebuildL3()` is a
// live repair API — so it is seeded through the NORMAL write path here rather
// than from a legacy fixture.
describe('rebuildL3', () => {
    let rootPath;
    let db;

    const seed = async () => ({
        note: await db.put({
            schema: NOTE,
            data: { title: 'n', content: 'c' },
            features: ['tag/inbox'],
        }),
        tab: await db.put({ schema: TAB, data: { url: 'https://example.com', title: 't' } }),
        blob: await db.put({
            schema: FILE,
            data: {},
            checksumArray: ['sha256/abc'],
            locations: [{ url: 'stored://homenas/k1' }],
            metadata: { contentType: 'image/png' },
        }),
    });

    const snapshot = async () => ({
        mime: (await db.list({ features: ['data/mime/image/png'], limit: 0 })).map((d) => d.id),
        backend: (await db.list({ features: ['data/backend/stored/homenas'], limit: 0 })).map((d) => d.id),
        schema: (await db.list({ features: [TAB], limit: 0 })).map((d) => d.id),
        asserted: (await db.list({ features: ['tag/inbox'], limit: 0 })).map((d) => d.id),
    });

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-rebuild-l3-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('reproduces the derived plane from rows alone', async () => {
        await seed();
        const before = await snapshot();
        expect(before.mime).toHaveLength(1);
        expect(before.backend).toHaveLength(1);

        const stats = await db.rebuildL3();
        expect(stats.documents).toBe(3);

        expect(await snapshot()).toEqual(before);
    });

    test('drops the retired data/kind/* axis instead of re-deriving it', async () => {
        // With the engine's startup migrations gone, a rebuild is how a database
        // carrying the v3 subtype axis sheds it. Nothing derives the namespace, so
        // the drop is one-way — the negative half is the whole assertion.
        const ids = await seed();
        await db.bitmapIndex.tick('data/kind/browser', ids.tab);
        await db.bitmapIndex.tick('data/kind/browser/tab', ids.tab);
        expect(await db.bitmapIndex.listBitmaps('data/kind')).toHaveLength(2);

        await db.rebuildL3();

        expect(await db.bitmapIndex.listBitmaps('data/kind')).toEqual([]);
    });
});
