import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE = 'data/abstraction/note';
const DOC = 'data/abstraction/document';

// `data.relations` is where a document DECLARES its asserted edges. Phase 4
// derives real edges from it; this phase only has to accept it — and, critically,
// keep it out of every projection that would otherwise treat it as content.
describe('data.relations acceptance', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-relations-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('a document round-trips its declared relations', async () => {
        const target = await db.put({ schema: NOTE, data: { title: 'target', content: 'target' } });
        const id = await db.put({
            schema: NOTE,
            data: { title: 'source', content: 'source', relations: [{ p: 'references', to: target }] },
        });

        const doc = await db.get(id);
        expect(doc.data.relations).toEqual([{ p: 'references', to: target }]);
    });

    // THE property for this phase. Both defaults (checksumFields / ftsSearchFields /
    // vectorEmbeddingFields) are literally ['data'], i.e. the WHOLE data object —
    // so without an explicit exclusion, asserting an edge forks identity.
    test('adding relations does not change the checksum', async () => {
        const plain = await db.put({ schema: DOC, data: { title: 'x', body: 'y' } });
        const before = (await db.get(plain)).checksumArray;

        const withRelations = await db.put({
            id: plain,
            schema: DOC,
            data: { title: 'x', body: 'y', relations: [{ p: 'mentions', to: 100999 }] },
        });

        expect(withRelations).toBe(plain);
        expect((await db.get(plain)).checksumArray).toEqual(before);
    });

    test('two documents differing ONLY in relations dedup to one', async () => {
        const first = await db.put({ schema: DOC, data: { title: 'same', body: 'same' } });
        const second = await db.put({
            schema: DOC,
            data: { title: 'same', body: 'same', relations: [{ p: 'derived-from', to: 100999 }] },
        });

        expect(second).toBe(first);
    });

    test('relations are excluded from FTS text', async () => {
        const doc = await db.get(await db.put({
            schema: DOC,
            data: { title: 'searchable', body: 'body', relations: [{ p: 'mentions', to: 100999 }] },
        }));

        // data/abstraction/document declares ftsSearchFields: ['data'] — the whole
        // object — so this asserts the real content is indexed while the graph
        // structure is not.
        const fts = JSON.stringify(doc.generateFtsData());
        expect(fts).toContain('searchable');
        expect(fts).not.toContain('mentions');
        expect(fts).not.toContain('object Object');
    });

    test('relations are excluded from embedding input', async () => {
        const doc = await db.get(await db.put({
            schema: DOC,
            data: { title: 'embeddable', body: 'body', relations: [{ p: 'mentions', to: 100999 }] },
        }));

        expect(JSON.stringify(doc.generateEmbeddingsData())).not.toContain('mentions');
    });

    test('a document with no relations projects byte-identically to before', async () => {
        const doc = await db.get(await db.put({ schema: DOC, data: { title: 'x', body: 'y' } }));
        // Same reference, not a copy: the strip must be a no-op when there is
        // nothing to strip, or every existing checksum would churn.
        expect(doc.contentData()).toBe(doc.data);
    });

    describe('rejected at ingest — a relation that cannot become an edge must not be stored', () => {
        const withRelations = (relations) => ({ schema: NOTE, data: { title: 't', content: 'c', relations } });

        test('unknown predicate', async () => {
            await expect(db.put(withRelations([{ p: 'attachment-of', to: 100999 }]))).rejects.toThrow(/Unknown predicate/);
        });

        test('inverse-style predicate — direction is an axis, not a name', async () => {
            await expect(db.put(withRelations([{ p: 'mentioned-by', to: 100999 }]))).rejects.toThrow(/Direction is an axis/);
        });

        test('non-array relations', async () => {
            await expect(db.put(withRelations({ p: 'mentions', to: 1 }))).rejects.toThrow(/must be an array/);
        });

        test('malformed entry', async () => {
            await expect(db.put(withRelations(['mentions']))).rejects.toThrow(/must be objects of shape/);
        });

        test('non-integer or non-positive target id', async () => {
            await expect(db.put(withRelations([{ p: 'mentions', to: 'abc' }]))).rejects.toThrow(/positive integer document id/);
            await expect(db.put(withRelations([{ p: 'mentions', to: 1.5 }]))).rejects.toThrow(/positive integer document id/);
            await expect(db.put(withRelations([{ p: 'mentions', to: 0 }]))).rejects.toThrow(/positive integer document id/);
        });
    });
});
