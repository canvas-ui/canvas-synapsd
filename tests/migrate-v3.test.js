import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE = 'data/abstraction/note';
const TAB = 'data/abstraction/tab';

// Phase 6. The fixture is built by writing v2-SHAPED ROWS DIRECTLY into the
// document store (indexOptions on the row, metadata.features, no kind), because
// current code can no longer produce that shape — constructing through the
// schema would silently write v3 rows and the test would prove nothing.
describe('v3 migration', () => {
    let rootPath;

    const openRaw = async (opts = {}) => {
        const db = new Db({
            path: rootPath, backupOnOpen: false, backupOnClose: false,
            semantic: { enabled: false }, ...opts,
        });
        await db.start();
        return db;
    };

    // Seed through the normal path, then rewrite the rows into legacy shape and
    // reset the stored schema version so the gate sees a stale DB.
    const seedLegacy = async () => {
        const db = await openRaw();
        const ids = {
            note: await db.put({ schema: NOTE, data: { title: 'n', content: 'n' } }),
            tab: await db.put({ schema: TAB, data: { url: 'https://example.com', title: 't' } }),
            blob: await db.put({
                schema: 'data/abstraction/file',
                data: {},
                checksumArray: ['sha256/abc'],
                locations: [{ url: 'stored://homenas/k1' }],
            }),
        };

        for (const id of Object.values(ids)) {
            const row = db.documents.get(id);
            row.indexOptions = { checksumFields: ['data'], ftsSearchFields: ['data'] };
            row.metadata = { ...(row.metadata || {}), features: ['tag/legacy', row.schema, 'data/mime/image/png'] };
            delete row.features;
            delete row.kind;
            await db.documents.put(id, row);
        }

        // A tag that exists ONLY in a bitmap — the pre-2026-07-15 state with no
        // doc-side record, which is the whole reason features moved onto the row.
        await db.bitmapIndex.tick('tag/bitmap-only', ids.note);
        // Legacy asserted backend key, in the pre-reshape flat form.
        await db.bitmapIndex.tick('data/backend/workspace:home', ids.blob);
        await db.bitmapIndex.tick('data/source/local', ids.blob);

        await db.internalStore.put('internal/schemaVersion', 1);
        await db.shutdown();
        return ids;
    };

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-migrate-'));
    });

    afterEach(async () => {
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('a stale database REFUSES to open without an explicit opt-in', async () => {
        await seedLegacy();

        // A full-table rewrite is an operator action, not something a server
        // restart does implicitly.
        await expect(openRaw()).rejects.toThrow(/needs v2[\s\S]*migrate-v3/);
    });

    test('CANVAS_SYNAPSD_MIGRATE opts in without a constructor flag', async () => {
        await seedLegacy();

        // `migrate` is a whole-DB switch, but the DB is constructed deep inside a
        // host process (one per workspace), so an env opt-in avoids threading a
        // flag through every call site.
        const previous = process.env.CANVAS_SYNAPSD_MIGRATE;
        process.env.CANVAS_SYNAPSD_MIGRATE = 'true';
        try {
            const db = await openRaw();
            expect(db.lastMigrationStats.documents).toBe(3);
            await db.shutdown();
        } finally {
            if (previous === undefined) { delete process.env.CANVAS_SYNAPSD_MIGRATE; }
            else { process.env.CANVAS_SYNAPSD_MIGRATE = previous; }
        }
    });

    test('a falsy CANVAS_SYNAPSD_MIGRATE does not opt in', async () => {
        await seedLegacy();

        const previous = process.env.CANVAS_SYNAPSD_MIGRATE;
        process.env.CANVAS_SYNAPSD_MIGRATE = '0';
        try {
            // '0'/'false' must mean what they look like, not "a non-empty string".
            await expect(openRaw()).rejects.toThrow(/needs v2/);
        } finally {
            if (previous === undefined) { delete process.env.CANVAS_SYNAPSD_MIGRATE; }
            else { process.env.CANVAS_SYNAPSD_MIGRATE = previous; }
        }
    });

    // Production crash, 2026-08-03: bumping SCHEMA_VERSION 1 -> 2 re-ran the v1
    // bitmap-key migration on databases that had already applied it. That
    // migration strips `feature/` from every key beneath it, so the engine-owned
    // `feature/has-comment` (created long after v1) became `has-comment`, which is
    // not a valid bitmap key at all — hasBitmap() threw and took workspace startup
    // down with it.
    describe('v1 bitmap-key migration does not re-run or eat engine keys', () => {
        const seedAtVersion = async (version, extraKeys = []) => {
            const db = await openRaw();
            const id = await db.put({
                schema: NOTE,
                data: { title: 'n', content: 'n' },
                comment: 'a comment creates feature/has-comment',
            });
            for (const key of extraKeys) { await db.bitmapIndex.tick(key, id); }
            await db.internalStore.put('internal/schemaVersion', version);
            await db.shutdown();
            return id;
        };

        test('a v1 database starts, and feature/has-comment survives', async () => {
            await seedAtVersion(1);

            const db = await openRaw({ migrate: true });
            expect(await db.bitmapIndex.hasBitmap('feature/has-comment')).toBe(true);
            await db.shutdown();
        });

        test('migrations are version-stepped — v1 work does not re-run on a v1 db', async () => {
            // Artificial legacy key on an ALREADY-migrated database: the v1 pass
            // must not touch it, because it already ran.
            await seedAtVersion(1, ['feature/tag/legacy-double']);

            const db = await openRaw({ migrate: true });
            expect(await db.bitmapIndex.listBitmaps('tag')).toEqual([]);
            expect(await db.bitmapIndex.listBitmaps('feature')).toContain('feature/tag/legacy-double');
            await db.shutdown();
        });

        test('a pre-v1 database still gets the double-prefix rewrite', async () => {
            await seedAtVersion(0, ['feature/tag/legacy-double']);

            const db = await openRaw({ migrate: true });
            // The genuinely legacy key is un-prefixed...
            expect(await db.bitmapIndex.listBitmaps('tag')).toEqual(['tag/legacy-double']);
            // ...while the engine-owned one is left exactly as it is.
            expect(await db.bitmapIndex.listBitmaps('feature')).toEqual(['feature/has-comment']);
            await db.shutdown();
        });
    });

    test('the embed-key migration is tracked separately from the schema version', async () => {
        // The migration script runs with semantic disabled, which skips the whole
        // vector branch. Gating the embed-key migration on SCHEMA_VERSION meant the
        // version got stamped to 2 without it ever running — and every later start
        // then saw "already current" and skipped it forever, silently leaving
        // vectors on legacy bitmap keys.
        await seedLegacy();

        const migrated = await openRaw({ migrate: true, semantic: { enabled: false } });
        expect(migrated.internalStore.get('internal/schemaVersion')).toBe(2);
        expect(migrated.internalStore.get('internal/migrations/embed-keys')).toBeUndefined();
        await migrated.shutdown();

        // First normal start with the vector stack on: it must still run.
        const normal = await openRaw({ semantic: { enabled: true } });
        expect(normal.internalStore.get('internal/migrations/embed-keys')).toBe(1);
        await normal.shutdown();
    });

    test('a fresh/empty database is stamped without hitting the gate', async () => {
        const db = await openRaw();
        expect(db.lastMigrationStats).toBeNull();
        await db.shutdown();

        // Re-opening a now-current DB stays clean.
        const again = await openRaw();
        expect(again.lastMigrationStats).toBeNull();
        await again.shutdown();
    });

    test('the row pass drops indexOptions, moves features and stamps kind', async () => {
        const ids = await seedLegacy();
        const db = await openRaw({ migrate: true });

        const raw = db.documents.get(ids.tab);
        expect(raw.indexOptions).toBeUndefined();
        expect(raw.metadata.features).toBeUndefined();
        expect(raw.kind).toBe('browser/tab');

        // Derived keys the legacy array carried are stripped; asserted ones stay.
        expect(raw.features).toContain('tag/legacy');
        expect(raw.features).not.toContain(TAB);
        expect(raw.features).not.toContain('data/mime/image/png');

        await db.shutdown();
    });

    test('bitmap-only tags are recovered onto the row', async () => {
        const ids = await seedLegacy();
        const db = await openRaw({ migrate: true });

        // These had no doc-side record at all — without the reverse scan they
        // would survive as bitmaps but be unrebuildable, which is exactly the
        // property the move to row-level features exists to fix.
        expect(db.documents.get(ids.note).features).toContain('tag/bitmap-only');
        expect(db.lastMigrationStats.featuresRecovered).toBeGreaterThan(0);

        await db.shutdown();
    });

    test('data/backend is reshaped and data/source is gone', async () => {
        const ids = await seedLegacy();
        const db = await openRaw({ migrate: true });

        const keysOf = async (prefix) => {
            const out = [];
            for (const key of await db.bitmapIndex.listBitmaps(prefix)) {
                const bm = await db.bitmapIndex.getBitmap(key, false);
                if (bm && bm.has(ids.blob)) { out.push(key); }
            }
            return out.sort();
        };

        expect(await keysOf('data/backend')).toEqual(['data/backend/stored', 'data/backend/stored/homenas']);
        expect(await db.bitmapIndex.listBitmaps('data/source')).toEqual([]);

        await db.shutdown();
    });

    test('kind bitmaps are derived for every migrated document', async () => {
        const ids = await seedLegacy();
        const db = await openRaw({ migrate: true });

        const byKind = await db.list({ features: ['data/kind/browser/tab'], limit: 0 });
        expect(byKind.map((d) => d.id)).toContain(ids.tab);

        await db.shutdown();
    });

    test('asserted feature bitmaps still answer after the move', async () => {
        const ids = await seedLegacy();
        const db = await openRaw({ migrate: true });

        const tagged = await db.list({ features: ['tag/legacy'], limit: 0 });
        expect(tagged.map((d) => d.id).sort()).toEqual(Object.values(ids).sort());

        await db.shutdown();
    });

    test('running the migration twice is a no-op', async () => {
        await seedLegacy();

        const first = await openRaw({ migrate: true });
        const firstStats = { ...first.lastMigrationStats };
        const snapshot = first.documents.get(first.lastMigrationStats ? 100001 : 100001);
        await first.shutdown();

        // Second open is already current, so the migration must not run at all.
        const second = await openRaw({ migrate: true });
        expect(second.lastMigrationStats).toBeNull();
        expect(second.documents.get(100001)).toEqual(snapshot);
        await second.shutdown();

        expect(firstStats.documents).toBe(3);
    });

    test('rebuildL3 reproduces the derived plane from rows alone', async () => {
        await seedLegacy();
        const db = await openRaw({ migrate: true });

        const before = {
            kind: await db.list({ features: ['data/kind/browser/tab'], limit: 0 }),
            backend: await db.list({ features: ['data/backend/stored/homenas'], limit: 0 }),
        };

        // The rebuild invariant, executable: drop the derived structures and
        // recompute them from documents + extractors.
        const stats = await db.rebuildL3();
        expect(stats.documents).toBe(3);

        const after = {
            kind: await db.list({ features: ['data/kind/browser/tab'], limit: 0 }),
            backend: await db.list({ features: ['data/backend/stored/homenas'], limit: 0 }),
        };

        expect(after.kind.map((d) => d.id)).toEqual(before.kind.map((d) => d.id));
        expect(after.backend.map((d) => d.id)).toEqual(before.backend.map((d) => d.id));

        await db.shutdown();
    });

    test('rebuildL3 restores asserted edges from data.relations', async () => {
        const db = await openRaw();
        const target = await db.put({ schema: NOTE, data: { title: 'target', content: 't' } });
        const source = await db.put({
            schema: NOTE,
            data: { title: 'src', content: 's', relations: [{ p: 'references', to: target }] },
        });
        expect(db.edges.exists(source, 'references', target)).toBe(true);

        // Blow the whole edge plane away, then rebuild from rows.
        db.edges.clear();
        expect(db.edges.exists(source, 'references', target)).toBe(false);

        await db.rebuildL3();
        expect(db.edges.exists(source, 'references', target)).toBe(true);

        await db.shutdown();
    });
});
