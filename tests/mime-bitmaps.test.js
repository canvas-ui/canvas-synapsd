import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const FILE_SCHEMA = 'data/abstraction/file';
const NOTE_SCHEMA = 'data/abstraction/note';

// A blob/File doc: mime lives in metadata.contentType (doc-level invariant).
let seq = 0;
const file = (contentType) => ({
    schema: FILE_SCHEMA,
    data: {},
    checksumArray: [`sha256:file-${seq++}`],
    metadata: { contentType },
    locations: [{ url: `file://host/blob-${seq}` }],
});
const note = (title) => ({ schema: NOTE_SCHEMA, data: { title, content: title } });

// Per-MIME-type presence bitmaps: derived from metadata.contentType on every
// write (no synapse backing), two keys per doc — the top-level type
// (data/mime/image, for modality-scoped scans) and the full type
// (data/mime/image/jpeg, for granular filtering). The generic inline-JSON
// default (application/json) is skipped so it doesn't shadow schema bitmaps.
describe('per-MIME-type presence bitmaps', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-mime-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('a photo ticks both the top-level and full mime bitmaps', async () => {
        const id = await db.put(file('image/jpeg'));

        const byType = await db.list({ features: { allOf: ['data/mime/image'] } });
        expect(byType.map(d => d.id)).toContain(id);

        const bySubtype = await db.list({ features: { allOf: ['data/mime/image/jpeg'] } });
        expect(bySubtype.map(d => d.id)).toContain(id);
    });

    test('the top-level type bitmap groups every subtype (modality scan)', async () => {
        const jpg = await db.put(file('image/jpeg'));
        const png = await db.put(file('image/png'));
        const pdf = await db.put(file('application/pdf'));

        const images = await db.list({ features: { allOf: ['data/mime/image'] } });
        const imageIds = images.map(d => d.id);
        expect(imageIds).toContain(jpg);
        expect(imageIds).toContain(png);
        expect(imageIds).not.toContain(pdf);
    });

    test('charset params are stripped; + is preserved (no vocabulary translation)', async () => {
        const id = await db.put(file('image/svg+xml; charset=utf-8'));
        // '+' is an allowed bitmap-key char, so the mime round-trips verbatim.
        const hit = await db.list({ features: { allOf: ['data/mime/image/svg+xml'] } });
        expect(hit.map(d => d.id)).toContain(id);
    });

    test('the generic application/json default is not ticked (no schema shadow)', async () => {
        const id = await db.put(note('plain'));
        const json = await db.list({ features: { allOf: ['data/mime/application/json'] } });
        expect(json.map(d => d.id)).not.toContain(id);
    });

    test('changing contentType on update unticks the stale mime keys', async () => {
        const id = await db.put(file('image/jpeg'));
        // Re-put same id with a new contentType.
        await db.put({ id, schema: FILE_SCHEMA, data: {}, checksumArray: ['sha256:file-updated'], metadata: { contentType: 'application/pdf' } });

        const stillImage = await db.list({ features: { allOf: ['data/mime/image'] } });
        expect(stillImage.map(d => d.id)).not.toContain(id);

        const nowPdf = await db.list({ features: { allOf: ['data/mime/application/pdf'] } });
        expect(nowPdf.map(d => d.id)).toContain(id);
    });

    test('reindexMimeBitmaps backfills after the bitmaps are dropped', async () => {
        const jpg = await db.put(file('image/jpeg'));
        const pdf = await db.put(file('application/pdf'));

        // Simulate a corpus indexed before mime bitmaps existed: drop them all.
        // Trailing slash is tolerated (prefix semantics) — listBitmaps strips it.
        for (const key of await db.bitmapIndex.listBitmaps('data/mime/')) {
            await db.bitmapIndex.deleteBitmap(key);
        }
        let gone = await db.list({ features: { allOf: ['data/mime/image'] } });
        expect(gone.map(d => d.id)).not.toContain(jpg);

        const res = await db.reindexMimeBitmaps();
        expect(res.scanned).toBeGreaterThanOrEqual(2);
        expect(res.ticked).toBeGreaterThanOrEqual(2);

        const images = await db.list({ features: { allOf: ['data/mime/image'] } });
        expect(images.map(d => d.id)).toContain(jpg);
        const pdfs = await db.list({ features: { allOf: ['data/mime/application/pdf'] } });
        expect(pdfs.map(d => d.id)).toContain(pdf);
    });
});
