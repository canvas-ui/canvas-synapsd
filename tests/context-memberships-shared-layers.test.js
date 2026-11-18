'use strict';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const note = (title) => ({ schema: 'data/schema/note', data: { title, content: title } });

// One layer can sit under several paths (`2026` under /photos and /travel).
// A document's memberships are the paths whose layers it holds all of, never a
// path that merely shares one layer with it.
describe('context tree memberships with shared layers', () => {
    let rootPath;
    let db;
    let tree;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-memberships-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
        await db.createTree('projects', 'context', { isDefault: false });
        tree = db.getTree('projects');
        // Shared layers first, under paths the document is not filed in.
        for (const treePath of ['/house/photos', '/travel/2026', '/photos/2019/11', '/photos/2026/11']) {
            await tree.insertPath(treePath);
        }
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    const at = (treePath) => ({ context: { tree: tree.id, path: treePath } });

    test('lists the path a document is filed under and its ancestors only', async () => {
        const id = await db.put(note('photo'), at('/photos/2026/11'));

        expect(await db.listDocumentTreeMemberships(id, tree.id)).toEqual(['/', '/photos', '/photos/2026', '/photos/2026/11']);
        for (const other of ['/travel/2026', '/photos/2019/11', '/house/photos']) {
            expect((await db.list({ ...at(other), idsOnly: true })).map(Number)).not.toContain(Number(id));
        }
    });

    test('a second placement adds its own paths', async () => {
        const id = await db.put(note('photo'), at('/photos/2026/11'));
        await db.link(id, { ...at('/travel/2026'), features: [] });

        expect(await db.listDocumentTreeMemberships(id, tree.id)).toEqual([
            '/', '/photos', '/photos/2026', '/photos/2026/11', '/travel', '/travel/2026',
        ]);
    });

    test('copying membership by layer id ticks the same layers and nothing else', async () => {
        const source = await db.put(note('photo'), at('/photos/2026/11'));
        const copy = await db.put(note('copy'), at('/'));

        const layers = await db.listDocumentContextLayers(source, tree.id);
        expect(layers.map((id) => tree.getLayerById(id).name).sort()).toEqual(['11', '2026', 'photos']);

        const linked = [];
        db.on('document.linked', (event) => linked.push(event.changed.context));
        await db.linkContextLayers(copy, tree.id, [...layers, '01UNKNOWNLAYER0000000000000']);

        expect(await db.listDocumentTreeMemberships(copy, tree.id)).toEqual(await db.listDocumentTreeMemberships(source, tree.id));
        expect((await db.listDocumentContextLayers(copy, tree.id)).sort()).toEqual([...layers].sort());
        expect(linked).toEqual([['/photos/2026/11']]);
    });

    test('removing membership by layer id leaves the document at the root only', async () => {
        const id = await db.put(note('photo'), at('/photos/2026/11'));
        await db.link(id, { ...at('/travel/2026'), features: [] });
        const layers = await db.listDocumentContextLayers(id, tree.id);

        const unlinked = [];
        db.on('document.unlinked', (event) => unlinked.push(event.changed.context));
        expect((await db.unlinkContextLayers(id, tree.id, layers)).sort()).toEqual([...layers].sort());

        expect(await db.listDocumentContextLayers(id, tree.id)).toEqual([]);
        expect(await db.listDocumentTreeMemberships(id, tree.id)).toEqual(['/']);
        expect(unlinked).toEqual([['/photos/2026/11', '/travel/2026']]);

        await db.linkContextLayers(id, tree.id, layers);
        expect((await db.list({ ...at('/travel/2026'), idsOnly: true })).map(Number)).toContain(Number(id));
    });

    test('listing layers is refused on a directory tree', async () => {
        const id = await db.put(note('photo'), at('/photos/2026/11'));
        await db.createTree('files', 'directory', { isDefault: false });
        await expect(db.listDocumentContextLayers(id, 'files')).rejects.toThrow(/not a context tree/);
    });
});
