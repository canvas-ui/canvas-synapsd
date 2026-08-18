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

// Multi-position timelines: several positions or ranges per document on one
// timeline. The primary entry (first, or flagged `primary: true`) lives in the
// sortable dual-BSI; every additional entry lands in the tiled membership plane
// (internal/tsm/*, Pilosa time-quantum shaped coverings). The document stays the
// source of truth — every plane is L3-derived from timelines[].
describe('multi-position timelines', () => {
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

    test('several entries on ONE timeline are indexed, and each position is found', async () => {
        const id = await db.put(note('Rome notes', [
            { timeline: 'wikipedia', start: '-0509', end: '-0027', ref: 'republic' },
            { timeline: 'wikipedia', start: '-0027', end: '0476', ref: 'empire' },
            { timeline: 'wikipedia', start: '1453', ref: 'fall-of-constantinople' },
        ]));

        // Every declared position answers a range query...
        for (const filter of ['t:wikipedia:-0400..-0300', 't:wikipedia:0100..0200', 't:wikipedia:1453']) {
            const hits = await db.list({ filters: [filter], limit: 0 });
            expect(hits.map((d) => d.id)).toEqual([id]);
        }

        // ...and a gap between positions does not.
        const gap = await db.list({ filters: ['t:wikipedia:0800..1200'], limit: 0 });
        expect(gap.map((d) => d.id)).toEqual([]);

        // The row keeps every entry verbatim, ref included (opaque to the engine).
        const doc = await db.get(id);
        expect(doc.timelines.map((t) => t.ref)).toEqual(['republic', 'empire', 'fall-of-constantinople']);
    });

    test('the primary entry is the sortable position; primary:true overrides first-wins', async () => {
        const first = await db.put(note('A', [
            { timeline: 'wikipedia', start: '1969', ref: 'moon' },
            { timeline: 'wikipedia', start: '1903', ref: 'kitty-hawk' },
        ]));
        const second = await db.put(note('B', [
            { timeline: 'wikipedia', start: '1927', ref: 'atlantic' },
            { timeline: 'wikipedia', start: '1912', ref: 'titanic', primary: true },
        ]));

        // sortBy uses the primary interval only: A sorts at 1969 (first entry),
        // B at 1912 (flagged primary), so B precedes A.
        const sorted = await db.list({ filters: ['t:wikipedia:1900..1980'], sortBy: 'wikipedia', limit: 0 });
        expect(sorted.map((d) => d.id)).toEqual([second, first]);

        // Non-primary positions still answer membership queries.
        const kittyHawk = await db.list({ filters: ['t:wikipedia:1903'], limit: 0 });
        expect(kittyHawk.map((d) => d.id)).toEqual([first]);
        const atlantic = await db.list({ filters: ['t:wikipedia:1927'], limit: 0 });
        expect(atlantic.map((d) => d.id)).toEqual([second]);
    });

    test('an update re-derives the plane — dropped positions stop matching', async () => {
        const id = await db.put(note('Draft', [
            { timeline: 'wikipedia', start: '1769-08-15', ref: 'd1' },
            { timeline: 'wikipedia', start: '1799-11-09', end: '1804-05-18', ref: 'consulate' },
        ]));

        await db.put({
            id,
            schema: 'data/schema/note',
            data: { title: 'Draft', content: 'Draft' },
            timelines: [{ timeline: 'wikipedia', start: '1769-08-15', ref: 'd1' }],
        });

        const kept = await db.list({ filters: ['t:wikipedia:1769'], limit: 0 });
        expect(kept.map((d) => d.id)).toEqual([id]);
        const dropped = await db.list({ filters: ['t:wikipedia:1799-11..1804-05'], limit: 0 });
        expect(dropped.map((d) => d.id)).toEqual([]);
    });

    test('delete removes every position, not just the primary', async () => {
        const id = await db.put(note('Gone', [
            { timeline: 'wikipedia', start: '1815' },
            { timeline: 'wikipedia', start: '1821-05-05' },
        ]));
        await db.delete(id);

        for (const filter of ['t:wikipedia:1815', 't:wikipedia:1821']) {
            const hits = await db.list({ filters: [filter], limit: 0 });
            expect(hits.map((d) => d.id)).toEqual([]);
        }
    });

    test('open-ended NON-primary entries land in the sidecar (several ongoing facts per doc)', async () => {
        // The wiki-distillation shape the sidecar exists for: one doc, one
        // timeline, a bounded primary plus TWO ongoing facts at different
        // scales — no primary-slot picking, no snapshot-date bounding.
        const id = await db.put(note('Cenozoic person', [
            { timeline: 'wikipedia', start: '1912-06-23', end: '1954-06-07' },   // primary (bounded)
            { timeline: 'wikipedia', start: '66 MYA', end: null, ref: 'cenozoic' },
            { timeline: 'wikipedia', start: '2000', end: null, ref: 'career' },
        ]));

        // Inside the bounded primary.
        expect((await db.list({ filters: ['t:wikipedia:1930'], limit: 0 })).map((d) => d.id)).toEqual([id]);
        // After the primary ended, inside BOTH ongoing facts.
        expect((await db.list({ filters: ['t:wikipedia:2030'], limit: 0 })).map((d) => d.id)).toEqual([id]);
        // Deep past: inside the Cenozoic but before everything else.
        expect((await db.list({ filters: ['t:wikipedia:30mya'], limit: 0 })).map((d) => d.id)).toEqual([id]);
        // Before all entries: no match.
        expect((await db.list({ filters: ['t:wikipedia:70mya'], limit: 0 })).map((d) => d.id)).toEqual([]);

        // The row keeps every entry + ref verbatim — only the index collapses.
        const stored = await db.get(id);
        expect(stored.timelines.map((t) => t.ref).filter(Boolean)).toEqual(['cenozoic', 'career']);

        // Update: dropping one ongoing fact re-derives the sidecar from the row.
        const update = (timelines) => db.put({
            id, schema: 'data/schema/note',
            data: { title: 'Cenozoic person', content: 'Cenozoic person' },
            timelines,
        });
        await update(stored.timelines.filter((t) => t.ref !== 'career'));
        expect((await db.list({ filters: ['t:wikipedia:2030'], limit: 0 })).map((d) => d.id)).toEqual([id]); // cenozoic still ongoing
        await update(stored.timelines.filter((t) => !t.ref));
        expect((await db.list({ filters: ['t:wikipedia:2030'], limit: 0 })).map((d) => d.id)).toEqual([]);
        expect((await db.list({ filters: ['t:wikipedia:1930'], limit: 0 })).map((d) => d.id)).toEqual([id]); // primary intact
    });

    test('an open primary keeps living in the main dual-BSI exactly as before', async () => {
        const id = await db.put(note('Ok', [
            { timeline: 'life', start: '1912-06-23', end: '1954-06-07' },
            { timeline: 'life', start: '2000', end: null, primary: true },
        ]));
        const ongoing = await db.list({ filters: ['t:life:2030'], limit: 0 });
        expect(ongoing.map((d) => d.id)).toEqual([id]);
        const bounded = await db.list({ filters: ['t:life:1930'], limit: 0 });
        expect(bounded.map((d) => d.id)).toEqual([id]);
    });

    test('positions AND natively with feature filters (cells hold doc ids)', async () => {
        const noteId = await db.put({
            ...note('Napoleon note', [
                { timeline: 'wikipedia', start: '1769-08-15' },
                { timeline: 'wikipedia', start: '1799-11-09', end: '1804-05-18' },
            ]),
            features: ['custom/napoleon'],
        });
        await db.put(note('Unrelated', [{ timeline: 'wikipedia', start: '1802' }]));

        // The range only overlaps the SECOND (non-primary) position, and the
        // feature filter narrows the two matching docs down to the tagged one —
        // membership cells hold doc ids, so the AND happens on bitmaps.
        const narrowed = await db.list({
            filters: ['t:wikipedia:1800..1803'],
            features: ['custom/napoleon'],
            limit: 0,
        });
        expect(narrowed.map((d) => d.id)).toEqual([noteId]);
    });

    test('a legacy row carrying odd entries can still be deleted', async () => {
        const id = await db.put(note('Ok', [{ timeline: 'wikipedia', start: '-0509', end: '0476' }]));

        // Simulate a row written by an older version: mutate the stored document
        // so it carries a malformed entry, then make sure cleanup does not throw.
        const stored = await db.get(id);
        stored.timelines.push({ timeline: 'wikipedia' }); // no start
        await db.documents.put(id, stored);

        await expect(db.delete(id)).resolves.not.toThrow();
    });
});
