'use strict';

import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import LanceIndex from '../src/indexes/lance/index.js';

// Two Lance behaviours this pins (both bit users as "my note isn't found"):
// - 0.22: rows not yet folded into the FTS index were MISSED when the term
//   occurred more than once (title repeated in content — most notes).
// - 0.39: `Operator.And` on an ngram MatchQuery stopped requiring every ngram,
//   so "winter" matched "summer window" through a shared "win".
// synapsd now spells the AND out per ngram; results must not depend on whether
// a row is indexed yet.
const row = (id, ...parts) => ({ id, schema: 'x', updatedAt: 'x', generateFtsData: () => parts });

const ROWS = [
    row(1, 'winter window'),
    row(2, 'snow field'),
    row(3, 'summer window'),
    row(4, 'pelican note', 'pelican note body'),
    row(5, 'JobsIreland.ie listing'),
    row(6, 'Café opening hours'),
];

const CASES = [
    ['winter', [1]],            // not "summer window"
    ['window', [1, 3]],
    ['pelican', [4]],           // repeated term
    ['ireland', [5]],           // substring of a concatenated word
    ['cafe', [6]],              // accent folding
    ['pelican winter', [1, 4]], // multi-word: any word (Should)
];

describe('FTS ngram queries', () => {
    let dir;
    afterEach(async () => { if (dir) { await fs.rm(dir, { recursive: true, force: true }); dir = null; } });

    test('same answers before and after the rows are indexed', async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-fts-ngram-'));
        const index = new LanceIndex({ rootPath: dir });
        await index.initialize();
        await index.writeBatch({ upserts: ROWS });

        const ask = async (q) => (await index.ftsQuery(q)).pageIds.sort((a, b) => a - b);
        for (const [query, expected] of CASES) {
            expect([query, 'unindexed', await ask(query)]).toEqual([query, 'unindexed', expected]);
        }
        await index.optimize();
        for (const [query, expected] of CASES) {
            expect([query, 'indexed', await ask(query)]).toEqual([query, 'indexed', expected]);
        }
    });
});

describe('a freshly saved note is findable', () => {
    let rootPath;
    let db;
    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('title repeated in content, searched before any compaction', async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-fts-note-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
        const id = await db.put({ schema: 'data/schema/note', data: { title: 'pelican migration', content: 'pelican migration routes' } });
        expect([...await db.search({ query: 'pelican', mode: 'fts', idsOnly: true })]).toContain(id);
    });
});
