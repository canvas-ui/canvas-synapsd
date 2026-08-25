import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE = 'data/schema/note';
const TAB = 'data/schema/tab';
const APP = 'data/schema/application';

// The v3 `kind` axis — a `kind` row field mirrored into hierarchical
// `data/kind/*` bitmaps — was REMOVED 2026-08-04. The schema hierarchy carries
// the subtype in the id itself (`data/schema/application/flatpak`), so a second
// axis was one representation of one fact too many. It had zero consumers, which
// is what made the removal free.
//
// Replaces tests/kind-bitmaps.test.js. Removal needs a guard as much as a feature
// does: a resurrected axis is silent — bitmaps just start appearing again.
describe('kind axis removal', () => {
    let rootPath;
    let db;

    const open = async () => {
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
        return db;
    };

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-kind-removed-'));
        await open();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('writing the schemas that used to carry a kind ticks no data/kind/* key', async () => {
        // tab had a literal kind ('browser/tab'), application a kindField
        // ('application/flatpak'), note a single-segment literal ('note').
        await db.put({ schema: TAB, data: { url: 'https://example.com/a', title: 'a' } });
        await db.put({
            schema: `${APP}/flatpak`,
            data: { appId: 'org.gimp.GIMP', name: 'GIMP', source: { ref: 'org.gimp.GIMP' } },
        });
        await db.put({ schema: NOTE, data: { title: 'n', content: 'c' } });

        expect(await db.bitmapIndex.listBitmaps('data/kind')).toEqual([]);
    });

    test('the row field is gone — not null, absent', async () => {
        const id = await db.put({ schema: TAB, data: { url: 'https://example.com/b', title: 'b' } });

        // Assert on the STORED row: db.get() rehydrates through the constructor,
        // so a read can look clean while the row still carries the field.
        const raw = db.documents.get(id);
        expect('kind' in raw).toBe(false);
        expect(raw.schema).toBe(TAB);
    });

    test('a client cannot re-assert the retired namespace through features[]', async () => {
        // `data/kind/*` is refused like a derived key: nothing derives it any more,
        // so an asserted copy would be a live bitmap with no source and no untick.
        const id = await db.put({
            schema: NOTE,
            data: { title: 'sneaky', content: 'c' },
            features: ['data/kind/browser/tab', 'tag/keepme'],
        });

        expect((await db.get(id)).features).toEqual(['tag/keepme']);
        expect(await db.bitmapIndex.listBitmaps('data/kind')).toEqual([]);
    });

    test('the retired namespace is not re-derivable — a rebuild only drops it', async () => {
        // Migration code left the engine 2026-08-04, so shedding the v3 axis is
        // `rebuildL3()`'s job now (covered end-to-end in rebuild-l3.test.js). What
        // matters here is that no write path can bring it back.
        const id = await db.put({ schema: TAB, data: { url: 'https://example.com/c', title: 'c' } });
        await db.bitmapIndex.tick('data/kind/browser/tab', id);

        await db.put({ id, data: { url: 'https://example.com/c', title: 'renamed' } });
        await db.rebuildL3();

        expect(await db.bitmapIndex.listBitmaps('data/kind')).toEqual([]);
    });
});
