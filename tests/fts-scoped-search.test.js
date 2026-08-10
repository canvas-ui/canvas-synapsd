import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/schema/note';
const note = (title, comment) => ({ schema: NOTE_SCHEMA, data: { title, content: title }, ...(comment !== undefined ? { comment } : {}) });

/**
 * FTS scoped to a candidate set.
 *
 * Filtering happens AFTER the BM25 search — Lance ranks the whole table and we
 * keep the survivors — so the number of rows fetched must NOT be bounded by the
 * candidate-set size. It was, and the consequence was inverted: the tighter you
 * scoped (`?ids=…`, one tree path, a camera frame's kNN survivors), the more
 * likely the search returned nothing at all, because it asked Lance for the
 * globally top-N rows and then kept only the ones that happened to be
 * candidates. A scope of one document fetched exactly one row.
 *
 * The invariant these tests pin: scoping is a FILTER on an unscoped search.
 * Whatever an unscoped query returns, scoping to a subset of it must return
 * exactly that intersection — never less.
 */
describe('FTS scoped to a candidate id set', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-fts-scope-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('every single-document scope finds its own match', async () => {
        // Several documents matching the same query — as a real corpus does.
        const ids = [];
        for (const label of ['hinge', 'frame', 'lock', 'panel']) {
            ids.push(await db.put(note(`entrance ${label}`, `broken door ${label}`)));
        }

        const unscoped = await db.search({ query: 'broken door', mode: 'fts', limit: 50 });
        const unscopedIds = [...unscoped].map((d) => d.id);
        expect(unscopedIds.length).toBe(ids.length);

        // The failure was rank-dependent: scoping to the globally top-ranked
        // document "worked" while every other single-document scope returned
        // nothing. So assert it for EACH id, not just one.
        for (const id of ids) {
            const scoped = await db.search({ query: 'broken door', mode: 'fts', ids: [id], limit: 50 });
            expect([...scoped].map((d) => d.id)).toEqual([id]);
        }
    });

    test('scoping is exactly an intersection of the unscoped result', async () => {
        const a = await db.put(note('entrance A', 'broken door hinge'));
        const b = await db.put(note('entrance B', 'broken door frame'));
        await db.put(note('gardening', 'hedge planting plan'));

        const unscopedIds = [...await db.search({ query: 'broken door', mode: 'fts', limit: 50 })].map((d) => d.id);
        expect(new Set(unscopedIds)).toEqual(new Set([a, b]));

        // A scope wider than the matches still yields only the matches...
        const wide = await db.search({ query: 'broken door', mode: 'fts', ids: [a, b], limit: 50 });
        expect(new Set([...wide].map((d) => d.id))).toEqual(new Set([a, b]));

        // ...and a scope that excludes every match yields nothing (not an error).
        const none = await db.search({ query: 'broken door', mode: 'fts', ids: [999999], limit: 50 });
        expect([...none]).toEqual([]);
    });
});
