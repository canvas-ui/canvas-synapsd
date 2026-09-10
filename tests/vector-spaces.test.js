import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Db from '../src/index.js';

const vector = [1, 0, 0, 0];
const schema = 'data/schema/note';
const spaces = model => ({ text: {
    model, dim: 4, annIndex: false,
    bitmapKey: `internal/embed/vectors/text/${model}`,
    seenKey: `internal/embed/seen/text/${model}`,
} });

describe('vector space facade contracts', () => {
    let rootPath;
    let db;
    const open = async model => {
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false,
            semantic: { spaces: spaces(model), embedQuery: async () => vector } });
        await db.start();
    };
    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-vector-spaces-'));
        await open('model-a');
    });
    afterEach(async () => {
        if (db) { await db.shutdown(); }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); }
    });

    test('model swaps update search and stats while preserving each model ledger and table', async () => {
        const id = await db.put({ schema, data: { title: 'Alpha', content: 'alpha' } });
        await db.storeDocumentEmbeddings(id, schema, new Date().toISOString(), [{ chunkId: 0, text: 'alpha', vector }]);
        const search = () => db.search({ query: 'alpha', mode: 'vector', idsOnly: true });
        expect((await search()).slice()).toEqual([id]);
        expect(await db.getUnembeddedDocIds('text', [schema])).toEqual([]);

        expect(await db.setVectorSpaces(spaces('model-b'))).toMatchObject({ applied: true, textReady: true });
        expect((await search()).slice()).toEqual([]);
        expect(await db.getUnembeddedDocIds('text', [schema])).toEqual([id]);
        const stats = await db.getStats();
        expect(stats.semantic.vector.model).toBe('model-b');
        expect(stats.semantic.vector.embeddedDocs).toBe(0);
        const tables = (await db.listVectorTables()).tables;
        expect(tables).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'vec_text__model-a__4', active: false }),
            expect.objectContaining({ name: 'vec_text__model-b__4', active: true }),
        ]));
        expect(await db.dropVectorTable('vec_text__model-b__4')).toMatchObject({ dropped: false });

        await db.setVectorSpaces(spaces('model-a'));
        expect((await search()).slice()).toEqual([id]);
        expect(await db.getUnembeddedDocIds('text', [schema])).toEqual([]);
        expect(await db.getDocumentVector(id, 'text')).toEqual(vector);
        expect(await db.dropVectorTable('vec_text__model-b__4')).toMatchObject({ dropped: true });
        expect((await db.listVectorTables()).tables.map(table => table.name)).not.toContain('vec_text__model-b__4');

        await db.shutdown();
        await open('model-a');
        expect((await search()).slice()).toEqual([id]);
        expect(await db.getUnembeddedDocIds('text', [schema])).toEqual([]);
    });
    test('restart retains live model selection, tuning, and stored embeddings', async () => {
        const id = await db.put({ schema, data: { title: 'Restart', content: 'restart' } });
        await db.setVectorSpaces(spaces('model-b'));
        db.setSearchTuning({ imageMaxDistance: 0.8, searchWeights: { dense: 3 } });
        await db.storeDocumentEmbeddings(id, schema, new Date().toISOString(), [{ chunkId: 0, text: 'restart', vector }]);
        await db.restart();
        const stats = await db.getStats();
        expect(stats.semantic.vector.model).toBe('model-b');
        expect(await db.getDocumentVector(id, 'text')).toEqual(vector);
        expect(await db.getUnembeddedDocIds('text')).not.toContain(id);
        expect(await db.search({ query: 'restart', mode: 'vector', idsOnly: true })).toContain(id);
    });

});
