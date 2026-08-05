import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE = 'data/schema/note';
const APP = 'data/schema/application';
const EMAIL = 'data/schema/message/email';
const MESSAGE = 'data/schema/message';

const email = (subject, extra = {}) => ({
    schema: EMAIL,
    data: {
        subject,
        body: 'b',
        from: 'a@example.com',
        to: ['b@example.com'],
        date: '2026-08-05T00:00:00.000Z',
        messageId: `<${subject.replace(/\s+/g, '-')}@example.com>`,
        ...extra,
    },
});

const app = (appId, type) => ({
    schema: APP,
    // source carries both ref (flatpak identity) and name (snap identity) so the
    // same fixture satisfies Application's per-type refine for either subtype.
    data: { appId, name: appId, type, source: { ref: appId, name: appId } },
});

// Rev B (2026-08-05): the schema id is hierarchical and EVERY segment below
// `data/schema/` is ticked — registered child ids (message/email) and derived
// subtype segments (application/flatpak) alike. The parent key is always a
// roll-up. This is ID-PATH expansion, not the class-chain expansion v3 killed:
// each ticked segment is written into the id (or its declared subtypeField),
// never inherited from how the classes happen to extend each other.
describe('schema hierarchy ticking', () => {
    let rootPath;
    let db;

    const hasBitmap = async (key, id) => {
        const bitmap = await db.bitmapIndex.getBitmap(key, false);
        return !!bitmap && bitmap.has(id);
    };

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-schema-hierarchy-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('a registered two-segment id ticks its parent segment too', async () => {
        const id = await db.put(email('hello'));

        expect(await hasBitmap(EMAIL, id)).toBe(true);
        expect(await hasBitmap(MESSAGE, id)).toBe(true);
    });

    test('delete unticks parent and child together', async () => {
        const id = await db.put(email('gone soon'));
        await db.delete(id);

        expect(await hasBitmap(EMAIL, id)).toBe(false);
        expect(await hasBitmap(MESSAGE, id)).toBe(false);
    });

    test('a declared subtype ticks a derived child segment', async () => {
        const id = await db.put(app('org.gimp.GIMP', 'flatpak'));

        expect(await hasBitmap(APP, id)).toBe(true);
        expect(await hasBitmap(`${APP}/flatpak`, id)).toBe(true);
    });

    test('changing the subtype field moves the derived segment', async () => {
        const id = await db.put(app('org.gimp.GIMP', 'flatpak'));
        await db.put({ id, ...app('org.gimp.GIMP', 'snap') });

        expect(await hasBitmap(`${APP}/flatpak`, id)).toBe(false);
        expect(await hasBitmap(`${APP}/snap`, id)).toBe(true);
        expect(await hasBitmap(APP, id)).toBe(true);
    });

    test('a single-segment id ticks exactly itself — no parent, no phantom subtype', async () => {
        const id = await db.put({ schema: NOTE, data: { title: 'n', content: 'c' } });

        expect(await hasBitmap(NOTE, id)).toBe(true);
        // The only data/schema/* keys carrying this doc are the note id itself.
        const schemaKeys = await db.bitmapIndex.listBitmaps('data/schema');
        const carrying = [];
        for (const key of schemaKeys) {
            if (await hasBitmap(key, id)) { carrying.push(key); }
        }
        expect(carrying).toEqual([NOTE]);
    });

    test('the retired data/abstraction namespace is refused in features[]', async () => {
        const id = await db.put({
            schema: NOTE,
            data: { title: 'sneaky', content: 'c' },
            features: ['data/abstraction/note', 'tag/keepme'],
        });

        expect((await db.get(id)).features).toEqual(['tag/keepme']);
        expect(await db.bitmapIndex.listBitmaps('data/abstraction')).toEqual([]);
    });

    test('asserted data/schema keys are stripped — the derivation owns the axis', async () => {
        const id = await db.put({
            schema: NOTE,
            data: { title: 'sneaky2', content: 'c' },
            features: ['data/schema/tab', 'tag/mine'],
        });

        expect((await db.get(id)).features).toEqual(['tag/mine']);
        expect(await hasBitmap('data/schema/tab', id)).toBe(false);
    });
});

describe('email mailbox flags (feature/email/*)', () => {
    let rootPath;
    let db;

    const hasBitmap = async (key, id) => {
        const bitmap = await db.bitmapIndex.getBitmap(key, false);
        return !!bitmap && bitmap.has(id);
    };

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-email-flags-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('flags derive under feature/email/*, never under the schema id', async () => {
        const id = await db.put(email('flagged one', { isFlagged: true }));

        expect(await hasBitmap('feature/email/flagged', id)).toBe(true);
        expect(await hasBitmap('feature/email/received', id)).toBe(true);
        // Nothing below the email id: a key like data/schema/message/email/flagged
        // would read as a SUBTYPE of email in the hierarchy.
        expect(await db.bitmapIndex.listBitmaps(EMAIL)).toEqual([]);
    });

    test('a flag change unticks the stale flag key', async () => {
        const id = await db.put(email('mutable', { isFlagged: true }));
        await db.put({ id, ...email('mutable', { isFlagged: false }) });

        expect(await hasBitmap('feature/email/flagged', id)).toBe(false);
        expect(await hasBitmap('feature/email/received', id)).toBe(true);
    });

    test('rebuildL3 reproduces the flags from rows alone', async () => {
        const id = await db.put(email('rebuildable', { isFlagged: true }));

        await db.rebuildL3();

        expect(await hasBitmap('feature/email/flagged', id)).toBe(true);
        expect(await hasBitmap('feature/email/received', id)).toBe(true);
        expect(await hasBitmap(EMAIL, id)).toBe(true);
        expect(await hasBitmap(MESSAGE, id)).toBe(true);
    });
});
