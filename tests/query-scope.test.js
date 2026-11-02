import { test, expect } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Db from '../src/index.js';

test('mandatory query scope intersects before paging and does not impose a dataset selection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-query-scope-'));
    const db = new Db({ path: root, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
    await db.start();
    try {
        const put = (title, context, features = []) => db.put({ schema: 'data/schema/note', data: { title, content: title } },
            { context: { path: context }, features });
        const inside = await put('inside', '/work', ['tag/project']);
        const outside = await put('outside', '/private', ['tag/project', 'tag/private']);
        const dataset = await put('dataset', '/work', ['data/dataset/finance', 'tag/project']);
        const scope = { context: { path: '/work' } };
        const page = await db.list({ ids: [inside, outside], idsOnly: true, limit: 1 }, { scope });
        expect([...page]).toEqual([inside]);
        expect(page.totalCount).toBe(1);
        const selected = await db.list({ features: { allOf: ['data/dataset/finance'] }, countOnly: true }, { scope });
        expect(selected.totalCount).toBe(1);
        const empty = await db.list({ ids: [outside], countOnly: true }, { scope });
        expect(empty.totalCount).toBe(0);
        const compound = await db.searchCompound([{ ids: [inside] }, { ids: [outside] }], { scope, idsOnly: true });
        expect([...compound]).toEqual([inside]);
        const rows = await db.listBitmaps('tag/', { scope, includeData: true });
        expect(rows.map(row => row.key)).not.toContain('tag/private');
        expect(rows.find(row => row.key === 'tag/project').ids.sort((a, b) => a - b)).toEqual([inside, dataset].sort((a, b) => a - b));
        expect((await db.getBitmap('tag/project')).size).toBe(3);
    } finally {
        await db.shutdown();
        await fs.rm(root, { recursive: true, force: true });
    }
});
