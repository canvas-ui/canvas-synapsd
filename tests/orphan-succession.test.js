import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/schema/note';

function note(title, content = title) {
    return { schema: NOTE_SCHEMA, data: { title, content } };
}

function ids(results) {
    return results.map((doc) => doc.id).sort((a, b) => a - b);
}

// Orphan lifecycle (orphanedAt + data/no-location) and edit-succession
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

    test('empty locations[] ticks data/no-location; re-bind unticks it', async () => {
        const id = await db.put({
            ...note('orphan-me'),
            locations: [{ url: 'stored://workspace:home/x' }],
        }, { context: { path: '/Projects/Alpha' } });

        expect(await db.list({ features: { allOf: ['data/no-location'] } })).toHaveLength(0);

        const stamp = new Date().toISOString();
        await db.put({ id, locations: [], orphanedAt: stamp }, { context: null });

        expect(ids(await db.list({ features: { allOf: ['data/no-location'] } }))).toEqual([id]);
        const orphan = await db.get(id);
        expect(orphan.orphanedAt).toBe(stamp);
        expect(orphan.features || []).not.toContain('data/no-location');
        expect(ids(await db.list({ paths: ['ctx:/Projects/Alpha'] }))).toEqual([id]);

        await db.put({
            id,
            locations: [{ url: 'stored://workspace:home/x' }],
            orphanedAt: null,
        }, { context: null });

        expect(await db.list({ features: { allOf: ['data/no-location'] } })).toHaveLength(0);
        expect((await db.get(id)).orphanedAt).toBeNull();
        expect(ids(await db.list({ paths: ['ctx:/Projects/Alpha'] }))).toEqual([id]);
    });

    test('asserting data/no-location is stripped — the derivation owns the key', async () => {
        const id = await db.put({
            ...note('sneaky'),
            locations: [{ url: 'stored://workspace:home/x' }],
            features: ['data/no-location', 'tag/keepme'],
        });
        expect((await db.get(id)).features).toEqual(['tag/keepme']);
        expect(await db.list({ features: { allOf: ['data/no-location'] } })).toHaveLength(0);
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
