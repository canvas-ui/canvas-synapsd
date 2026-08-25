import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/schema/note';
const FILE_SCHEMA = 'data/schema/file';
const ORPHANED = 'feature/orphaned';

function note(title, content = title) {
    return { schema: NOTE_SCHEMA, data: { title, content } };
}

function file(checksum, locations) {
    return {
        schema: FILE_SCHEMA,
        data: {},
        checksumArray: [`sha256/${checksum}`],
        locations,
    };
}

function ids(results) {
    return results.map((doc) => doc.id).sort((a, b) => a - b);
}

// Orphan lifecycle (orphanedAt + feature/orphaned) and edit-succession
// placement migration (migrateDocumentMemberships) — the synapsd primitives
// behind the workspace's orphan-not-delete reconciliation.
describe('SynapsD orphan lifecycle + placement migration', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-orphan-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('orphanedAt + empty locations ticks feature/orphaned; re-bind unticks it', async () => {
        const id = await db.put({
            ...file('orphan', [{ url: 'stored://workspace:home/x' }]),
        }, { context: { path: '/Projects/Alpha' } });

        expect(await db.list({ features: { allOf: [ORPHANED] } })).toHaveLength(0);

        const stamp = new Date().toISOString();
        await db.put({ id, locations: [], orphanedAt: stamp }, { context: null });

        expect(ids(await db.list({ features: { allOf: [ORPHANED] } }))).toEqual([id]);
        const orphan = await db.get(id);
        expect(orphan.orphanedAt).toBe(stamp);
        expect(orphan.features || []).not.toContain(ORPHANED);
        expect(ids(await db.list({ paths: ['ctx:/Projects/Alpha'] }))).toEqual([id]);

        await db.put({
            id,
            locations: [{ url: 'stored://workspace:home/x' }],
            orphanedAt: null,
        }, { context: null });

        expect(await db.list({ features: { allOf: [ORPHANED] } })).toHaveLength(0);
        expect((await db.get(id)).orphanedAt).toBeNull();
        expect(ids(await db.list({ paths: ['ctx:/Projects/Alpha'] }))).toEqual([id]);
    });

    // The key is the ORPHAN axis, not "has no locations". A schema allowlist was
    // tried and could not express Task: one typed into Canvas is complete without
    // a copy, one mirrored from a deleted GitHub issue is not. Same schema,
    // opposite answers, so the discriminator has to be per-row (orphanedAt).
    test('documents that never had a copy stay out, whatever the schema', async () => {
        const noteId = await db.put(note('just-a-note'));
        const taskId = await db.put({ schema: 'data/schema/task', data: { title: 'inbox' } });
        // A file with no bytes is a BROKEN row, not an orphan — a different alert.
        const fileId = await db.put(file('never-stored', []));

        expect((await db.get(noteId)).locations || []).toEqual([]);
        expect(await db.list({ features: { allOf: [ORPHANED] } })).toHaveLength(0);
        expect(ids(await db.list({}))).toEqual(expect.arrayContaining([noteId, taskId, fileId]));
    });

    test('a pruned GitHub task orphans onto the same axis as a vanished file', async () => {
        const local = await db.put({ schema: 'data/schema/task', data: { title: 'inbox' } });

        const id = await db.put({
            schema: 'data/schema/task',
            data: { title: 'issue' },
            locations: [
                { url: 'gh://acme/api/issues/7', metadata: { provenance: true } },
                { url: 'https://github.com/acme/api/issues/7' },
            ],
        });
        expect(await db.list({ features: { allOf: [ORPHANED] } })).toHaveLength(0);

        const stamp = new Date().toISOString();
        await db.put({ id, locations: [], orphanedAt: stamp }, { context: null });
        expect(ids(await db.list({ features: { allOf: [ORPHANED] } }))).toEqual([id]);
        expect(ids(await db.list({ features: { allOf: [ORPHANED] } }))).not.toContain(local);

        await db.put({
            id,
            locations: [{ url: 'gh://acme/api/issues/7', metadata: { provenance: true } }],
            orphanedAt: null,
        }, { context: null });
        expect(await db.list({ features: { allOf: [ORPHANED] } })).toHaveLength(0);
    });

    test('asserting feature/orphaned is stripped — the derivation owns the key', async () => {
        const id = await db.put({
            ...file('sneaky', [{ url: 'stored://workspace:home/x' }]),
            features: [ORPHANED, 'tag/keepme'],
        });
        expect((await db.get(id)).features).toEqual(['tag/keepme']);
        expect(await db.list({ features: { allOf: [ORPHANED] } })).toHaveLength(0);
    });

    // The key is a leaf, and listBitmaps() is a `prefix/…` range that never
    // returns one — so rebuildL3 has to drop it by exact key or the replay's
    // re-tick would sit on top of a stale bitmap.
    test('rebuildL3 reproduces feature/orphaned from rows alone', async () => {
        const orphanId = await db.put({
            ...file('rebuild-orphan', []),
            orphanedAt: new Date().toISOString(),
        });
        const liveId = await db.put(file('rebuild-live', [{ url: 'stored://homenas/k' }]));

        expect(ids(await db.list({ features: { allOf: [ORPHANED] } }))).toEqual([orphanId]);

        await db.rebuildL3();

        expect(ids(await db.list({ features: { allOf: [ORPHANED] } }))).toEqual([orphanId]);
        expect(ids(await db.list({ features: { allOf: ['data/backend/stored'] } }))).toEqual([liveId]);
    });

    test('migrateDocumentMemberships copies placements to the successor, honoring excludeTrees', async () => {
        const oldId = await db.put(note('predecessor'), {
            context: { path: '/Projects/Alpha' },
            directory: { path: '/reports' },
        });
        const newId = await db.put(note('successor'), { context: null });
        expect(newId).not.toBe(oldId);

        const copied = await db.migrateDocumentMemberships(oldId, newId, { excludeTrees: ['directory'] });
        expect(copied.length).toBeGreaterThan(0);

        // Context placement migrated; excluded directory tree did not.
        expect(ids(await db.list({ paths: ['ctx:/Projects/Alpha'] }))).toEqual([oldId, newId].sort((a, b) => a - b));
        expect(ids(await db.list({ paths: ['dir:/reports'] }))).toEqual([oldId]);

        // Predecessor keeps its own placements (migration copies, never moves).
        expect(await db.listDocumentTreePaths(oldId, 'directory')).toEqual(['/reports']);
    });

    test('migrateDocumentMemberships without exclusions copies directory placements too', async () => {
        const oldId = await db.put(note('predecessor-2'), { directory: { path: '/curated/deep' } });
        const newId = await db.put(note('successor-2'), { context: null });

        await db.migrateDocumentMemberships(oldId, newId);
        expect(ids(await db.list({ paths: ['dir:/curated/deep'] }))).toEqual([oldId, newId].sort((a, b) => a - b));
    });

    test('migrating onto the same id is a no-op', async () => {
        const id = await db.put(note('self'), { context: { path: '/x' } });
        expect(await db.migrateDocumentMemberships(id, id)).toEqual([]);
    });
});
