import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Db from '../src/index.js';
import LanceIndex from '../src/indexes/lance/index.js';

const note = title => ({ schema: 'data/schema/note', data: { title, content: title } });

describe('write adapters and external cleanup boundaries', () => {
    let root;
    let db;
    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-write-adapters-'));
        db = new Db({ path: root, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });
    afterEach(async () => {
        await db.shutdown();
        await fs.rm(root, { recursive: true, force: true });
    });

    test.each(['single', 'batch'])('%s canonical paths and feature adapters preserve membership intent', async mode => {
        const spec = { paths: ['ctx:/a/b', 'dir:/files'], attributes: { allOf: ['tag/first'] } };
        const ids = mode === 'single' ? [await db.put(note('paths'), spec)] : await db.putMany([note('paths')], spec);
        const id = ids[0];
        expect(await db.has(id, { context: { path: '/a/b' } })).toBe(true);
        expect((await db.getDefaultDirectoryTree().find('/files')).has(id)).toBe(true);
        await db.link(mode === 'single' ? id : ids, { paths: ['ctx:/other'], features: 'tag/second' });
        expect((await db.list({ features: ['tag/second'], idsOnly: true }))).toContain(id);
        await db.unlink(mode === 'single' ? id : ids, { paths: ['ctx:/a/b', 'dir:/files'], features: { allOf: ['tag/first'] }, recursive: true });
        expect((await db.getDefaultDirectoryTree().find('/files'))?.has(id) ?? false).toBe(false);
        expect(await db.list({ features: ['tag/first'] })).toHaveLength(0);
        expect(await db.has(id, { context: { path: '/other' } })).toBe(true);
    });

    test('batch deletion reports invalid and missing IDs without dropping valid rows from the result', async () => {
        const id = await db.put(note('delete'));
        const result = await db.deleteMany(['invalid', 99999999, id], { emitEvent: false });
        expect(result.successful).toEqual([{ index: 2, id }]);
        expect(result.failed.map(item => item.index)).toEqual([0, 1]);
        expect(result.count).toBe(3);
        expect(await db.delete(99999999)).toBe(false);
        expect((await db.deleteMany([])).count).toBe(0);
        await expect(db.deleteMany(null)).rejects.toThrow('array');
    });

    test.each(['single', 'batch'])('%s external cleanup failure never recycles a deleted ID', async mode => {
        const id = await db.put(note('cleanup'));
        const method = mode === 'single' ? 'delete' : 'deleteMany';
        const original = LanceIndex.prototype[method];
        LanceIndex.prototype[method] = async () => { throw new Error('external cleanup failure'); };
        try {
            if (mode === 'single') { expect(await db.delete(id)).toBe(true); }
            else { expect((await db.deleteMany([id])).successful).toEqual([{ index: 0, id }]); }
        } finally { LanceIndex.prototype[method] = original; }
        expect(db.documents.get(id)).toBeUndefined();
        expect(db.allDocumentsBitmap.has(id)).toBe(false);
        expect(db.deletedDocumentsBitmap.has(id)).toBe(false);
        expect(await db.put(note('next'))).toBeGreaterThan(id);
    });

    test('deferred batch search indexing only queues new or content-changed documents', async () => {
        const buffer = [];
        const [id] = await db.putMany([note('deferred')], { skipLance: true, deferredLanceBuffer: buffer });
        expect(buffer.map(doc => doc.id)).toEqual([id]);
        const repeated = [];
        expect(await db.putMany([note('deferred')], { skipLance: true, deferredLanceBuffer: repeated })).toEqual([id]);
        expect(repeated).toEqual([]);
        await db.indexDocumentsInLance(buffer);
        const changed = [];
        await db.putMany([{ id, comment: 'new annotation' }], { skipLance: true, deferredLanceBuffer: changed });
        expect(changed.map(doc => doc.id)).toEqual([id]);
    });

    test('directory batch skips stored checksums and retains deferred search payloads', async () => {
        const tree = db.getDefaultDirectoryTree().id;
        const buffer = [];
        const items = [{ document: note('directory'), path: '/path' }];
        const ids = await db.putManyDirectoryPaths(items, tree, [], { skipLance: true, deferredLanceBuffer: buffer, emitEvent: false });
        expect(buffer.map(doc => doc.id)).toEqual(ids);
        expect(await db.putManyDirectoryPaths(items, tree)).toEqual([]);
        expect(await db.putManyDirectoryPaths([], tree)).toEqual([]);
    });
});
