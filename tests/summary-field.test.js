import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import Note from '../src/schemas/app/Note.js';

const NOTE_SCHEMA = 'data/schema/note';

const note = (title) => ({ schema: NOTE_SCHEMA, data: { title, content: title } });

// The GENERATED summary: metadata.summary, written by derivers/captioners (never
// users — that's `comment`). Auto-folded into FTS; embedded as its own reserved
// text-space chunk (embedd's SUMMARY_CHUNK_ID) on the server side. Living under
// metadata means writing it never regenerates checksums: no dedup fork.
describe('Document generated summary (metadata.summary)', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-summary-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('summary patch merges into metadata without touching the content checksum', async () => {
        const id = await db.put(note('espresso machine'));
        const before = await db.getDocument(id);
        const beforeChecksum = before.getPrimaryChecksum();
        expect(before.hasSummary).toBe(false);

        // Captioner-style write-back: metadata patch only, data untouched.
        await db.put({ id, schema: NOTE_SCHEMA, data: { title: 'espresso machine', content: 'espresso machine' }, metadata: { summary: 'a chrome lever espresso machine on a wooden counter' } });

        const after = await db.getDocument(id);
        expect(after.hasSummary).toBe(true);
        expect(after.metadata.summary).toMatch(/chrome lever/);
        expect(after.getPrimaryChecksum()).toBe(beforeChecksum);
    });

    test('generateFtsData includes the summary, even with no ftsSearchFields', () => {
        const doc = new Note({ schema: NOTE_SCHEMA, data: { title: 't', content: 't' }, metadata: { summary: 'generated caption text' } });
        doc.indexOptions = { ...doc.indexOptions, ftsSearchFields: [] };
        const fts = doc.generateFtsData();
        expect(fts).toContain('generated caption text');
    });

    test('a summary-only patch reindexes FTS (doc becomes lexically searchable by its caption)', async () => {
        const id = await db.put(note('img_2041'));

        // Before: caption words match nothing.
        const before = await db.search({ query: 'tortoiseshell cat windowsill', mode: 'fts', idsOnly: true });
        expect([...before]).not.toContain(id);

        // Captioner write-back — same data (checksum untouched), summary added.
        await db.put({ id, schema: NOTE_SCHEMA, data: { title: 'img_2041', content: 'img_2041' }, metadata: { summary: 'a tortoiseshell cat sleeping on a windowsill' } });

        const after = await db.search({ query: 'tortoiseshell cat windowsill', mode: 'fts', idsOnly: true });
        expect([...after]).toContain(id);
    });
});
