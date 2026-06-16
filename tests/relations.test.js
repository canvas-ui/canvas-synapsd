import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/abstraction/note';

function note(title) {
    return { schema: NOTE_SCHEMA, data: { title, content: title } };
}

describe('SynapsD relations (rel/* edges)', () => {
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

    test('relate / getRelated forward + reverse', async () => {
        const email = await db.put(note('email'));
        const a = await db.put(note('attachment-a'));
        const b = await db.put(note('attachment-b'));

        await db.relations.relate(email, 'includes', a);
        await db.relations.relate(email, 'includes', b);

        expect((await db.relations.getRelated(email, 'includes')).sort()).toEqual([a, b].sort());
        // reverse: which docs include `a`
        expect(await db.relations.getRelated(a, 'includes', { reverse: true })).toEqual([email]);
        expect(await db.relations.getRelated(b, 'includes', { reverse: true })).toEqual([email]);
    });

    test('N:N — a shared part belongs to two anchors', async () => {
        const e1 = await db.put(note('email-1'));
        const e2 = await db.put(note('email-2'));
        const pdf = await db.put(note('shared.pdf'));

        await db.relations.relate(e1, 'includes', pdf);
        await db.relations.relate(e2, 'includes', pdf);

        expect((await db.relations.getRelated(pdf, 'includes', { reverse: true })).sort()).toEqual([e1, e2].sort());
    });

    test('unrelate removes both directions', async () => {
        const x = await db.put(note('x'));
        const y = await db.put(note('y'));
        await db.relations.relate(x, 'references', y);
        await db.relations.unrelate(x, 'references', y);

        expect(await db.relations.getRelated(x, 'references')).toEqual([]);
        expect(await db.relations.getRelated(y, 'references', { reverse: true })).toEqual([]);
    });

    test('deleting a part unticks it from the anchor forward bitmap', async () => {
        const email = await db.put(note('email'));
        const a = await db.put(note('a'));
        const b = await db.put(note('b'));
        await db.relations.relate(email, 'includes', a);
        await db.relations.relate(email, 'includes', b);

        await db.delete(a);

        expect(await db.relations.getRelated(email, 'includes')).toEqual([b]);
    });

    test('inheritMemberships copies the anchor\'s layer memberships to the part', async () => {
        const tab = await db.put(note('tab'), { features: ['tag/research'] });
        const offline = await db.put(note('offline.html'));

        const beforeLayers = await db.synapses.listSynapses(offline);
        await db.relations.relate(tab, 'includes', offline, { inheritMemberships: true });
        const afterLayers = await db.synapses.listSynapses(offline);

        const tabLayers = await db.synapses.listSynapses(tab);
        // offline now carries every layer the tab belonged to
        for (const layer of tabLayers) { expect(afterLayers).toContain(layer); }
        expect(afterLayers.length).toBeGreaterThan(beforeLayers.length);
    });

    test('unknown predicate is rejected', async () => {
        const x = await db.put(note('x'));
        const y = await db.put(note('y'));
        await expect(db.relations.relate(x, 'attachment-of', y)).rejects.toThrow(/Unknown relation predicate/);
    });
});
