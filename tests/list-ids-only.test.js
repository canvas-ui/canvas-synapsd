'use strict';

import { afterEach, beforeEach, describe, expect, test, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/schema/note';

function note(title) {
    return { schema: NOTE_SCHEMA, data: { title, content: title } };
}

// `idsOnly` is the cheap revalidation read: same count/totalCount/pagination
// semantics as a normal listing, but the array holds document ids, not documents.
describe('list({ idsOnly })', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-idsonly-test-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('returns ids matching the hydrated listing, unfiltered', async () => {
        const a = await db.put(note('a'));
        const b = await db.put(note('b'));

        const docs = await db.list({});
        const idList = await db.list({ idsOnly: true });

        expect([...idList].sort((x, y) => x - y)).toEqual([a, b]);
        expect(idList.every((entry) => typeof entry === 'number')).toBe(true);
        expect(idList.count).toBe(docs.count);
        expect(idList.totalCount).toBe(docs.totalCount);
        expect(idList.error).toBeNull();
    });

    test('returns ids for a feature-scoped listing (bitmap path)', async () => {
        await db.put(note('unstamped'));
        const stamped = await db.put(note('stamped'), { features: ['data/dataset/pipe'] });

        const spec = { features: { anyOf: ['data/dataset/pipe'] } };
        const docs = await db.list(spec);
        const idList = await db.list({ ...spec, idsOnly: true });

        expect([...idList]).toEqual(docs.map((doc) => doc.id));
        expect(idList).toContain(stamped);
        expect(idList.totalCount).toBe(docs.totalCount);
    });

    test('honours limit/offset and still reports the full totalCount', async () => {
        const created = [];
        for (const title of ['one', 'two', 'three', 'four']) {
            created.push(await db.put(note(title)));
        }

        const page = await db.list({ limit: 2, offset: 1, idsOnly: true });

        expect(page.count).toBe(2);
        expect(page.totalCount).toBe(created.length);
        // Same slice the hydrated read would have produced.
        const hydrated = await db.list({ limit: 2, offset: 1 });
        expect([...page]).toEqual(hydrated.map((doc) => doc.id));
    });

    test('deep pages decode only their page, and idsOnly never requests document values', async () => {
        const created = [];
        for (let i = 0; i < 40; i++) { created.push(await db.put(note(`page-${i}`))); }
        const range = db.documents.getRange.bind(db.documents);
        let decoded = 0;
        const spy = jest.spyOn(db.documents, 'getRange').mockImplementation(function* (options) {
            for (const entry of range(options)) { decoded++; yield entry; }
        });
        try {
            for (const order of ['asc', 'desc']) {
                const expected = (order === 'desc' ? [...created].reverse() : created).slice(30, 35);
                decoded = 0;
                const docs = await db.list({ limit: 5, offset: 30, order });
                expect(docs.map(doc => doc.id)).toEqual(expected);
                expect(docs.totalCount).toBe(40);
                expect(decoded).toBe(5);
                decoded = 0;
                const ids = await db.list({ limit: 5, offset: 30, order, idsOnly: true });
                expect([...ids]).toEqual(expected);
                expect(ids.totalCount).toBe(40);
                expect(decoded).toBe(0);
            }
            expect([...(await db.list({ limit: 0, offset: 38, idsOnly: true }))]).toEqual(created.slice(38));
            expect([...(await db.list({ limit: 5, offset: 80, idsOnly: true }))]).toEqual([]);
        } finally { spy.mockRestore(); }
    });

    test('an empty result set is an empty id array', async () => {
        const idList = await db.list({ features: { anyOf: ['data/dataset/nothing-here'] }, idsOnly: true });
        expect([...idList]).toEqual([]);
        expect(idList.count).toBe(0);
        expect(idList.totalCount).toBe(0);
    });
});
