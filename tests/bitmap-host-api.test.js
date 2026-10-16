import { test, expect } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import SynapsD from '../src/index.js';

test('host bitmap API returns detached data and protects lifecycle-managed indexes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-host-bitmaps-'));
    const db = new SynapsD({ path: root, backupOnOpen: false, semantic: { enabled: false } });
    try {
        await db.start();
        await db.bitmapIndex.createBitmap('tag/test', [100001, 100003]);
        const snapshot = await db.getBitmap('tag/test', { includeData: true });
        expect(snapshot).toEqual({ key: 'tag/test', size: 2, isEmpty: false, min: 100001, max: 100003, ids: [100001, 100003] });
        snapshot.ids.pop();
        expect((await db.getBitmap('tag/test', { includeData: true })).ids).toHaveLength(2);
        expect(await db.listBitmaps('tag')).toHaveLength(1);
        const raw = await db.getBitmapRawBuffer('tag/test');
        expect(Buffer.isBuffer(raw)).toBe(true);
        raw.fill(0);
        expect((await db.getBitmapRawBuffer('tag/test')).equals(raw)).toBe(false);
        for (const key of ['data', '/data/dataset/test/', 'internal', '/internal/gc/deleted/', 'DATA/mime/image', 'INTERNAL\\gc\\deleted']) {
            await expect(db.deleteBitmap(key)).rejects.toThrow(/protected/);
        }
        expect(await db.deleteBitmap('tag/test')).toBe(true);
        expect(await db.deleteBitmap('tag/test')).toBe(false);
        expect(await db.getBitmap('tag/test')).toBeNull();
    } finally { await db.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
});

test('context member IDs intersect shared layers; directory membership excludes descendants and canvases', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-members-'));
    const db = new SynapsD({ path: root, backupOnOpen: false, semantic: { enabled: false } });
    try {
        await db.start();
        const context = db.getDefaultContextTree();
        const note = content => ({ schema: 'data/schema/note', data: { content } });
        const a = await db.put(note('A'), { context: { tree: context.id, path: '/a/shared' } });
        const b = await db.put(note('B'), { context: { tree: context.id, path: '/b/shared' } });
        expect(await context.memberIds('/a/shared')).toEqual([a]);
        expect(await context.memberIds('/b/shared')).toEqual([b]);
        await context.insertPath('/a/shared/View', { leafType: 'canvas' });
        expect(await context.memberIds('/a/shared/View')).toEqual([]);
        expect((await context.memberIds('/')).sort()).toEqual([a, b].sort());
        await expect(context.memberIds('/missing/shared')).rejects.toThrow();
        const metadata = await db.createTree('Folders', 'directory');
        const directory = db.getTree(metadata.id);
        await directory.put(a, '/parent');
        await directory.put(b, '/parent/child');
        expect(await directory.memberIds('/parent')).toEqual([a]);
        expect(await directory.memberIds('/parent/child')).toEqual([b]);
        expect(await directory.memberIds('/missing')).toEqual([]);
        await directory.insertPath('/parent/View', { leafType: 'canvas' });
        expect(await directory.memberIds('/parent/View')).toEqual([]);
    } finally { await db.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
});
