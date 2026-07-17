'use strict';

import { describe, expect, test } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, Float64, Int32, Utf8, Float32, FixedSizeList } from 'apache-arrow';

import VectorIndex from '../src/indexes/lance/VectorIndex.js';

const tmpRoot = () => fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-vector-provenance-'));

const vec = (dim, fill = 0.5) => Array.from({ length: dim }, () => fill);

describe('vector provenance + dim guard', () => {
    test('rows are stamped with model, dim and embeddedAt', async () => {
        const rootPath = await tmpRoot();
        const vi = new VectorIndex({ rootPath, tableName: 'vec_test', dim: 8, model: 'test-model-a' });
        await vi.initialize();
        expect(vi.isReady).toBe(true);

        await vi.upsertChunks(1, 'data/abstraction/note', '2026-07-17T00:00:00Z', [
            { chunkId: 0, text: 'hello', vector: vec(8) },
        ]);
        // Per-push model override wins over the space-level default.
        await vi.upsertChunks(2, 'data/abstraction/note', '2026-07-17T00:00:00Z', [
            { chunkId: 0, text: 'world', vector: vec(8, 0.1) },
        ], { model: 'test-model-b' });

        const db = await lancedb.connect(rootPath);
        const table = await db.openTable('vec_test');
        const rows = await table.query().toArray();
        const byId = new Map(rows.map((r) => [Number(r.id), r]));

        expect(byId.get(1).model).toBe('test-model-a');
        expect(byId.get(2).model).toBe('test-model-b');
        expect(Number(byId.get(1).dim)).toBe(8);
        expect(byId.get(1).embeddedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('dim mismatch on a NON-EMPTY table refuses and preserves the vectors', async () => {
        const rootPath = await tmpRoot();
        const v8 = new VectorIndex({ rootPath, tableName: 'vec_guard', dim: 8 });
        await v8.initialize();
        await v8.upsertChunks(7, 'data/abstraction/note', '2026-07-17T00:00:00Z', [
            { chunkId: 0, text: 'precious', vector: vec(8) },
        ]);

        // Reopen the same table under a different configured dim (the qwen-VL /
        // Matryoshka scenario). Must refuse, not drop.
        const v16 = new VectorIndex({ rootPath, tableName: 'vec_guard', dim: 16 });
        await v16.initialize();
        expect(v16.isReady).toBe(false);
        const stats = await v16.stats();
        expect(stats.ready).toBe(false);
        expect(stats.error).toContain('dim mismatch');

        // Data intact: reopening at the original dim still sees the row.
        const again = new VectorIndex({ rootPath, tableName: 'vec_guard', dim: 8 });
        await again.initialize();
        expect(again.isReady).toBe(true);
        const db = await lancedb.connect(rootPath);
        const table = await db.openTable('vec_guard');
        expect(await table.countRows()).toBe(1);
    });

    test('dim mismatch on an EMPTY table recreates it at the configured dim', async () => {
        const rootPath = await tmpRoot();
        const v8 = new VectorIndex({ rootPath, tableName: 'vec_empty', dim: 8 });
        await v8.initialize();

        const v16 = new VectorIndex({ rootPath, tableName: 'vec_empty', dim: 16 });
        await v16.initialize();
        expect(v16.isReady).toBe(true);

        await v16.upsertChunks(3, 'data/abstraction/note', '2026-07-17T00:00:00Z', [
            { chunkId: 0, text: 'resized', vector: vec(16) },
        ]);
        const db = await lancedb.connect(rootPath);
        const table = await db.openTable('vec_empty');
        expect(await table.countRows()).toBe(1);
    });

    test('legacy table without provenance columns is backfilled on open', async () => {
        const rootPath = await tmpRoot();
        // Simulate a pre-provenance table: the old 6-column schema.
        const db = await lancedb.connect(rootPath);
        const legacySchema = new Schema([
            new Field('id', new Float64()),
            new Field('chunkId', new Int32()),
            new Field('schema', new Utf8()),
            new Field('updatedAt', new Utf8()),
            new Field('chunkText', new Utf8()),
            new Field('vector', new FixedSizeList(8, new Field('item', new Float32(), true))),
        ]);
        const table = await db.createEmptyTable('vec_legacy', legacySchema);
        await table.add([{
            id: 42, chunkId: 0, schema: 'data/abstraction/note',
            updatedAt: '2026-01-01T00:00:00Z', chunkText: 'old row', vector: vec(8),
        }]);

        const vi = new VectorIndex({ rootPath, tableName: 'vec_legacy', dim: 8, model: 'new-model' });
        await vi.initialize();
        expect(vi.isReady).toBe(true);

        // Old row got the backfill defaults; a new upsert carries real provenance.
        await vi.upsertChunks(43, 'data/abstraction/note', '2026-07-17T00:00:00Z', [
            { chunkId: 0, text: 'new row', vector: vec(8, 0.2) },
        ]);
        const rows = await (await db.openTable('vec_legacy')).query().toArray();
        const byId = new Map(rows.map((r) => [Number(r.id), r]));
        expect(byId.get(42).model).toBe('');
        expect(Number(byId.get(42).dim)).toBe(8);
        expect(byId.get(43).model).toBe('new-model');
        expect(byId.get(43).embeddedAt).toMatch(/^\d{4}/);

        // Search still works across mixed provenance rows.
        const res = await vi.vectorSearch(vec(8, 0.2), [], { limit: 5 });
        expect(res.error).toBeNull();
        expect(res.pageIds.length).toBeGreaterThan(0);
    });
});
