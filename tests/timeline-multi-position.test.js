import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const note = (title, timelines) => ({
    schema: 'data/schema/note',
    data: { title, content: title },
    ...(timelines ? { timelines } : {}),
});

// A document occupies ONE position per timeline — the index is a BSI keyed
// id -> a single value, so a second insert for the same (timeline, id)
// overwrites the first. Multi-position is WANTED (a note referencing N eras on a
// 'wikipedia' timeline) but not yet supported; until it is, the engine must
// refuse rather than silently keep only the last entry.
describe('one position per timeline', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-multipos-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('duplicate entries on ONE timeline are refused, not silently truncated', async () => {
        await expect(db.put(note('Rome notes', [
            { timeline: 'wikipedia', start: '-0509', end: '-0027' },
            { timeline: 'wikipedia', start: '-0027', end: '0476' },
        ]))).rejects.toThrow(/multiple entries for timeline "wikipedia"/);
    });

    test('nothing is indexed when the write is refused — no half-applied state', async () => {
        await db.put(note('Rome notes', [
            { timeline: 'wikipedia', start: '-0509', end: '-0027' },
            { timeline: 'wikipedia', start: '-0027', end: '0476' },
        ])).catch(() => {});

        // The pre-guard behaviour indexed the LAST entry and answered this query.
        const hit = await db.list({ filters: ['t:wikipedia:-0027..0476'], limit: 0 });
        expect(hit.map((d) => d.id)).toEqual([]);
    });

    test('distinct timeline names are the supported way to carry several axes', async () => {
        const id = await db.put(note('Rome notes', [
            { timeline: 'wikipedia', start: '-0509', end: '0476' },
            { timeline: 'content', start: '2026-08-03T10:00:00.000Z' },
        ]));

        const byEra = await db.list({ filters: ['t:wikipedia:-0100..0100'], limit: 0 });
        expect(byEra.map((d) => d.id)).toEqual([id]);

        const byContent = await db.list({ filters: ['t:content:2026-08-01..2026-08-31'], limit: 0 });
        expect(byContent.map((d) => d.id)).toEqual([id]);
    });

    test('one document per position is the supported workaround, and each is found', async () => {
        const republic = await db.put(note('Roman Republic', [{ timeline: 'wikipedia', start: '-0509', end: '-0027' }]));
        const empire = await db.put(note('Roman Empire', [{ timeline: 'wikipedia', start: '-0027', end: '0476' }]));

        const early = await db.list({ filters: ['t:wikipedia:-0400..-0300'], limit: 0 });
        expect(early.map((d) => d.id)).toEqual([republic]);

        const later = await db.list({ filters: ['t:wikipedia:0100..0200'], limit: 0 });
        expect(later.map((d) => d.id)).toEqual([empire]);
    });

    test('a legacy row carrying duplicates can still be deleted', async () => {
        const id = await db.put(note('Ok', [{ timeline: 'wikipedia', start: '-0509', end: '0476' }]));

        // Simulate a row written before the guard: mutate the stored document so
        // it carries duplicate entries, then make sure cleanup does not throw.
        const stored = await db.get(id);
        stored.timelines.push({ timeline: 'wikipedia', start: '0476', end: '1453' });
        await db.documents.put(id, stored);

        await expect(db.delete(id)).resolves.not.toThrow();
    });
});
