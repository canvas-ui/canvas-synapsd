import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE = 'data/schema/note';

function note(title) {
    return { schema: NOTE, data: { title, content: title } };
}

/**
 * The write-through contract for asserted relations: `data.relations` on the
 * subject row is the source of truth, the edge plane is derived from it, and
 * the ONLY writer of asserted edges is the row sync. assertRelation() /
 * retractRelation() are the API-facing mutators; relate()/unrelate() are
 * derived-only (provenance required) so the L3 rebuild invariant — replay rows
 * + re-run extractors == complete edge plane — holds by construction.
 */
describe('asserted relations write-through', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-assert-rel-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('assertRelation writes the row AND derives the edge', async () => {
        const from = await db.put(note('subject'));
        const to = await db.put(note('target'));

        expect(await db.assertRelation(from, 'references', to)).toBe(true);

        expect((await db.get(from)).data.relations).toEqual([{ p: 'references', to }]);
        expect([...db.edges.outgoing(from, 'references')]).toEqual([to]);
        expect(db.edges.edge(from, 'references', to).meta).toEqual({ src: 'doc' });
    });

    test('assertRelation is a no-op when the relation is already declared', async () => {
        const from = await db.put(note('subject'));
        const to = await db.put(note('target'));

        await db.assertRelation(from, 'references', to);
        expect(await db.assertRelation(from, 'references', to)).toBe(false);
        expect((await db.get(from)).data.relations).toHaveLength(1);
    });

    test('retractRelation removes the row entry and the edge', async () => {
        const from = await db.put(note('subject'));
        const to = await db.put(note('target'));
        await db.assertRelation(from, 'references', to);

        expect(await db.retractRelation(from, 'references', to)).toBe(true);

        expect((await db.get(from)).data.relations).toBeUndefined();
        expect([...db.edges.outgoing(from, 'references')]).toEqual([]);
        // absent relation (or absent doc) is a false, not a throw
        expect(await db.retractRelation(from, 'references', to)).toBe(false);
        expect(await db.retractRelation(999999, 'references', to)).toBe(false);
    });

    test('retractRelation leaves a same-pair DERIVED claim standing', async () => {
        const from = await db.put(note('subject'));
        const to = await db.put(note('target'));
        await db.assertRelation(from, 'mentions', to);
        // An extractor independently claims the same triple — its meta row now
        // classifies the edge as derived, so the row retraction must not drop it.
        await db.relate(from, 'mentions', to, { meta: { src: 'extractor:ner' } });

        await db.retractRelation(from, 'mentions', to);

        expect((await db.get(from)).data.relations).toBeUndefined();
        expect([...db.edges.outgoing(from, 'mentions')]).toEqual([to]);
        expect(db.edges.edge(from, 'mentions', to).meta.src).toBe('extractor:ner');
    });

    test('THE invariant: a cleared edge plane rebuilds asserted relations from rows', async () => {
        const from = await db.put(note('subject'));
        const to = await db.put(note('target'));
        await db.assertRelation(from, 'authored-by', to);

        db.edges.clear();
        expect([...db.edges.outgoing(from, 'authored-by')]).toEqual([]);

        await db.rebuildL3();

        expect([...db.edges.outgoing(from, 'authored-by')]).toEqual([to]);
        expect(db.edges.edge(from, 'authored-by', to).meta).toEqual({ src: 'doc' });
    });

    test('relate() without provenance is refused, unrelate() refuses asserted edges', async () => {
        const from = await db.put(note('subject'));
        const to = await db.put(note('target'));

        await expect(db.relate(from, 'references', to)).rejects.toThrow(/assertRelation/);

        await db.assertRelation(from, 'references', to);
        await expect(db.unrelate(from, 'references', to)).rejects.toThrow(/retractRelation/);
    });

    test('backfillAssertedRelations folds edge-plane-only asserted edges into rows', async () => {
        const from = await db.put(note('subject'));
        const to = await db.put(note('target'));
        // Simulate the pre-write-through REST path: a bare edge-plane link the
        // subject row knows nothing about.
        db.edges.link(from, 'references', to);
        expect((await db.get(from)).data.relations).toBeUndefined();
        // Plus one whose source document does not exist (counts as orphaned).
        db.edges.link(424242, 'references', to);

        const stats = await db.backfillAssertedRelations();
        expect(stats).toEqual({ scanned: 2, patched: 1, orphaned: 1 });

        expect((await db.get(from)).data.relations).toEqual([{ p: 'references', to }]);
        // Idempotent: a healed store patches nothing.
        expect((await db.backfillAssertedRelations()).patched).toBe(0);
    });

    test('the start() heal folds legacy edges in exactly once', async () => {
        const from = await db.put(note('subject'));
        const to = await db.put(note('target'));
        db.edges.link(from, 'references', to);
        // Simulate a legacy store: databases created before the heal existed
        // carry no marker (a fresh one is stamped at its first start()).
        await db.internalStore.remove('backfill/asserted-relations/v1');

        // Reopen: the run-once heal (marker-gated) runs during start().
        await db.shutdown();
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();

        expect((await db.get(from)).data.relations).toEqual([{ p: 'references', to }]);
        // Marker stamped — a later direct link is NOT healed on the next open
        // (nothing writes bare asserted edges anymore; the gate is one-time).
        const other = await db.put(note('other'));
        db.edges.link(from, 'mentions', other);
        await db.shutdown();
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
        expect((await db.get(from)).data.relations).toEqual([{ p: 'references', to }]);
    });

    test('deleting a document wipes both directions and retracts incoming asserted claims', async () => {
        const person = await db.put({
            schema: 'data/schema/identity/person',
            data: { displayName: 'P' },
        });
        const org = await db.put({
            schema: 'data/schema/identity/organization',
            data: { displayName: 'O' },
        });
        const noteId = await db.put({
            schema: NOTE,
            data: { title: 'hi', content: 'hi', relations: [{ p: 'mentions', to: person }] },
        });
        await db.assertRelation(person, 'member-of', org);
        await db.relate(noteId, 'depicts', person, { meta: { src: 'extractor:faces' } });

        await db.delete(person);

        expect([...db.edges.outgoing(person, 'member-of')]).toEqual([]);
        expect([...db.edges.incoming(person, 'mentions')]).toEqual([]);
        expect([...db.edges.incoming(person, 'depicts')]).toEqual([]);
        expect([...db.edges.outgoing(noteId, 'mentions')]).toEqual([]);
        expect([...db.edges.incoming(org, 'member-of')]).toEqual([]);
        expect((await db.get(noteId)).data.relations).toBeUndefined();

        await db.rebuildL3({ bitmaps: false, edges: true });
        expect([...db.edges.outgoing(noteId, 'mentions')]).toEqual([]);
        expect([...db.edges.outgoing(noteId, 'depicts')]).toEqual([]);
    });
});
