import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Db from '../src/index.js';

const note = title => ({ schema: 'data/schema/note', data: { title, content: title } });

describe('shared document write pipeline', () => {
    let root;
    let db;
    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-write-pipeline-'));
        db = new Db({ path: root, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });
    afterEach(async () => {
        await db.shutdown();
        await fs.rm(root, { recursive: true, force: true });
    });

    async function insert(mode, document) {
        if (mode === 'single') { return db.put(document); }
        if (mode === 'batch') { return (await db.putMany([document], { skipLance: true }))[0]; }
        const tree = db.getDefaultDirectoryTree();
        return (await db.putManyDirectoryPaths([
            { document, path: '/one' }, { document: structuredClone(document), path: '/two' },
        ], tree.id, [], { skipLance: true }))[0];
    }

    test('detailed batch results identify creations, checksum matches, updates and concurrent retries', async () => {
        const document = note('outcome');
        const [first, duplicate] = await db.putMany([document, structuredClone(document)], { returnDetails: true });
        expect(first).toEqual({ id: expect.any(Number), created: true, status: 'created' });
        expect(duplicate).toEqual({ id: first.id, created: false, status: 'existing' });
        expect(await db.putMany([document], { returnDetails: true })).toEqual([duplicate]);
        const [changed] = await db.putMany([note('changed content')], { returnDetails: true });
        expect(changed.created).toBe(true);
        expect(changed.id).not.toBe(first.id);
        expect(await db.putMany([{ ...note('explicit update'), id: first.id }], { returnDetails: true }))
            .toEqual([{ id: first.id, created: false, status: 'updated' }]);
        const concurrent = (await Promise.all([1, 2].map(() => db.putMany([note('concurrent')], { returnDetails: true })))).flat();
        expect(concurrent.map(result => result.created).sort()).toEqual([false, true]);
        expect(new Set(concurrent.map(result => result.id)).size).toBe(1);
    });

    test('link outcomes use current memberships for context and directory trees, including retries', async () => {
        const id = await db.put(note('file me'), { context: { path: '/inbox' } });
        const before = await db.get(id);
        const spec = { context: { path: '/music/live' } };
        const reads = jest.spyOn(db.synapses, 'listSynapses');
        let first;
        try {
            first = await db.linkMany([id, id, 999999], spec);
            // Each valid input needs only the merge's existing reverse-index read.
            expect(reads).toHaveBeenCalledTimes(2);
        } finally { reads.mockRestore(); }
        expect(first.successful).toEqual([
            { index: 0, id, alreadyLinked: false }, { index: 1, id, alreadyLinked: true },
        ]);
        expect(first.failed).toHaveLength(1);
        expect((await db.linkMany([id], { context: { path: '/music' } })).successful[0].alreadyLinked).toBe(true);
        expect((await db.linkMany([id], spec)).successful[0].alreadyLinked).toBe(true);
        await db.synapses.removeSynapses(id, ['data/schema/note']);
        // Repairing a derived feature is not a new destination membership.
        expect((await db.linkMany([id], spec)).successful[0].alreadyLinked).toBe(true);
        expect(await db.synapses.listSynapses(id)).toContain('data/schema/note');
        const directory = { context: null, directory: { path: '/music/live' } };
        expect((await db.linkMany([id], directory)).successful[0].alreadyLinked).toBe(false);
        expect((await db.linkMany([id], directory)).successful[0].alreadyLinked).toBe(true);
        expect((await db.linkMany([id], { context: null, directory: { path: '/music' } })).successful[0].alreadyLinked).toBe(false);
        const concurrent = await Promise.all([1, 2].map(() => db.linkMany([id], { context: { path: '/concurrent' } })));
        expect(concurrent.map(result => result.successful[0].alreadyLinked).sort()).toEqual([false, true]);
        await db.unlinkMany([id], spec);
        expect((await db.linkMany([id], spec)).successful[0].alreadyLinked).toBe(false);
        const features = { ...spec, features: ['tag/new-link-feature'] };
        expect((await db.linkMany([id], features)).successful[0].alreadyLinked).toBe(false);
        expect((await db.linkMany([id], features)).successful[0].alreadyLinked).toBe(true);
        expect(await db.get(id)).toEqual(before);
    });

    test.each(['single', 'batch', 'directory'])('%s inserts derive the same row-owned indexes and survive rebuild', async mode => {
        const target = await db.put(note('target'));
        const document = {
            ...note('source'),
            data: { title: 'source', content: 'body', relations: [{ p: 'references', to: target }] },
            comment: 'annotation',
            metadata: { contentType: 'text/plain', geo: { lat: 48.15, lon: 17.11 } },
            features: ['tag/declared'],
            timelines: [{ name: 'history', start: '2020-01-01' }],
            locations: [{ url: 's3://archive/source' }],
        };
        const id = await insert(mode, document);
        const check = async () => {
            for (const key of ['feature/has-comment', 'data/mime/text/plain', 'data/backend/s3/archive', 'tag/declared']) {
                expect((await db.list({ features: [key], idsOnly: true })).includes(id)).toBe(true);
            }
            expect(db.edges.edge(id, 'references', target)?.meta.src).toBe('doc');
            expect(await db.geo.has(id)).toBe(true);
        };
        await check();
        if (mode === 'directory') {
            const tree = db.getDefaultDirectoryTree();
            expect((await tree.find('/one')).has(id)).toBe(true);
            expect((await tree.find('/two')).has(id)).toBe(true);
        }
        await db.rebuildL3();
        await check();
    });

    test.each(['single', 'batch', 'directory'])('%s failure rolls back every prepared index and publication', async mode => {
        const target = await db.put(note('target'));
        const published = [];
        db.on('document.inserted', event => published.push(event));
        const realInsert = db.timeline.insert.bind(db.timeline);
        db.timeline.insert = async (name, ...args) => {
            if (name === 'history') { throw new Error('timeline failure'); }
            return realInsert(name, ...args);
        };
        await expect(insert(mode, {
            ...note('failed'), features: ['tag/failed'],
            data: { title: 'failed', content: 'failed', relations: [{ p: 'references', to: target }] },
            timelines: [{ name: 'history', start: '2020-01-01' }],
        })).rejects.toThrow('timeline failure');
        db.timeline.insert = realInsert;
        expect(await db.list({ idsOnly: true })).toEqual(expect.arrayContaining([target]));
        expect((await db.list({ idsOnly: true })).length).toBe(1);
        expect(await db.list({ features: ['tag/failed'] })).toHaveLength(0);
        expect(published).toEqual([]);
        expect(await db.put(note('next'))).toBeGreaterThan(target);
    });

    test('directory batches reject invalid relations before committing any rows', async () => {
        await expect(insert('directory', {
            ...note('bad relation'), data: { title: 'bad', content: 'bad', relations: [{ p: 'unknown', to: 1 }] },
        })).rejects.toThrow();
        expect(db.documents.getCount()).toBe(0);
    });
    test('an asserted-relation failure cannot leave a row claim without its edge', async () => {
        const from = await db.put(note('from'));
        const to = await db.put(note('to'));
        const realInsert = db.timeline.insert.bind(db.timeline);
        db.timeline.insert = async () => { throw new Error('relation timeline failure'); };
        await expect(db.assertRelation(from, 'references', to)).rejects.toThrow('relation timeline failure');
        db.timeline.insert = realInsert;
        expect((await db.get(from)).data.relations || []).toEqual([]);
        expect(db.edges.edge(from, 'references', to)).toBeFalsy();
        expect(await db.assertRelation(from, 'references', to)).toBe(true);
        expect(db.edges.edge(from, 'references', to)?.meta.src).toBe('doc');
    });

});
