import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/schema/note';
const note = (title, extra = {}) => ({ schema: NOTE_SCHEMA, data: { title, content: title }, ...extra });

// `version` is the DB-owned monotonic row version: 1 on insert, +1 on every
// row write. It is the precondition/"is my copy current" field for replicas.
describe('Document version', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-version-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('starts at 1 and increments on every row write', async () => {
        const id = await db.put(note('v'));
        expect((await db.getDocument(id)).version).toBe(1);

        await db.put({ id, schema: NOTE_SCHEMA, data: { title: 'v', content: 'edited' } });
        expect((await db.getDocument(id)).version).toBe(2);

        // A metadata-only edit is a row write too.
        await db.put({ ...note('v'), id, data: { title: 'v', content: 'edited' }, comment: 'annotated' });
        expect((await db.getDocument(id)).version).toBe(3);
    });

    test('caller-supplied version is ignored; the DB is the authority', async () => {
        const id = await db.put(note('w', { version: 42 }));
        expect((await db.getDocument(id)).version).toBe(1);
        await db.put({ ...note('w'), id, version: 99, comment: 'x' });
        expect((await db.getDocument(id)).version).toBe(2);
    });

    test('re-putting identical content updates the same row and bumps', async () => {
        const id = await db.put(note('same'));
        const again = await db.put(note('same'));
        expect(again).toBe(id);
        expect((await db.getDocument(id)).version).toBe(2);
    });

    test('asserted relations bump the subject', async () => {
        const a = await db.put(note('a'));
        const b = await db.put(note('b'));
        await db.assertRelation(a, 'references', b);
        expect((await db.getDocument(a)).version).toBe(2);
        expect((await db.getDocument(b)).version).toBe(1);
    });

    test('survives a restart', async () => {
        const id = await db.put(note('persist'));
        await db.put({ ...note('persist'), id, comment: 'c' });
        await db.shutdown();
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
        expect((await db.getDocument(id)).version).toBe(2);
    });
});

describe('Document version — batch operations', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-version-batch-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    const versions = async (ids) => Promise.all(ids.map(async (id) => (await db.getDocument(id)).version));

    test('putMany: new rows start at 1, a second putMany of the same content bumps every row', async () => {
        const ids = await db.putMany([note('b1'), note('b2'), note('b3')]);
        expect(await versions(ids)).toEqual([1, 1, 1]);

        const again = await db.putMany([note('b1'), note('b2'), note('b3')]);
        expect(again).toEqual(ids);
        expect(await versions(ids)).toEqual([2, 2, 2]);
    });

    test('putMany: explicit id updates bump, and mixed new/existing rows get the right counters', async () => {
        const [a] = await db.putMany([note('m1')]);
        await db.put({ ...note('m1'), id: a, comment: 'first edit' });          // → 2

        const ids = await db.putMany([
            { ...note('m1'), id: a, comment: 'batch edit' },                     // update → 3
            note('m2'),                                                          // new → 1
        ]);
        expect(ids[0]).toBe(a);
        expect(await versions(ids)).toEqual([3, 1]);
    });

    test('putMany: two updates to the same id in one batch chain, never collide', async () => {
        const [a] = await db.putMany([note('chain')]);
        await db.putMany([
            { ...note('chain'), id: a, comment: 'one' },
            { ...note('chain'), id: a, comment: 'two' },
        ]);
        const doc = await db.getDocument(a);
        expect(doc.version).toBe(3);
        expect(doc.comment).toBe('two');
    });

    test('putMany: identical documents in one batch fold into one row at version 1', async () => {
        const ids = await db.putMany([note('dup'), note('dup'), note('dup')]);
        expect(new Set(ids).size).toBe(1);
        expect((await db.getDocument(ids[0])).version).toBe(1);
    });

    test('putMany ignores caller-supplied versions', async () => {
        const ids = await db.putMany([note('c1', { version: 7 }), note('c2', { version: 9 })]);
        expect(await versions(ids)).toEqual([1, 1]);
        await db.putMany([{ ...note('c1'), id: ids[0], version: 50, comment: 'x' }]);
        expect((await db.getDocument(ids[0])).version).toBe(2);
    });

    test('putManyDirectoryPaths: new rows at 1, existing rows are skipped and keep their counter', async () => {
        const [existing] = await db.putMany([note('dir-existing')]);
        await db.put({ ...note('dir-existing'), id: existing, comment: 'edited' });   // → 2

        const ids = await db.putManyDirectoryPaths([
            { document: note('dir-new'), path: '/a' },
            { document: note('dir-new'), path: '/b' },            // in-batch fold
            { document: note('dir-existing'), path: '/c' },       // skipExisting
        ], db.getDefaultDirectoryTree().id);
        const fresh = ids.filter((id) => id !== existing);
        expect(new Set(fresh).size).toBe(1);
        expect((await db.getDocument(fresh[0])).version).toBe(1);
        expect((await db.getDocument(existing)).version).toBe(2);
    });

    test('version keeps climbing across batch and single writes and survives a restart', async () => {
        const [a] = await db.putMany([note('mix')]);
        await db.put({ ...note('mix'), id: a, comment: '1' });
        await db.putMany([{ ...note('mix'), id: a, comment: '2' }]);
        await db.assertRelation(a, 'references', (await db.putMany([note('other')]))[0]);
        expect((await db.getDocument(a)).version).toBe(4);

        await db.shutdown();
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
        expect((await db.getDocument(a)).version).toBe(4);
        await db.put({ ...note('mix'), id: a, comment: '3' });
        expect((await db.getDocument(a)).version).toBe(5);
    });
});
