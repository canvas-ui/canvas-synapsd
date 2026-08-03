import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE = 'data/abstraction/note';
const note = (title, relations) => ({
    schema: NOTE,
    data: { title, content: title, ...(relations ? { relations } : {}) },
});

// Phase 4: `data.relations` on the row becomes real dupsort adjacency. The row is
// the declaration, the edge index is the derived structure — rows + extractors
// reproduce it, which is the rebuild invariant this whole rev exists for.
describe('asserted edge derivation from data.relations', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-reld-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('insert derives an edge, in both directions', async () => {
        const target = await db.put(note('target'));
        const source = await db.put(note('source', [{ p: 'references', to: target }]));

        expect(db.edges.exists(source, 'references', target)).toBe(true);
        expect([...db.edges.outgoing(source, 'references')]).toEqual([target]);
        expect([...db.edges.incoming(target, 'references')]).toEqual([source]);
    });

    test('an asserted edge carries no meta row — absence IS the convention', async () => {
        const target = await db.put(note('target'));
        const source = await db.put(note('source', [{ p: 'mentions', to: target }]));

        expect(db.edges.edge(source, 'mentions', target).meta).toEqual({ src: 'doc' });
    });

    test('update adds only the delta and removes what the row dropped', async () => {
        const a = await db.put(note('a'));
        const b = await db.put(note('b'));
        const id = await db.put(note('src', [{ p: 'references', to: a }]));

        await db.put({
            id,
            schema: NOTE,
            data: { title: 'src', content: 'src', relations: [{ p: 'references', to: b }] },
        });

        // The NEGATIVE half matters: asserted edges are OWNED by the row, so a
        // dropped entry must drop the edge.
        expect(db.edges.exists(id, 'references', a)).toBe(false);
        expect(db.edges.exists(id, 'references', b)).toBe(true);
    });

    test('an update that keeps a relation does not churn it', async () => {
        const a = await db.put(note('a'));
        const id = await db.put(note('src', [{ p: 'references', to: a }]));

        await db.put({
            id,
            schema: NOTE,
            data: { title: 'src edited', content: 'edited', relations: [{ p: 'references', to: a }] },
        });

        expect(db.edges.exists(id, 'references', a)).toBe(true);
    });

    test('dropping relations entirely removes the edges', async () => {
        const a = await db.put(note('a'));
        const id = await db.put(note('src', [{ p: 'references', to: a }]));

        await db.put({ id, schema: NOTE, data: { title: 'src', content: 'src' } });

        expect(db.edges.exists(id, 'references', a)).toBe(false);
    });

    // Provenance is what keeps the two planes from fighting: the row owns its
    // asserted edges, an extractor owns its derived ones.
    test('a DERIVED edge between the same pair survives an asserted removal', async () => {
        const a = await db.put(note('a'));
        const id = await db.put(note('src', [{ p: 'mentions', to: a }]));

        // An extractor asserts the same pair under a different predicate, with
        // provenance. Removing the row's relation must not touch it.
        db.edges.link(id, 'derived-from', a, { src: 'extractor:test' });

        await db.put({ id, schema: NOTE, data: { title: 'src', content: 'src', relations: [] } });

        expect(db.edges.exists(id, 'mentions', a)).toBe(false);
        expect(db.edges.exists(id, 'derived-from', a)).toBe(true);
        expect(db.edges.edge(id, 'derived-from', a).meta.src).toBe('extractor:test');
    });

    test('a derived edge on the SAME predicate is not removed by the row', async () => {
        const a = await db.put(note('a'));
        const id = await db.put(note('src'));

        db.edges.link(id, 'mentions', a, { src: 'extractor:ner' });

        // The row never asserted this pair, so a write that declares no relations
        // must leave the extractor's edge alone.
        await db.put({ id, schema: NOTE, data: { title: 'src', content: 'edited', relations: [] } });

        expect(db.edges.exists(id, 'mentions', a)).toBe(true);
    });

    test('deleting a document removes every edge mentioning it', async () => {
        const a = await db.put(note('a'));
        const id = await db.put(note('src', [{ p: 'references', to: a }]));

        await db.delete(id);

        expect(db.edges.exists(id, 'references', a)).toBe(false);
        expect([...db.edges.incoming(a, 'references')]).toEqual([]);
    });

    test('putMany derives edges for every document in one transaction', async () => {
        const target = await db.put(note('target'));
        const ids = await db.putMany([
            note('one', [{ p: 'references', to: target }]),
            note('two', [{ p: 'references', to: target }]),
        ]);
        const [a, b] = Array.isArray(ids) ? ids : ids.data;

        expect([...db.edges.incoming(target, 'references')].sort()).toEqual([a, b].sort());
    });

    test('the batch path diffs on update too — the prev-snapshot ordering case', async () => {
        const a = await db.put(note('a'));
        const b = await db.put(note('b'));
        const id = await db.put(note('src', [{ p: 'references', to: a }]));

        // In putMany, existing.update(doc) mutates in place and returns the SAME
        // instance; a prevRelations snapshot taken after it would equal the new
        // value, the diff would be empty, and the stale edge would never be
        // removed — while every positive assertion still passed.
        await db.putMany([{
            id,
            schema: NOTE,
            data: { title: 'src', content: 'src', relations: [{ p: 'references', to: b }] },
        }]);

        expect(db.edges.exists(id, 'references', a)).toBe(false);
        expect(db.edges.exists(id, 'references', b)).toBe(true);
    });

    test('a relation to a nonexistent document is allowed', async () => {
        // Forbidding it would make ingest ORDER significant; dangling targets are
        // filtered at query time by candidate-set intersection anyway.
        const id = await db.put(note('src', [{ p: 'references', to: 999999 }]));
        expect(db.edges.exists(id, 'references', 999999)).toBe(true);
    });

    test('several predicates between the same pair coexist', async () => {
        const a = await db.put(note('a'));
        const id = await db.put(note('src', [
            { p: 'references', to: a },
            { p: 'mentions', to: a },
        ]));

        expect(db.edges.edgesOf(id).outgoing).toEqual(
            expect.arrayContaining([{ p: 'references', to: a }, { p: 'mentions', to: a }]),
        );
    });
});
