'use strict';

import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import LanceIndex, { isIdentifierQuery } from '../src/indexes/lance/index.js';

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
    row(7, 'Invoice from Augmentd s.r.o. for consulting'),
    row(8, 'Augmentd Labs s.r.o. roadmap'),
    row(9, 'Café Augmentd window'),
];

const CASES = [
    ['winter', [1]],            // not "summer window"
    ['window', [1, 3, 9]],
    ['pelican', [4]],           // repeated term
    ['ireland', [5]],           // substring of a concatenated word
    ['cafe', [6, 9]],           // accent folding
    ['summer window', [3]],     // multi-word: every word (AND)…
    ['pelican winter', [1, 4]], // …widening to any word when AND finds nothing
    ['augmentd window', [9]],   // words shorter than a gram are dropped, not required
    ['augmentd s.r.o.', [7, 8, 9]],
    ['"Augmentd s.r.o."', [7]], // quoted: verbatim phrase, not "Augmentd Labs s.r.o."
    ['"augmentd s.r.o', [7]],   // unclosed quote runs to the end
    ['"winter window"', [1]],
    ['"window winter"', []],    // order matters
    ['"cafe augmentd"', [9]],   // folded on both sides
    ['"augmentd" window', [9]], // phrase + word
    ['"summer window" pelican', [3]], // phrase stays required when the words widen
];
// match: 'exact' = the whole string is one phrase, quotes or not.
const EXACT_CASES = [
    ['Augmentd s.r.o.', [7]],
    ['augmentd window', [9]],
    ['window augmentd', []],
];

describe('FTS ngram queries', () => {
    let dir;
    afterEach(async () => { if (dir) { await fs.rm(dir, { recursive: true, force: true }); dir = null; } });

    test('same answers before and after the rows are indexed', async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-fts-ngram-'));
        const index = new LanceIndex({ rootPath: dir });
        await index.initialize();
        await index.writeBatch({ upserts: ROWS });

        const ask = async (q, opts) => (await index.ftsQuery(q, [], opts)).pageIds.sort((a, b) => a - b);
        const check = async (state) => {
            for (const [query, expected] of CASES) {
                expect([query, state, await ask(query)]).toEqual([query, state, expected]);
            }
            for (const [query, expected] of EXACT_CASES) {
                expect([query, 'exact', state, await ask(query, { match: 'exact' })]).toEqual([query, 'exact', state, expected]);
            }
        };
        await check('unindexed');
        await index.optimize();
        await check('indexed');
    });

    test('phrase hits are verified against the row text and paginate in order', async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-fts-phrase-'));
        const index = new LanceIndex({ rootPath: dir });
        await index.initialize();
        await index.writeBatch({ upserts: ROWS });
        const all = await index.ftsQuery('"augmentd"', [], { limit: 10 });
        expect(all.totalCount).toBe(3);
        const page = await index.ftsQuery('"augmentd"', [], { limit: 2, offset: 1 });
        expect(page.totalCount).toBe(3);
        expect(page.pageIds).toEqual(all.pageIds.slice(1, 3));
        // Candidate scoping applies before verification.
        expect((await index.ftsQuery('"augmentd"', [8, 9])).pageIds.sort()).toEqual([8, 9]);
    });
});

// Identifier-like text ranks on the lexical index alone (QueryEngine forces
// mode 'fts'): a dense neighbour of "kontakt@vub.sk" is never a real match.
test('identifier-like queries are told apart from words', () => {
    for (const q of ['vub.sk', 'kontakt@vub.sk', 'INV-2026-0042', 'Faktura-2026-0042.pdf', '#105862', 'deadbeefdeadbeef01', 'https://vub.sk/x', 'VS 1234567890', 'faktura 0042']) {
        expect([q, isIdentifierQuery(q)]).toEqual([q, true]);
    }
    for (const q of ['invoice from vub.sk', 'summer window', 'pelican migration routes', 'Augmentd s.r.o.', 'meeting notes q3', '']) {
        expect([q, isIdentifierQuery(q)]).toEqual([q, false]);
    }
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
        expect([...await db.search({ query: '"pelican migration routes"', idsOnly: true })]).toEqual([id]);
        expect([...await db.search({ query: '"migration pelican"', idsOnly: true })]).toEqual([]);
        expect([...await db.search({ query: 'pelican migration routes', match: 'exact', idsOnly: true })]).toEqual([id]);
        // limit 0 asks for every match, not for an empty page.
        const more = await Promise.all([1, 2, 3].map((n) => db.put({ schema: 'data/schema/note', data: { title: `pelican ${n}`, content: 'pelican' } })));
        const all = await db.search({ query: 'pelican', idsOnly: true, limit: 0 });
        expect([...all].sort()).toEqual([id, ...more].sort());
        expect(all.totalCount).toBe(4);
        expect([...await db.search({ query: '"pelican"', idsOnly: true, limit: 0 })]).toHaveLength(4);
    });
});
