'use strict';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/abstraction/note';

function note(title) {
    return { schema: NOTE_SCHEMA, data: { title, content: title } };
}

function ids(results) {
    return results.map((doc) => doc.id).sort((a, b) => a - b);
}

describe('maintained all-docs bitmap (internal/docs/all)', () => {
    let rootPath;
    let db;

    const reopen = async () => {
        await db.shutdown();
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    };

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-alldocs-test-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('tracks puts and deletes; dataset default selection uses it as base', async () => {
        const a = await db.put(note('plain a'));
        const b = await db.put(note('plain b'));
        // A dataset must exist for the selection (and thus the all-docs base) to engage.
        const stamped = await db.put(note('stamped'), { features: ['data/dataset/pipe'] });

        expect(ids(await db.list({}))).toEqual([a, b]);

        await db.delete(a);
        // The deleted doc must leave the default dataset immediately.
        expect(ids(await db.list({}))).toEqual([b]);
        expect(ids(await db.list({ features: { anyOf: ['data/dataset/pipe'] } }))).toEqual([b, stamped]);
    });

    test('membership survives a restart', async () => {
        const a = await db.put(note('persists'));
        await db.put(note('stamped'), { features: ['data/dataset/pipe'] });
        await reopen();
        expect(ids(await db.list({}))).toEqual([a]);
    });

    test('backfills from the document store when the bitmap is missing (pre-feature stores)', async () => {
        const a = await db.put(note('old doc'));
        await db.put(note('stamped'), { features: ['data/dataset/pipe'] });

        // Simulate a store created before internal/docs/all existed.
        await db.bitmapIndex.deleteBitmap('internal/docs/all');
        await reopen();

        expect(ids(await db.list({}))).toEqual([a]);
    });
});
