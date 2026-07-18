'use strict';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/abstraction/note';

function note(title, content = title) {
    return { schema: NOTE_SCHEMA, data: { title, content } };
}

function ids(results) {
    return results.map((doc) => doc.id).sort((a, b) => a - b);
}

describe('datasets: virtual default, selection algebra, lifecycle', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-dataset-test-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('selection algebra: default only / anyOf ADDS / allOf restricts / noneOf removes', async () => {
        const plainId = await db.put(note('my math notes'), { context: { path: '/edu/math' } });
        const wikiId = await db.put(note('wikipedia calculus article'), {
            context: { path: '/edu/math' },
            features: ['data/dataset/wikipedia'],
        });
        const syslogId = await db.put(note('kernel: oom'), {
            context: { path: '/edu/math' },
            features: ['data/dataset/syslog'],
        });

        // Default: only the virtual 'default' dataset is selected.
        expect(ids(await db.list({ context: { path: '/edu/math' } }))).toEqual([plainId]);
        expect(ids(await db.list({}))).toEqual([plainId]);

        // anyOf ADDS the dataset to the mix (default stays selected).
        expect(ids(await db.list({ context: { path: '/edu/math' }, features: { anyOf: ['data/dataset/wikipedia'] } })))
            .toEqual([plainId, wikiId]);
        // Ticking both mixes both in.
        expect(ids(await db.list({ context: { path: '/edu/math' }, features: { anyOf: ['data/dataset/wikipedia', 'data/dataset/syslog'] } })))
            .toEqual([plainId, wikiId, syslogId]);

        // allOf restricts to the dataset (canvas "show only this dataset" case).
        expect(ids(await db.list({ context: { path: '/edu/math' }, features: { allOf: ['data/dataset/wikipedia'] } })))
            .toEqual([wikiId]);

        // noneOf removes a previously added dataset from the selection.
        expect(ids(await db.list({
            context: { path: '/edu/math' },
            features: { anyOf: ['data/dataset/wikipedia', 'data/dataset/syslog'], noneOf: ['data/dataset/syslog'] },
        }))).toEqual([plainId, wikiId]);

        // Deselecting default shows only the picked datasets.
        expect(ids(await db.list({
            context: { path: '/edu/math' },
            features: { anyOf: ['data/dataset/wikipedia'], noneOf: ['data/dataset/default'] },
        }))).toEqual([wikiId]);
    });

    test('dataset anyOf does not bypass other feature filters', async () => {
        const redId = await db.put(note('red note'), { context: { path: '/x' }, features: ['tag/red'] });
        await db.put(note('wiki no tag'), { context: { path: '/x' }, features: ['data/dataset/wikipedia'] });
        const redWikiId = await db.put(note('red wiki'), {
            context: { path: '/x' },
            features: ['tag/red', 'data/dataset/wikipedia'],
        });

        // tag/red must still gate everything: the untagged wiki doc stays out.
        expect(ids(await db.list({
            context: { path: '/x' },
            features: { allOf: ['tag/red'], anyOf: ['data/dataset/wikipedia'] },
        }))).toEqual([redId, redWikiId]);
    });

    test('multi-stamped docs count as any of their datasets', async () => {
        const bothId = await db.put(note('wiki+syslog'), {
            features: ['data/dataset/wikipedia', 'data/dataset/syslog'],
        });

        expect(ids(await db.list({}))).toEqual([]);
        // Selecting either dataset surfaces the doc.
        expect(ids(await db.list({ features: { anyOf: ['data/dataset/wikipedia'] } }))).toEqual([bothId]);
        expect(ids(await db.list({ features: { anyOf: ['data/dataset/syslog'] } }))).toEqual([bothId]);
    });

    test('deleteDataset drops documents and bitmap; re-piping starts clean', async () => {
        const a = await db.put(note('line 1'), { features: ['data/dataset/syslog'] });
        await db.put(note('line 2'), { features: ['data/dataset/syslog'] });
        const keepId = await db.put(note('keep me'), { context: { path: '/notes' } });

        expect((await db.listDatasets())[0]).toEqual(expect.objectContaining({ name: 'syslog', documentCount: 2 }));

        const result = await db.deleteDataset('syslog');
        expect(result.documentsDeleted).toBe(2);
        expect(await db.listDatasets()).toEqual([]);
        expect(await db.get(a).catch(() => null)).toBeNull();
        expect(ids(await db.list({ context: { path: '/notes' } }))).toEqual([keepId]);

        // Retry: stamping again recreates the bitmap from scratch.
        const c = await db.put(note('line 1 again'), { features: ['data/dataset/syslog'] });
        expect(ids(await db.list({ features: { anyOf: ['data/dataset/syslog'] } }))).toEqual([keepId, c].sort((x, y) => x - y));
        expect((await db.listDatasets())[0]).toEqual(expect.objectContaining({ name: 'syslog', documentCount: 1 }));
    });

    test('"default" is a reserved dataset name', async () => {
        await expect(db.put(note('sneaky'), { features: ['data/dataset/default'] }))
            .rejects.toThrow(/reserved dataset name/);
    });

    test('dataset bitmaps are protected from direct deletion', async () => {
        await db.put(note('stamped'), { features: ['data/dataset/protected'] });
        await expect(db.bitmapIndex.deleteBitmap('data/dataset/protected')).rejects.toThrow(/protected dataset bitmap/);
        await expect(db.deleteDataset('protected')).resolves.toEqual(expect.objectContaining({ documentsDeleted: 1 }));
    });
});
