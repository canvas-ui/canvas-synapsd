import { test, expect } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Db from '../src/index.js';

test('documentIdsUnderScope resolves context paths (including deeper filings) and directory subtrees', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-ids-under-scope-'));
    const db = new Db({ path: root, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
    await db.start();
    try {
        const put = (title, context) => db.put({ schema: 'data/schema/note', data: { title, content: title } },
            { context: { path: context } });
        const top = await put('top', '/photos');
        const deep = await put('deep', '/photos/2026');
        const other = await put('other', '/work');

        const sorted = (ids) => [...ids].sort((a, b) => a - b);
        expect(sorted(await db.documentIdsUnderScope('ctx://photos'))).toEqual(sorted([top, deep]));
        expect(await db.documentIdsUnderScope('ctx://photos/2026')).toEqual([deep]);
        expect(await db.documentIdsUnderScope('ctx://work')).toEqual([other]);
        expect(await db.documentIdsUnderScope('ctx://missing')).toEqual([]);
        expect(await db.documentIdsUnderScope('nosuchtree://x')).toBeNull();
        expect(Array.isArray(await db.documentIdsUnderScope('dir://'))).toBe(true);
    } finally {
        await db.shutdown();
        await fs.rm(root, { recursive: true, force: true });
    }
});
