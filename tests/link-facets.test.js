import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const LINK = 'data/schema/link';

// Web applications are links with data.type = 'webapp', grouped by data.category.
// Both are optional facets: the "Games here" query is a pure bitmap intersection.
describe('link type/category facets', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-link-facets-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    const ids = async (allOf) => (await db.list({ features: { allOf }, limit: 0 })).map((d) => d.id).sort();

    test('type and category tick their facets; a plain link ticks neither', async () => {
        const game = await db.put({ schema: LINK, data: { uri: 'https://lichess.org', label: 'Lichess', type: 'webapp', category: 'Games' } });
        const tool = await db.put({ schema: LINK, data: { uri: 'https://excalidraw.com', type: 'webapp', category: 'productivity' } });
        const plain = await db.put({ schema: LINK, data: { uri: 'https://example.com/article' } });
        const blank = await db.put({ schema: LINK, data: { uri: 'https://example.com/blank', type: '', category: '  ' } });

        expect(await ids([LINK])).toEqual([game, tool, plain, blank].sort());
        expect(await ids([LINK, 'data/type/webapp'])).toEqual([game, tool].sort());
        expect(await ids(['data/type/webapp', 'data/category/games'])).toEqual([game]);
        expect((await db.listBitmaps('data/category/')).map((r) => r.key).sort())
            .toEqual(['data/category/games', 'data/category/productivity']);

        const stored = await db.get(game);
        expect(stored.data.category).toBe('Games');
    });

    test('changing or clearing the fields moves or unticks the facets', async () => {
        const id = await db.put({ schema: LINK, data: { uri: 'https://lichess.org', type: 'webapp', category: 'games' } });
        await db.put({ id, schema: LINK, data: { uri: 'https://lichess.org', type: 'webapp', category: 'learning' } });
        expect(await ids(['data/category/games'])).toEqual([]);
        expect(await ids(['data/category/learning'])).toEqual([id]);

        await db.put({ id, schema: LINK, data: { uri: 'https://lichess.org' } });
        expect(await ids(['data/type/webapp'])).toEqual([]);
        expect(await ids(['data/category/learning'])).toEqual([]);
    });

    test('a client cannot assert a facet key the fields do not back', async () => {
        const id = await db.put({ schema: LINK, data: { uri: 'https://example.com' }, features: ['data/type/webapp', 'tag/keep'] });
        expect((await db.get(id)).features).toEqual(['tag/keep']);
        expect(await ids(['data/type/webapp'])).toEqual([]);
        expect(await ids(['tag/keep'])).toEqual([id]);
    });
});
