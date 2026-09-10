import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Db from '../src/index.js';

describe('tree registry facade contracts', () => {
    let rootPath;
    let db;
    const open = async () => {
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    };
    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-tree-registry-'));
        await open();
    });
    afterEach(async () => {
        if (db) { await db.shutdown(); }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); }
    });

    test.each(['context', 'directory'])('%s rename preserves cached identity, query keys, and forwarded events', async type => {
        const meta = await db.createTree('Archive', type, { settings: { linkContextRoot: false } });
        const tree = db.getTree(meta.id);
        const id = await db.put({ schema: 'data/schema/note', data: { title: 'Archived', content: type } }, {
            [type]: { tree: meta.id, path: '/Inbox' },
        });
        const before = await db.resolveCandidates({ [type]: { tree: 'Archive', path: '/Inbox' } });
        await db.renameTree(meta.id, 'Renamed Archive');
        expect(db.getTree('Archive')).toBeNull();
        expect(db.getTree('  RENAMED   ARCHIVE  ')).toBe(tree);
        expect(tree.name).toBe('Renamed Archive');
        const spec = { [type]: { tree: 'Renamed Archive', path: '/Inbox' } };
        const after = await db.resolveCandidates(spec);
        expect(after.collectionKeys).toEqual(before.collectionKeys);
        expect(after.bitmap.toArray()).toEqual([id]);
        expect((await db.list({ ...spec, idsOnly: true })).slice()).toEqual([id]);

        const events = [];
        db.on('tree.document.inserted', event => events.push(event));
        db.emitTreeDocumentEvent('tree.document.inserted', { ...spec, documentIds: [id] });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ treeId: meta.id, treeName: 'Renamed Archive', treeType: type, documentIds: [id] });

        await db.shutdown();
        await open();
        expect(db.getTree('Renamed Archive').id).toBe(meta.id);
        expect((await db.list({ ...spec, idsOnly: true })).slice()).toEqual([id]);
        expect(db.getTreePaths(meta.id)).toContain('/Inbox');
    });

    test('deleting a default tree removes its storage and selects the remaining tree across reopen', async () => {
        const oldDefault = db.getDefaultContextTree();
        const alternate = await db.createTree('Alternate', 'context');
        const cachedAlternate = db.getTree(alternate.id);
        await oldDefault.insertPath('/Temporary');
        const prefix = `tree/${oldDefault.id}/`;
        expect(await db.deleteTree(oldDefault.id)).toBe(true);
        expect(db.getTree(oldDefault.id)).toBeNull();
        expect(db.getDefaultContextTree()).toBe(cachedAlternate);
        expect([...db.internalStore.keys()].some(key => key.startsWith(prefix))).toBe(false);
        expect(await db.bitmapIndex.listBitmaps(`context/${oldDefault.id}`)).toEqual([]);
        await db.shutdown();
        await open();
        expect(db.getDefaultContextTree().id).toBe(alternate.id);
        expect(db.getTree(oldDefault.id)).toBeNull();
    });
});
