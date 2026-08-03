import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE = 'data/abstraction/note';
const TAB = 'data/abstraction/tab';
const APP = 'data/abstraction/application';
const FILE = 'data/abstraction/file';

// `kind` is the axis consumers migrate to ahead of the deferred data/entity/*
// rename: data/kind/browser/tab must answer what data/abstraction/tab answers,
// so a submodule can switch on its own release cadence.
describe('kind: derived row field + hierarchical data/kind/* bitmaps', () => {
    let rootPath;
    let db;

    // Assert on BITMAP MEMBERSHIP, never on the rehydrated document: db.get()
    // rebuilds through the subclass constructor, so a read can look correct while
    // the stored index is stale. Only write-time bitmaps expose drift.
    const featuresOf = async (id) => {
        const keys = await db.bitmapIndex.listBitmaps('data/kind');
        const out = [];
        for (const key of keys) {
            const bitmap = await db.bitmapIndex.getBitmap(key, false);
            if (bitmap && bitmap.has(id)) { out.push(key); }
        }
        return out.sort();
    };

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-kind-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('a literal kind is stamped on the row and ticked', async () => {
        const id = await db.put({ schema: NOTE, data: { title: 'n', content: 'n' } });

        expect((await db.get(id)).kind).toBe('note');
        expect(await featuresOf(id)).toEqual(['data/kind/note']);
    });

    test('a hierarchical kind ticks parent AND child, so the parent is a roll-up', async () => {
        const id = await db.put({ schema: TAB, data: { url: 'https://example.com', title: 't' } });

        expect((await db.get(id)).kind).toBe('browser/tab');
        expect(await featuresOf(id)).toEqual(['data/kind/browser', 'data/kind/browser/tab']);

        // The roll-up is the point: "everything browser-ish" is ONE key, with no
        // enumeration of children.
        const rollup = await db.list({ features: ['data/kind/browser'], limit: 0 });
        expect(rollup.map((d) => d.id)).toEqual([id]);
    });

    test('a kindField is read per-document under the entity prefix', async () => {
        const id = await db.put({
            schema: APP,
            data: { appId: 'org.gimp.GIMP', name: 'GIMP', type: 'flatpak', source: { ref: 'org.gimp.GIMP' } },
        });

        expect((await db.get(id)).kind).toBe('application/flatpak');
        expect(await featuresOf(id)).toEqual(['data/kind/application', 'data/kind/application/flatpak']);
    });

    test('a schema with no kind axis stamps null and ticks nothing', async () => {
        const id = await db.put({ schema: FILE, data: { name: 'x.bin' }, checksumArray: ['sha1/deadbeef'] });

        expect((await db.get(id)).kind).toBeNull();
        expect(await featuresOf(id)).toEqual([]);
    });

    test('data/kind/* returns the same set as the equivalent data/abstraction/* query', async () => {
        // THE migration property: a consumer can swap one for the other without
        // changing results. If this ever diverges, incremental migration breaks.
        const a = await db.put({ schema: TAB, data: { url: 'https://a.example', title: 'a' } });
        const b = await db.put({ schema: TAB, data: { url: 'https://b.example', title: 'b' } });
        await db.put({ schema: NOTE, data: { title: 'n', content: 'n' } });

        const byAbstraction = await db.list({ features: [TAB], limit: 0 });
        const byKind = await db.list({ features: ['data/kind/browser/tab'], limit: 0 });

        expect(byKind.map((d) => d.id).sort()).toEqual([a, b].sort());
        expect(byKind.map((d) => d.id).sort()).toEqual(byAbstraction.map((d) => d.id).sort());
    });

    test('a client cannot pin an invented kind — the derived value wins', async () => {
        const id = await db.put({ schema: NOTE, kind: 'totally/made-up', data: { title: 'n', content: 'n' } });

        expect((await db.get(id)).kind).toBe('note');
        expect(await featuresOf(id)).toEqual(['data/kind/note']);
    });

    test('changing the kind unticks the old bitmap — the drift case', async () => {
        const id = await db.put({
            schema: APP,
            data: { appId: 'org.gimp.GIMP', name: 'GIMP', type: 'flatpak', source: { ref: 'org.gimp.GIMP' } },
        });
        expect(await featuresOf(id)).toContain('data/kind/application/flatpak');

        await db.put({
            id,
            schema: APP,
            data: { appId: 'org.gimp.GIMP', name: 'GIMP', type: 'snap', source: { name: 'gimp' } },
        });

        const keys = await featuresOf(id);
        // The NEGATIVE half is what matters: a positive-only assertion passes even
        // when the untick never fires.
        expect(keys).not.toContain('data/kind/application/flatpak');
        expect(keys).toEqual(['data/kind/application', 'data/kind/application/snap']);
    });

    test('kind is outside the checksum — it must not fork identity', async () => {
        const first = await db.put({ schema: NOTE, data: { title: 'same', content: 'same' } });
        const again = await db.put({ schema: NOTE, kind: 'nonsense', data: { title: 'same', content: 'same' } });
        expect(again).toBe(first);
    });
});
