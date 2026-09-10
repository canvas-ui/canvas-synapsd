import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
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
