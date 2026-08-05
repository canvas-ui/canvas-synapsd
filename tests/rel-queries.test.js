import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE = 'data/schema/note';
const note = (title, relations) => ({
    schema: NOTE,
    data: { title, content: title, ...(relations ? { relations } : {}) },
});

// Phase 5: the `rel` bucket. Adjacency composes into the SAME candidate pipeline
// as paths and features — the deterministic layer a non-deterministic memory
// engine can sit on top of, where "related to X" is set algebra rather than a
// traversal API.
describe('rel query bucket', () => {
    let rootPath;
    let db;
    const ids = (r) => (Array.isArray(r) ? r : r?.data ?? []).map((d) => d.id).sort();

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-rel-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('rel-only query returns the outgoing neighbourhood', async () => {
        const alice = await db.put(note('alice'));
        const bob = await db.put(note('bob'));
        const msg = await db.put(note('msg', [{ p: 'mentions', to: alice }]));
        await db.put(note('unrelated'));

        expect(ids(await db.list({ rel: { p: 'mentions', of: msg }, limit: 0 }))).toEqual([alice]);
        expect(ids(await db.list({ rel: { p: 'mentions', of: bob }, limit: 0 }))).toEqual([]);
    });

    test("dir:'in' is the same predicate scanned from the other side", async () => {
        const alice = await db.put(note('alice'));
        const a = await db.put(note('a', [{ p: 'mentions', to: alice }]));
        const b = await db.put(note('b', [{ p: 'mentions', to: alice }]));

        // Direction is an AXIS, not a name — there is no 'mentioned-by' predicate.
        expect(ids(await db.list({ rel: { p: 'mentions', of: alice, dir: 'in' }, limit: 0 })))
            .toEqual([a, b].sort());
    });

    test('rel composes with a feature filter', async () => {
        const alice = await db.put(note('alice'));
        const a = await db.put(note('a', [{ p: 'mentions', to: alice }]));
        await db.put(note('b', [{ p: 'mentions', to: alice }]));

        await db.put({ id: a, features: ['tag/important'] });

        expect(ids(await db.list({
            rel: { p: 'mentions', of: alice, dir: 'in' },
            features: ['tag/important'],
            limit: 0,
        }))).toEqual([a]);
    });

    test('rel composes with a context path', async () => {
        const alice = await db.put(note('alice'));
        const inWork = await db.put(note('in-work', [{ p: 'mentions', to: alice }]), {
            context: { path: '/work' },
        });
        await db.put(note('elsewhere', [{ p: 'mentions', to: alice }]), {
            context: { path: '/personal' },
        });

        expect(ids(await db.list({
            context: { path: '/work' },
            rel: { p: 'mentions', of: alice, dir: 'in' },
            limit: 0,
        }))).toEqual([inWork]);
    });

    test('noneOf subtracts a neighbourhood', async () => {
        const alice = await db.put(note('alice'));
        const a = await db.put(note('a', [{ p: 'mentions', to: alice }]));
        const b = await db.put(note('b', [{ p: 'mentions', to: alice }, { p: 'derived-from', to: alice }]));

        const result = ids(await db.list({
            rel: [
                { p: 'mentions', of: alice, dir: 'in' },
                { op: 'noneOf', p: 'derived-from', of: alice, dir: 'in' },
            ],
            limit: 0,
        }));

        expect(result).toEqual([a]);
        expect(result).not.toContain(b);
    });

    test('allOf intersects two neighbourhoods', async () => {
        const alice = await db.put(note('alice'));
        const bob = await db.put(note('bob'));
        const both = await db.put(note('both', [{ p: 'mentions', to: alice }, { p: 'mentions', to: bob }]));
        await db.put(note('only-alice', [{ p: 'mentions', to: alice }]));

        expect(ids(await db.list({
            rel: [
                { op: 'allOf', p: 'mentions', of: alice, dir: 'in' },
                { op: 'allOf', p: 'mentions', of: bob, dir: 'in' },
            ],
            limit: 0,
        }))).toEqual([both]);
    });

    test('an empty adjacency yields an empty result, not everything', async () => {
        await db.put(note('a'));
        await db.put(note('b'));
        const lonely = await db.put(note('lonely'));

        expect(ids(await db.list({ rel: { p: 'mentions', of: lonely }, limit: 0 }))).toEqual([]);
    });

    test('rel operands are reported COARSE — they have no stable bitmap key', async () => {
        const alice = await db.put(note('alice'));
        await db.put(note('a', [{ p: 'mentions', to: alice }]));

        const resolved = await db.resolveCandidates({ rel: { p: 'mentions', of: alice, dir: 'in' } });

        // A rel operand is an ephemeral bitmap built from a dupsort scan, so
        // link()/unlink() fire no membership event a QuerySession could intersect.
        // Without this flag a cached cue operand would go stale SILENTLY.
        expect(resolved.coarse).toBe(true);
        expect(resolved.keys).toContain(`rel:in:mentions:${alice}`);
    });

    test('a cached session cue re-resolves after link()/unlink()', async () => {
        const alice = await db.put(note('alice'));
        const a = await db.put(note('a', [{ p: 'mentions', to: alice }]));
        const b = await db.put(note('b'));

        const spec = { rel: { p: 'mentions', of: alice, dir: 'in' }, limit: 0 };
        expect(ids(await db.list(spec))).toEqual([a]);

        // A pure edge write — no bitmap tick anywhere.
        db.edges.link(b, 'mentions', alice, { src: 'extractor:test' });

        expect(ids(await db.list(spec))).toEqual([a, b].sort());
    });

    test('malformed rel specs are rejected rather than silently ignored', async () => {
        await expect(db.list({ rel: { p: 'mentions' } })).rejects.toThrow(/positive integer document id/);
        await expect(db.list({ rel: { of: 1 } })).rejects.toThrow(/requires a predicate/);
        await expect(db.list({ rel: { p: 'mentions', of: 1, dir: 'sideways' } })).rejects.toThrow(/'out' or 'in'/);
        await expect(db.list({ rel: { p: 'mentioned-by', of: 1 } })).rejects.toThrow(/Direction is an axis/);
    });
});

// A filter that cannot be parsed used to be DROPPED, so the query ran unfiltered
// and returned a wider set with no error — a confident wrong answer, which for a
// deterministic layer is worse than an empty one. (This is exactly what made an
// earlier events test pass against a filter that was never applied.)
describe('filters fail loudly instead of silently widening or emptying', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-filterfail-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('an unparseable timeline token throws rather than running unfiltered', async () => {
        await db.put(note('a'));
        await db.put(note('b'));

        // The '>=' form does not exist; the grammar is t:<timeline>:<start>..<end>.
        await expect(db.list({ filters: ['t:events>=2026-01-01<=2026-12-31'], limit: 0 }))
            .rejects.toThrow(/Unparseable timeline filter/);
        await expect(db.list({ filters: ['t:events'], limit: 0 }))
            .rejects.toThrow(/Unparseable timeline filter/);
    });

    test('an unparseable geo token throws', async () => {
        await expect(db.list({ filters: ['geo:bbox:1,2'], limit: 0 }))
            .rejects.toThrow(/Unparseable geo filter/);
        await expect(db.list({ filters: ['geo:nowhere:1,2'], limit: 0 }))
            .rejects.toThrow(/Unparseable geo filter/);
    });

    test('a VALID timeline filter still works, and an unknown timeline is simply empty', async () => {
        const id = await db.put({
            schema: 'data/schema/task',
            data: { title: 'due today', dueDate: new Date().toISOString() },
        });

        const due = await db.list({ filters: ['t:tasks:today'], limit: 0 });
        expect(due.map((d) => d.id)).toEqual([id]);

        // Not an error — the timeline just has nothing in it.
        const none = await db.list({ filters: ['t:nosuchtimeline:today'], limit: 0 });
        expect(none.map((d) => d.id)).toEqual([]);
    });
});
