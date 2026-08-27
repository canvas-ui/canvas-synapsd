'use strict';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

/**
 * `listBitmaps(prefix)` returns the prefix's OWN key as well as its children.
 *
 * A namespace that is also a key is a roll-up — `data/mime/image`,
 * `data/backend/imap` ("everything from IMAP", ticked alongside the specific
 * account). A listing that silently omits it has already cost one real bug:
 * `internal/lance/vectors` was the text presence bitmap AND the parent of the
 * image one, so listing it returned image and dropped text without a word. It
 * also forced every namespace sweep to carry a second, hand-written list of the
 * bare keys the sweep could not see.
 *
 * The range itself still starts at `prefix + '/'`, and must: keys are only
 * prefix-validated, so a segment may contain '-' or '.', both of which sort
 * BEFORE '/'. Widening the range instead of adding the one key would quietly
 * pull siblings into every listing.
 */
describe('listBitmaps(prefix)', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-listbitmaps-test-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('returns the roll-up key together with what is under it', async () => {
        await db.bitmapIndex.createBitmap('data/backend/imap');
        await db.bitmapIndex.createBitmap('data/backend/imap/mail.example.com');

        expect((await db.bitmapIndex.listBitmaps('data/backend/imap')).sort()).toEqual([
            'data/backend/imap',
            'data/backend/imap/mail.example.com',
        ]);
        // And from one level up, where it was always visible as a child.
        expect((await db.bitmapIndex.listBitmaps('data/backend')).sort()).toEqual([
            'data/backend/imap',
            'data/backend/imap/mail.example.com',
        ]);
    });

    test('a leaf with no children lists as itself', async () => {
        // The shape that needed its own hand-maintained list to be swept.
        await db.bitmapIndex.createBitmap('data/no-location');
        expect(await db.bitmapIndex.listBitmaps('data/no-location')).toEqual(['data/no-location']);
    });

    test('siblings that merely start with the prefix stay out', async () => {
        // '-' (0x2D) and '.' (0x2E) sort before '/' (0x2F), so these are the
        // keys a widened range bound would swallow.
        await db.bitmapIndex.createBitmap('data/backend');
        await db.bitmapIndex.createBitmap('data/backend/file');
        await db.bitmapIndex.createBitmap('data/backend-legacy');
        await db.bitmapIndex.createBitmap('data/backend.old');

        expect((await db.bitmapIndex.listBitmaps('data/backend')).sort()).toEqual([
            'data/backend',
            'data/backend/file',
        ]);
    });

    test('a trailing slash still means the same namespace', async () => {
        await db.bitmapIndex.createBitmap('data/dataset');
        await db.bitmapIndex.createBitmap('data/dataset/pipe');

        expect((await db.bitmapIndex.listBitmaps('data/dataset/')).sort())
            .toEqual((await db.bitmapIndex.listBitmaps('data/dataset')).sort());
    });

    test('an unprefixed listing is unchanged', async () => {
        await db.bitmapIndex.createBitmap('data/backend/imap');
        const all = await db.bitmapIndex.listBitmaps();
        expect(all).toContain('data/backend/imap');
        expect(all.some((key) => key.startsWith('internal/'))).toBe(false);
        expect((await db.bitmapIndex.listBitmaps('', { includeInternal: true })).length)
            .toBeGreaterThanOrEqual(all.length);
    });

    test('a rebuild sheds a retired bare key without a list of its own', async () => {
        await db.put({ schema: 'data/schema/note', data: { title: 'n', content: 'c' } });
        await db.bitmapIndex.createBitmap('data/no-location');
        expect(db.bitmapIndex.hasBitmap('data/no-location')).toBe(true);

        await db.rebuildL3({ bitmaps: true, edges: false });

        expect(db.bitmapIndex.hasBitmap('data/no-location')).toBe(false);
    });
});
