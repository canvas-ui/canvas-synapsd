import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db, { derivedBitmapPrefixes } from '../src/index.js';

const NOTE = 'data/schema/note';
const TAB = 'data/schema/tab';
const FILE = 'data/schema/file';
const TASK = 'data/schema/task';
const DEVICE = 'data/schema/device';
const COMMENT = 'feature/has-comment';

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

    const hasCommentIds = async () =>
        (await db.list({ features: [COMMENT], limit: 0 })).map((d) => d.id).sort((a, b) => a - b);

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

    // A user-authored comment cannot be regenerated from anything (a photo's
    // "two minutes before the wine disaster" is not recoverable from a captioner),
    // so the bitmap that makes it findable has to come back from the row rather
    // than relying on no write path ever having missed an untick.
    test('reproduces feature/has-comment, and drops a stale tick', async () => {
        const ids = await seed();
        await db.put({ id: ids.note, comment: 'two minutes before the wine disaster' });
        // A doc whose comment is gone but whose bitmap is not: only the drop can
        // fix this, since the replay only ticks.
        await db.bitmapIndex.tick(COMMENT, ids.tab);
        expect(await hasCommentIds()).toEqual([ids.note, ids.tab].sort((a, b) => a - b));

        await db.rebuildL3();

        expect(await hasCommentIds()).toEqual([ids.note]);
        expect((await db.get(ids.note)).comment).toBe('two minutes before the wine disaster');
    });

    // One document per derived namespace, so the sweep below is not asserting over
    // an empty plane. Device first: device/os|type resolve through the Device row,
    // and a file written before it lands only gets device/id.
    const seedEveryDerivedNamespace = async () => {
        await db.put({
            schema: DEVICE,
            data: { deviceId: 'laptop1', name: 'Laptop', platform: 'linux', type: 'laptop' },
        });
        const orphan = await db.put({
            schema: FILE,
            data: {},
            checksumArray: ['sha256/orphan'],
            locations: [{ url: 'stored://homenas/gone' }],
        });
        await db.put({ id: orphan, locations: [], orphanedAt: new Date().toISOString() });

        const ids = await seed();
        await db.put({ id: ids.note, comment: 'keep me' });
        return {
            ...ids,
            orphan,
            // device/id + device/os + device/type
            onDevice: await db.put({
                schema: FILE,
                data: {},
                checksumArray: ['sha256/local'],
                locations: [{ url: 'file://laptop1/home/idnc/notes.md' }],
                metadata: { contentType: 'text/markdown' },
            }),
            // data/status/* — a per-schema facet namespace, which the drop list has
            // to compute from the registry rather than hardcode.
            task: await db.put({ schema: TASK, data: { title: 'ship it', status: 'pending' } }),
        };
    };

    // The whole derived plane, keyed by bitmap, membership sorted.
    const derivedPlane = async () => {
        const out = {};
        for (const prefix of derivedBitmapPrefixes()) {
            for (const key of await db.bitmapIndex.listBitmaps(prefix)) {
                const bitmap = await db.bitmapIndex.getBitmap(key, false);
                out[key] = (bitmap?.toArray() ?? []).sort((a, b) => a - b);
            }
        }
        return out;
    };

    // The generalization of the has-comment case above, and the reason rebuildL3
    // drops before it replays. The replay only ticks, so a derived namespace the
    // drop list misses comes out of a rebuild as `stale ∪ derived(rows)` — the
    // rebuild silently preserves exactly the drift it was run to repair. Asserting
    // it per-key would mean remembering to extend this test whenever a deriver is
    // added, so it sweeps every key the fixture produced instead.
    test('every derived bitmap sheds a tick no row justifies', async () => {
        await seedEveryDerivedNamespace();
        const before = await derivedPlane();

        // Guards the sweep against a fixture that quietly stops covering a
        // namespace, which would let the assertion pass over nothing.
        for (const prefix of derivedBitmapPrefixes()) {
            expect({ prefix, keys: Object.keys(before).filter((k) => k.startsWith(`${prefix}/`)) })
                .not.toEqual({ prefix, keys: [] });
        }

        // An id with no row behind it: the replay walks documents, so nothing can
        // put this back and only the drop can take it away.
        for (const key of Object.keys(before)) { await db.bitmapIndex.tick(key, 999_999); }

        await db.rebuildL3();

        expect(await derivedPlane()).toEqual(before);
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
