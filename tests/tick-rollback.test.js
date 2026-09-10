import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/schema/note';
const note = (title) => ({ schema: NOTE_SCHEMA, data: { title, content: title } });

// Semantic disabled: this suite exercises the bitmap/synapse transaction path
// only, so we skip the ~130MB embedding-model download and the native Lance
// teardown entirely — keeps the rollback assertions fast and deterministic.
async function open(rootPath) {
    const db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
    await db.start();
    return db;
}

describe('SynapsD bitmap tick rollback safety', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-rollback-'));
        db = await open(rootPath);
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('an aborted transaction leaves no phantom bitmap tick (cache or disk)', async () => {
        // Inject a failure on the 2nd document.put of a batch. Doc 1 passes through
        // #indexDocument (membership buffered) before doc 2 aborts the transaction.
        // Pre-fix, doc 1's tick mutated the shared bitmap cache + putSync and was
        // never rolled back, leaving 'tag/phantom' permanently holding a doc that
        // was never committed.
        const realPut = db.documents.put.bind(db.documents);
        let calls = 0;
        db.documents.put = async (id, val) => {
            calls++;
            if (calls === 2) { throw new Error('injected failure on 2nd doc'); }
            return realPut(id, val);
        };

        await expect(db.putMany(
            [note('rollback-A'), note('rollback-B')],
            { context: { path: '/Rollback/Zone' }, features: ['tag/phantom'] },
        )).rejects.toThrow();

        db.documents.put = realPut;

        // No doc committed → no tick may survive, in the live cache or a query.
        const phantom = await db.bitmapIndex.getBitmap('tag/phantom', false);
        expect(phantom?.isEmpty ?? true).toBe(true);
        expect(await db.list({ features: { allOf: ['tag/phantom'] } })).toHaveLength(0);

        // Restart proves nothing leaked to disk either.
        await db.shutdown();
        db = await open(rootPath);
        const phantomDisk = await db.bitmapIndex.getBitmap('tag/phantom', false);
        expect(phantomDisk?.isEmpty ?? true).toBe(true);
    });

    test('a committed write ticks bitmaps and survives restart', async () => {
        const id = await db.put(note('alpha'), { context: { path: '/Projects/Alpha' }, features: ['tag/red'] });
        await db.link(id, { features: ['tag/linked'] });
        await db.unlink(id, { context: null, features: ['tag/red'] });

        const keys = await db.synapses.listSynapses(id);
        expect(keys).toContain('tag/linked');
        expect(keys).not.toContain('tag/red');
        for (const key of keys) {
            const bmp = await db.bitmapIndex.getBitmap(key, false);
            expect(bmp?.has(id)).toBe(true);
        }
        const red = await db.bitmapIndex.getBitmap('tag/red', false);
        expect(red?.has(id) ?? false).toBe(false);

        await db.shutdown();
        db = await open(rootPath);
        expect((await db.list({ features: { allOf: ['tag/linked'] } })).map((d) => d.id)).toEqual([id]);
        expect(await db.list({ features: { allOf: ['tag/red'] } })).toHaveLength(0);
    });

    test('aborted batch restores rows, indexes, cached trees, and emits no committed changes', async () => {
        const target = await db.put(note('target'));
        const context = db.getDefaultContextTree();
        const directory = db.getDefaultDirectoryTree();
        const contextBefore = context.paths;
        const directoryBefore = directory.paths;
        const beforeBitmaps = new Map();
        for (const key of await db.bitmapIndex.listBitmaps('', { includeInternal: true })) {
            beforeBitmaps.set(key, [...await db.bitmapIndex.getBitmap(key)]);
        }
        const events = [];
        db.on('document.**', function () { events.push(this.event); });
        db.on('membership.changed', () => events.push('membership.changed'));
        context.on('**', function () { events.push(`context:${this.event}`); });
        directory.on('**', function () { events.push(`directory:${this.event}`); });
        const realPut = db.documents.put.bind(db.documents);
        const attempted = [];
        db.documents.put = async (id, doc) => {
            attempted.push({ id, checksum: doc.getPrimaryChecksum() });
            if (attempted.length === 2) { throw new Error('abort batch'); }
            return realPut(id, doc);
        };
        try {
            await expect(db.putMany([
                { ...note('first'), data: { ...note('first').data, relations: [{ p: 'references', to: target }] },
                    metadata: { geo: { lat: 48.15, lon: 17.11 } },
                    timelines: [{ timeline: 'history', start: '2020-01-01' }] },
                note('second'),
            ], { context: { path: '/Abort/New' }, directory: { path: '/abort/new' }, features: ['tag/abort'] }))
                .rejects.toThrow('abort batch');
        } finally { db.documents.put = realPut; }

        const assertRestored = async () => {
            expect([...db.documents.keys()]).toEqual([target]);
            expect([...db.allDocumentsBitmap]).toEqual([target]);
            for (const { id, checksum } of attempted) {
                expect(db.documents.get(id)).toBeUndefined();
                expect(await db.checksumIndex.get(checksum)).toBeUndefined();
                expect(await db.synapses.listSynapses(id)).toEqual([]);
                expect([...db.edges.outgoing(id, 'references')]).toEqual([]);
                expect(await db.geo.has(id)).toBe(false);
            }
            const current = new Map();
            for (const key of await db.bitmapIndex.listBitmaps('', { includeInternal: true })) {
                current.set(key, [...await db.bitmapIndex.getBitmap(key)]);
            }
            expect(current).toEqual(beforeBitmaps);
            expect(db.getDefaultContextTree().paths).toEqual(contextBefore);
            expect(db.getDefaultDirectoryTree().paths).toEqual(directoryBefore);
        };
        await assertRestored();
        expect(context.paths).toEqual(contextBefore);
        expect(directory.paths).toEqual(directoryBefore);
        expect(events).toEqual([]);
        await db.shutdown();
        db = await open(rootPath);
        await assertRestored();
    });

    test('a failed update restores the previously cached row and bitmap contents', async () => {
        const id = await db.put({ ...note('original'), features: ['tag/original'] });
        const original = (await db.get(id)).getPrimaryChecksum();
        const bitmap = await db.bitmapIndex.getBitmap('tag/original');
        const insert = db.timeline.insert.bind(db.timeline);
        db.timeline.insert = async (...args) => {
            await insert(...args);
            throw new Error('abort update');
        };
        try {
            await expect(db.put({ id, ...note('changed'), features: ['tag/changed'] })).rejects.toThrow('abort update');
        } finally { db.timeline.insert = insert; }
        expect((await db.get(id)).data.content).toBe('original');
        expect(await db.checksumIndex.get(original)).toBe(id);
        expect([...bitmap]).toEqual([id]);
        await db.shutdown();
        db = await open(rootPath);
        expect((await db.get(id)).data.content).toBe('original');
    });

    test('overlapping membership writes do not share an aborted transaction buffer', async () => {
        const id = await db.put(note('concurrent'));
        let entered;
        const inside = new Promise(resolve => { entered = resolve; });
        let resume;
        const paused = new Promise(resolve => { resume = resolve; });
        const create = db.synapses.createSynapses.bind(db.synapses);
        db.synapses.createSynapses = async (docId, keys, options) => {
            const result = await create(docId, keys, options);
            if (keys.includes('tag/abort')) {
                entered();
                await paused;
                throw new Error('abort concurrent link');
            }
            return result;
        };
        const failed = db.link(id, { context: null, features: ['tag/abort'] });
        const rejection = expect(failed).rejects.toThrow('abort concurrent link');
        await inside;
        const committed = db.link(id, { context: null, features: ['tag/committed'] });
        resume();
        try { await Promise.all([rejection, committed]); }
        finally { db.synapses.createSynapses = create; }
        expect(await db.synapses.listSynapses(id)).toContain('tag/committed');
        expect(await db.synapses.listSynapses(id)).not.toContain('tag/abort');
        expect([...(await db.bitmapIndex.getBitmap('tag/committed'))]).toEqual([id]);
        expect((await db.bitmapIndex.getBitmap('tag/abort'))?.has(id) ?? false).toBe(false);
    });

    test('an overlapping insert keeps its ID allocation after another write aborts', async () => {
        let entered;
        const inside = new Promise(resolve => { entered = resolve; });
        let resume;
        const paused = new Promise(resolve => { resume = resolve; });
        const put = db.documents.put.bind(db.documents);
        db.documents.put = async (id, doc) => {
            const result = await put(id, doc);
            if (doc.data.title === 'aborted') {
                entered();
                await paused;
                throw new Error('abort insert');
            }
            return result;
        };
        const failed = expect(db.put(note('aborted'))).rejects.toThrow('abort insert');
        await inside;
        const pending = db.put(note('survivor'));
        // Let the overlapping write reach preparation/ID allocation.
        await new Promise(resolve => setImmediate(resolve));
        resume();
        let survivor;
        try { [, survivor] = await Promise.all([failed, pending]); }
        finally { db.documents.put = put; }
        const next = await db.put(note('next'));
        expect(next).not.toBe(survivor);
        expect((await db.get(survivor)).data.title).toBe('survivor');
        await db.shutdown();
        db = await open(rootPath);
        expect((await db.get(survivor)).data.title).toBe('survivor');
    });

    test('a failed deletion restores incoming relation rows without publishing their edits', async () => {
        const target = await db.put(note('delete target'));
        const source = await db.put({ ...note('source'), data: {
            ...note('source').data, relations: [{ p: 'references', to: target }],
        } });
        const events = [];
        db.on('document.**', function () { events.push(this.event); });
        const remove = db.edges.deleteNode.bind(db.edges);
        db.edges.deleteNode = id => { remove(id); throw new Error('abort delete'); };
        try { await expect(db.delete(target)).rejects.toThrow('abort delete'); }
        finally { db.edges.deleteNode = remove; }
        const assertRestored = async () => {
            expect((await db.get(source)).data.relations).toEqual([{ p: 'references', to: target }]);
            expect((await db.get(target)).data.title).toBe('delete target');
            expect([...db.edges.outgoing(source, 'references')]).toEqual([target]);
            expect(db.allDocumentsBitmap.has(target)).toBe(true);
        };
        await assertRestored();
        expect(events).toEqual([]);
        await db.shutdown();
        db = await open(rootPath);
        await assertRestored();
    });
});
