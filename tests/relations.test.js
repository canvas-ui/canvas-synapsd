import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/abstraction/note';

function note(title) {
    return { schema: NOTE_SCHEMA, data: { title, content: title } };
}

/**
 * Ported 1:1 from the rel/* bitmap era to EdgeIndex semantics. The behaviours
 * asserted here are the ones the old Relations index guaranteed; the storage
 * underneath changed, the contract did not.
 */
describe('SynapsD relations (dupsort edge plane)', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-rel-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('relate / traverse forward + reverse', async () => {
        const email = await db.put(note('email'));
        const a = await db.put(note('attachment-a'));
        const b = await db.put(note('attachment-b'));

        await db.relate(email, 'includes', a);
        await db.relate(email, 'includes', b);

        expect([...db.edges.outgoing(email, 'includes')].sort()).toEqual([a, b].sort());
        // reverse: which docs include `a` — direction is an axis, not a predicate name
        expect([...db.edges.incoming(a, 'includes')]).toEqual([email]);
        expect([...db.edges.incoming(b, 'includes')]).toEqual([email]);
    });

    test('N:N — a shared part belongs to two anchors', async () => {
        const e1 = await db.put(note('email-1'));
        const e2 = await db.put(note('email-2'));
        const pdf = await db.put(note('shared.pdf'));

        await db.relate(e1, 'includes', pdf);
        await db.relate(e2, 'includes', pdf);

        expect([...db.edges.incoming(pdf, 'includes')].sort()).toEqual([e1, e2].sort());
    });

    test('unrelate removes both directions', async () => {
        const x = await db.put(note('x'));
        const y = await db.put(note('y'));
        await db.relate(x, 'references', y);
        await db.unrelate(x, 'references', y);

        expect([...db.edges.outgoing(x, 'references')]).toEqual([]);
        expect([...db.edges.incoming(y, 'references')]).toEqual([]);
    });

    test('deleting a part removes it from the anchor adjacency', async () => {
        const email = await db.put(note('email'));
        const a = await db.put(note('a'));
        const b = await db.put(note('b'));
        await db.relate(email, 'includes', a);
        await db.relate(email, 'includes', b);

        await db.delete(a);

        expect([...db.edges.outgoing(email, 'includes')]).toEqual([b]);
    });

    test('inheritMemberships copies the anchor\'s layer memberships to the part', async () => {
        const tab = await db.put(note('tab'), { features: ['tag/research'] });
        const offline = await db.put(note('offline.html'));

        const beforeLayers = await db.synapses.listSynapses(offline);
        await db.relate(tab, 'includes', offline, { inheritMemberships: true });
        const afterLayers = await db.synapses.listSynapses(offline);

        const tabLayers = await db.synapses.listSynapses(tab);
        // offline now carries every layer the tab belonged to
        for (const layer of tabLayers) { expect(afterLayers).toContain(layer); }
        expect(afterLayers.length).toBeGreaterThan(beforeLayers.length);
    });

    test('unknown predicate is rejected', async () => {
        const x = await db.put(note('x'));
        const y = await db.put(note('y'));
        await expect(db.relate(x, 'attachment-of', y)).rejects.toThrow(/Unknown predicate/);
    });

    test('the rel/ bitmap namespace is gone — stragglers throw', async () => {
        await expect(db.bitmapIndex.tick('rel/includes/1', 2))
            .rejects.toThrow(/does not follow naming convention/);
    });
});
