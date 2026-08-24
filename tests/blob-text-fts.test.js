import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import File from '../src/schemas/core/File.js';

const FILE_SCHEMA = 'data/schema/file';

// A File document is the bytes' record, so the bytes themselves are the only
// place its words live. Indexed by name alone, a markdown file, a config or a
// source file matched nothing you could remember about what it SAYS — you had
// to remember what it was called. `metadata.text.content` is the searchable head
// the ingest extractor puts there (canvas-stored/src/extractors/text.js);
// living under metadata means writing it never regenerates checksums.
const fileDoc = (name, text) => ({
    schema: FILE_SCHEMA,
    data: {},
    checksumArray: [`sha256/${name}`],
    locations: [{ url: `stored://workspace:data/${name}`, metadata: { filename: name } }],
    metadata: {
        contentType: 'text/markdown',
        filename: name,
        ...(text ? { text: { content: text, truncated: false, mimeType: 'text/markdown' } } : {}),
    },
});

describe('extracted blob text (metadata.text.content)', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-blobtext-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('generateFtsData carries the extracted text', () => {
        const doc = new File(fileDoc('q3.md', 'the pelican migration numbers are strong'));
        expect(doc.generateFtsData().join(' ')).toMatch(/pelican migration/);
    });

    test('a text file is findable by what it says, not just what it is called', async () => {
        const id = await db.put(fileDoc('q3.md', 'the pelican migration numbers are strong'));
        const hits = await db.search({ query: 'pelican migration', mode: 'fts', idsOnly: true });
        expect([...hits]).toContain(id);
    });

    test('text arriving late reindexes FTS, though the bytes never changed', async () => {
        // A blob stored before extraction existed: same checksum forever, so
        // without an explicit guard the backfill patch would be treated as a
        // no-op re-tick and the text would sit in metadata, unsearched.
        const id = await db.put(fileDoc('legacy.md', null));
        const before = await db.search({ query: 'quarterly figures', mode: 'fts', idsOnly: true });
        expect([...before]).not.toContain(id);

        await db.put({ id, ...fileDoc('legacy.md', 'quarterly figures are up') });

        const after = await db.search({ query: 'quarterly figures', mode: 'fts', idsOnly: true });
        expect([...after]).toContain(id);
    });
});
