import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Db from '../src/index.js';
import SearchWriteQueue from '../src/write/SearchWriteQueue.js';

const checksum = n => `sha256/${String(n).padStart(64, '0')}`;
const location = name => ({ url: `stored://test/${name}.txt` });
const file = (n, locations) => ({ schema: 'data/schema/file', data: {}, checksumArray: [checksum(n)], locations });
const open = async rootPath => {
    const db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
    await db.start();
    return db;
};

describe('Atomic document succession', () => {
    let rootPath, db, from, reference, source, options;
    const spec = { context: null, directory: { tree: 'backends', path: '/new' } };
    const successor = () => ({ ...file(2, [location('edited')]),
        metadata: { geo: { lat: 48.15, lon: 17.11 } },
        timelines: [{ timeline: 'history', start: '2020-01-01' }],
    });

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-successor-'));
        db = await open(rootPath);
        await db.createTree('backends', 'directory', { settings: { linkContextRoot: false } });
        from = await db.put(file(1, [location('edited'), location('untouched')]), {
            context: { path: '/Working/Drafts' }, directory: { path: '/curated' }, features: ['tag/draft'],
        });
        await db.link(from, { context: null, directory: { tree: 'backends', path: ['/old', '/untouched'] } });
        reference = await db.put(file(3, [location('reference')]));
        await db.assertRelation(from, 'references', reference);
        await db.assertRelation(reference, 'references', from);
        await db.relate(from, 'mentions', reference, { meta: { src: 'extractor:test' } });
        source = await db.getDocument(from);
        options = {
            excludeTrees: ['backends'],
            predecessor: {
                version: source.version,
                changes: { locations: [location('untouched')] },
                unlink: [{ context: null, directory: { tree: 'backends', path: '/old' } }],
            },
        };
        await db.flushSearchIndex();
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        if (db) {await db.shutdown();}
        if (rootPath) {await fs.rm(rootPath, { recursive: true, force: true });}
    });

    async function snapshot() {
        const bitmaps = new Map();
        for (const key of await db.bitmapIndex.listBitmaps('', { includeInternal: true })) {
            bitmaps.set(key, [...await db.bitmapIndex.getBitmap(key)]);
        }
        const docs = new Map();
        for (const id of [...db.documents.keys()]) {docs.set(id, db.documents.get(id));}
        const memberships = new Map();
        for (const id of docs.keys()) {memberships.set(id, await db.synapses.listSynapses(id));}
        return { docs, bitmaps, memberships, counter: db.internalStore.get('internal/document-id-counter'),
            sourceEdges: db.edges.edgesOf(from), referenceEdges: db.edges.edgesOf(reference),
            backendPaths: db.getTree('backends').paths,
        };
    }

    test('commits rows, both edge directions, memberships and checksums together, surviving restart', async () => {
        const transaction = jest.spyOn(db.db, 'transaction');
        const to = await db.putSuccessor(from, successor(), spec, options);
        expect(transaction).toHaveBeenCalledTimes(1);
        const assertCommitted = async () => {
            expect(to).not.toBe(from);
            expect((await db.getByChecksumString(checksum(1))).id).toBe(from);
            expect((await db.getByChecksumString(checksum(2))).id).toBe(to);
            expect((await db.getDocument(from)).locations).toEqual([location('untouched')]);
            expect((await db.getDocument(from)).version).toBeGreaterThan(source.version);
            for (const id of [from, to]) {
                expect((await db.list({ context: { path: '/Working/Drafts' } })).map(doc => doc.id)).toContain(id);
                expect(await db.listDocumentTreePaths(id, db.getDefaultDirectoryTree().id)).toContain('/curated');
                expect(await db.synapses.listSynapses(id)).toContain('tag/draft');
                for (const key of await db.synapses.listSynapses(id)) {expect((await db.bitmapIndex.getBitmap(key)).has(id)).toBe(true);}
            }
            expect(await db.listDocumentTreePaths(to, 'backends')).toEqual(['/new']);
            expect(await db.listDocumentTreePaths(from, 'backends')).toEqual(['/untouched']);
            expect([...db.edges.outgoing(to, 'derived-from')]).toEqual([from]);
            expect([...db.edges.incoming(from, 'derived-from')]).toEqual([to]);
            expect([...db.edges.outgoing(to, 'references')]).toEqual([reference]);
            expect([...db.edges.outgoing(reference, 'references')]).toEqual([from, to]);
            expect((await db.getDocument(reference)).data.relations).toEqual(expect.arrayContaining([{ p: 'references', to }]));
            expect([...db.edges.outgoing(to, 'mentions')]).toEqual([]);
        };
        await assertCommitted();
        await db.shutdown();
        db = await open(rootPath);
        await assertCommitted();
    });

    test.each(['relation', 'predecessor', 'bitmap', 'untick'])(
        'a failure during %s writes restores every index and emits/queues nothing', async stage => {
            const before = await snapshot();
            const cached = new Map(db.bitmapIndex.cache);
            const events = [];
            db.on('document.**', function () { events.push(this.event); });
            db.on('membership.changed', () => events.push('membership.changed'));
            for (const tree of [db.getDefaultContextTree(), db.getTree('backends')]) {
                tree.on('**', function () { events.push(this.event); });
            }
            const search = jest.spyOn(SearchWriteQueue.prototype, 'upsertText');
            const method = stage === 'relation' ? [db.edges, 'link']
                : stage === 'predecessor' ? [db.documents, 'put']
                    : [db.bitmapIndex, stage === 'untick' ? 'untickMany' : 'tickMany'];
            const original = method[0][method[1]].bind(method[0]);
            const inject = jest.spyOn(...method).mockImplementation((...args) => {
                const fail = stage === 'relation' ? args[1] === 'derived-from'
                    : stage === 'predecessor' ? args[0] === from
                        : stage === 'untick' ? args[1] === from && args[0].some(key => key.startsWith('vfs/')) : args[0].includes('tag/draft');
                const result = original(...args);
                if (stage === 'relation') {
                    if (fail) {throw new Error('injected succession failure');}
                    return result;
                }
                return Promise.resolve(result).then(value => {
                    if (fail) {throw new Error('injected succession failure');}
                    return value;
                });
            });
            await expect(db.putSuccessor(from, successor(), spec, options)).rejects.toThrow('injected succession failure');
            inject.mockRestore();
            expect(await snapshot()).toEqual(before);
            for (const [key, bitmap] of cached) {expect([...bitmap]).toEqual(before.bitmaps.get(key));}
            expect(await db.getByChecksumString(checksum(2))).toBeNull();
            expect(await db.geo.has(before.counter + 1)).toBe(false);
            expect(events).toEqual([]);
            expect(search).not.toHaveBeenCalled();
            await db.shutdown();
            db = await open(rootPath);
            expect(await snapshot()).toEqual(before);
            // Retry allocates the rolled-back ID and applies inheritance once.
            const to = await db.putSuccessor(from, successor(), spec, options);
            expect(to).toBe(before.counter + 1);
            expect([...db.edges.outgoing(to, 'derived-from')]).toEqual([from]);
        },
    );

    test('a stale predecessor fails without creating a successor or losing the newer edit', async () => {
        await db.put({ id: from, comment: 'new annotation' });
        const before = await snapshot();
        await expect(db.putSuccessor(from, successor(), spec, options)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
        expect(await snapshot()).toEqual(before);
    });

    test('an existing successor retains its curation while stale mirror paths are removed atomically', async () => {
        const to = await db.put(successor(), {
            context: { path: '/Existing' }, directory: { tree: 'backends', path: '/old-target' },
        });
        const target = await db.getDocument(to);
        const result = await db.putSuccessor(from, { id: to, metadata: { derivedFrom: checksum(1) } }, spec, {
            ...options, successorVersion: target.version,
            successorUnlinks: [{ context: null, directory: { tree: 'backends', path: '/old-target' } }],
        });
        expect(result).toBe(to);
        expect((await db.getDocument(to)).version).toBeGreaterThan(target.version);
        expect((await db.list({ context: { path: '/Existing' } })).map(doc => doc.id)).toContain(to);
        expect((await db.list({ context: { path: '/Working/Drafts' } })).map(doc => doc.id)).toContain(to);
        expect(await db.listDocumentTreePaths(to, 'backends')).toEqual(['/new']);
        const before = await snapshot();
        await expect(db.putSuccessor(from, { id: to, comment: 'stale' }, spec, {
            ...options, predecessor: {}, successorVersion: target.version,
        })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
        expect(await snapshot()).toEqual(before);
    });

    test.each(['id', 'checksum'])('refuses a successor that resolves to the predecessor by %s', async mode => {
        const before = await snapshot();
        const record = mode === 'id' ? { id: from, comment: 'must roll back' } : file(1, [location('replacement')]);
        await expect(db.putSuccessor(from, record, spec, options)).rejects.toThrow('different document ID');
        expect(await snapshot()).toEqual(before);
    });
});
