import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Db from '../src/index.js';

const note = title => ({ schema: 'data/schema/note', data: { title, content: title }, metadata: { contentType: 'text/plain' } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('maintenance coordination', () => {
    let root;
    let db;
    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-maintenance-'));
        db = new Db({ path: root, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });
    afterEach(async () => {
        await db.shutdown();
        await fs.rm(root, { recursive: true, force: true });
    });

    test.each(['reindexCrudTimelines', 'reindexMimeBitmaps', 'reindexSearchIndex'])('%s rejects invalid batches before dropping state', async method => {
        const id = await db.put(note('unchanged'));
        for (const batchSize of [0, -1, 0.5, NaN, Infinity]) {
            await expect(db[method]({ batchSize, rebuild: true })).rejects.toThrow('batchSize must be a positive integer');
        }
        expect((await db.list({ features: ['data/mime/text/plain'], idsOnly: true }))[0]).toBe(id);
    });

    test('a write submitted during a rebuild runs after it and keeps its derived indexes', async () => {
        await db.put(note('before'));
        const entered = deferred();
        const release = deferred();
        const realDelete = db.bitmapIndex.deleteBitmap.bind(db.bitmapIndex);
        let first = true;
        db.bitmapIndex.deleteBitmap = async (...args) => {
            if (first) { first = false; entered.resolve(); await release.promise; }
            return realDelete(...args);
        };
        const rebuilding = db.rebuildL3({ timelines: true });
        await entered.promise;
        let finished = false;
        const putting = db.put(note('during')).then(id => { finished = true; return id; });
        try {
            await new Promise(resolve => setImmediate(resolve));
            expect(finished).toBe(false);
        } finally { release.resolve(); }
        await rebuilding;
        const id = await putting;
        expect((await db.list({ features: ['data/mime/text/plain'], idsOnly: true }))).toContain(id);
    });

    test('failed maintenance releases the queue and can be rerun', async () => {
        const id = await db.put(note('before failure'));
        await expect(db.rebuildL3({ onProgress: () => { throw new Error('progress failure'); } })).rejects.toThrow('progress failure');
        await db.put(note('after failure'));
        await db.rebuildL3();
        expect((await db.list({ features: ['data/mime/text/plain'], idsOnly: true }))).toContain(id);
        expect(db.documents.getCount()).toBe(2);
    });

    test('startup and rebuild load device facets outside the default dataset', async () => {
        await db.put({ schema: 'data/schema/device', data: { deviceId: 'archived-device', name: 'Archived device', type: 'laptop', os: { platform: 'linux' } } }, { features: ['data/dataset/archive'] });
        const id = await db.put({ ...note('on device'), locations: [{ url: 'file://archived-device/document' }] });
        const keys = await db.bitmapIndex.listBitmaps('device/type');
        expect(keys.length).toBeGreaterThan(0);
        await db.restart();
        await db.rebuildL3();
        expect((await db.list({ features: ['device/type/laptop'], idsOnly: true }))).toContain(id);
    });
    test('MIME repair and search backfill process bounded batches and report progress', async () => {
        const ids = await db.putMany([note('one'), note('two')], { skipLance: true });
        const progress = [];
        const mime = await db.reindexMimeBitmaps({ batchSize: 1, onProgress: value => progress.push(value.scanned) });
        expect(mime.scanned).toBe(2);
        expect(progress).toEqual([1, 2]);
        expect((await db.list({ features: ['data/mime/text/plain'], idsOnly: true }))).toEqual(expect.arrayContaining(ids));
        const search = await db.reindexSearchIndex({ batchSize: 1, rebuild: true });
        expect(search.totalDocs).toBe(2);
        expect(search.alreadyIndexed).toBe(2);
    });

});
