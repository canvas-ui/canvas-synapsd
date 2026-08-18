import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

// Covering decomposition — the FeatureBase viewsByTimeRange walk (fine cells up
// to a boundary, coarse cells mid-span, fine again at the tail), generalized
// over synapsd scale tiers and used on BOTH sides (ingest-time interval
// coverings and query-time range decomposition; their code only decomposes at
// query time, for instants). Calendar edge cases from their time_test suite
// (the Jan-31-plus-a-month family, December rollover, leap February) are ported
// as cases here — but resolved through the civil-calendar converters, not
// through date arithmetic on a walking cursor.

const day = (y, m, d) => String(Date.UTC(y, m - 1, d) / 86400000);
const month = (y, m) => String((y - 1970) * 12 + (m - 1));
const year = (y) => String(y - 1970);

describe('quantum covering decomposition', () => {
    let rootPath;
    let db;

    beforeAll(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-quantum-'));
        db = new Db({
            path: rootPath, backupOnOpen: false, backupOnClose: false,
            semantic: { enabled: false },
        });
        await db.start();
    });

    afterAll(async () => {
        if (db) { await db.shutdown().catch(() => {}); }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); }
    });

    const cells = (name, start, end) => db.timeline.decomposeRange(name, start, end).cells
        .map((c) => `${c.scale}:${c.cell}`);

    test('an instant is a single floor cell', () => {
        expect(cells('content', '2026-08-16')).toEqual([`day:${day(2026, 8, 16)}`]);
    });

    test('a whole calendar year collapses to ONE year cell, not 365 day cells', () => {
        expect(cells('content', '2020')).toEqual([`year:${year(2020)}`]);
    });

    test('a whole month collapses to one month cell — December does not roll into month 13', () => {
        // Regression: the month→day end-boundary used daysFromCivil(year, 13, 1)
        // for December, which threw (and was silently swallowed on the query
        // side, so December month-ranges no-opped against day tiers).
        expect(cells('content', '2025-12-01', '2025-12-31')).toEqual([`month:${month(2025, 12)}`]);
    });

    test('Jan 31 + one month (their addMonth edge case): boundary day, whole February, boundary day', () => {
        // 2026 is not a leap year: February ends on the 28th, so Feb is aligned
        // and the covering is minimal — no Jan-31→Mar-2 style rollover.
        expect(cells('content', '2026-01-31', '2026-02-28')).toEqual([
            `day:${day(2026, 1, 31)}`,
            `month:${month(2026, 2)}`,
        ]);
    });

    test('leap February is covered by its month cell only when the 29th is included', () => {
        expect(cells('content', '2020-02-01', '2020-02-29')).toEqual([`month:${month(2020, 2)}`]);
        expect(cells('content', '2020-02-01', '2020-02-28')).toEqual(
            Array.from({ length: 28 }, (_, i) => `day:${day(2020, 2, i + 1)}`),
        );
    });

    test('a multi-year span walks fine→coarse→fine', () => {
        const got = cells('content', '2019-06-15', '2021-02-10');
        // Head: days to the July boundary, then months to the year boundary.
        expect(got.slice(0, 16)).toEqual(
            Array.from({ length: 16 }, (_, i) => `day:${day(2019, 6, 15 + i)}`),
        );
        expect(got).toContain(`month:${month(2019, 7)}`);
        expect(got).toContain(`month:${month(2019, 12)}`);
        // Mid-span: the whole of 2020 is ONE year cell.
        expect(got).toContain(`year:${year(2020)}`);
        expect(got.filter((c) => c.startsWith('year:'))).toEqual([`year:${year(2020)}`]);
        // Tail: January 2021 as a month, then days.
        expect(got).toContain(`month:${month(2021, 1)}`);
        expect(got.slice(-10)).toEqual(
            Array.from({ length: 10 }, (_, i) => `day:${day(2021, 2, 1 + i)}`),
        );
        // Minimality: nothing finer where a coarser aligned cell fits.
        expect(got.filter((c) => c.startsWith('day:')).length).toBe(16 + 10);
    });

    test('deep time follows the same walk where a calendar cursor cannot (Myr notation)', () => {
        const got = cells('geology', '541 MYA', '252 MYA');
        // [-541, -252] Myr: 290 Myr cells (no Gyr cell fits inside the span).
        expect(got.length).toBe(290);
        expect(got[0]).toBe('Myr:-541');
        expect(got[got.length - 1]).toBe('Myr:-252');
        expect(got.every((c) => c.startsWith('Myr:'))).toBe(true);
    });

    test('deep-time multi-position: a doc spanning two eras answers both, gap answers neither', async () => {
        const id = await db.put({
            schema: 'data/schema/note',
            data: { title: 'Trilobites', content: 'Trilobites' },
            timelines: [
                { timeline: 'geology', start: '521 MYA', end: '419 MYA', ref: 'cambrian-silurian' },
                { timeline: 'geology', start: '252 MYA', end: '66 MYA', ref: 'mesozoic' },
            ],
        });

        const cambrian = await db.list({ filters: ['t:geology:500mya..480mya'], limit: 0 });
        expect(cambrian.map((d) => d.id)).toEqual([id]);
        const jurassic = await db.list({ filters: ['t:geology:200mya..150mya'], limit: 0 });
        expect(jurassic.map((d) => d.id)).toEqual([id]);
        const gap = await db.list({ filters: ['t:geology:400mya..300mya'], limit: 0 });
        expect(gap.map((d) => d.id)).toEqual([]);
    });

    test('the floor is ADAPTIVE: each range tiles at its own notation-derived scale', () => {
        // Same timeline, three notations, three floors — no config anywhere.
        expect(db.timeline.decomposeRange('wikipedia', '541 MYA', '252 MYA').floor).toBe('Myr');
        expect(db.timeline.decomposeRange('wikipedia', '1769').floor).toBe('year');
        expect(db.timeline.decomposeRange('wikipedia', '1769-08-15').floor).toBe('day');
        // Sub-day notation clamps to 'day' (no hour/minute tier yet).
        const stamped = db.timeline.decomposeRange('wikipedia', '2026-08-16T14:30:00Z');
        expect(stamped.floor).toBe('day');
        expect(stamped.cells).toEqual([{ scale: 'day', cell: day(2026, 8, 16) }]);
    });

    test('precision follows the notation on both sides (you get out what you put in)', async () => {
        const id = await db.put({
            schema: 'data/schema/note',
            data: { title: 'Two eras', content: 'Two eras' },
            timelines: [
                { timeline: 'wikipedia', start: '1769-08-15' },
                { timeline: 'wikipedia', start: '1799-11-09', end: '1804-05-18' },
            ],
        });

        // Day-precise entries tile at day cells, so a month query inside 1799
        // BEFORE November no longer over-matches (fixed 'year' quantum did).
        const early1799 = await db.list({ filters: ['t:wikipedia:1799-02'], limit: 0 });
        expect(early1799.map((d) => d.id)).toEqual([]);
        const dec1799 = await db.list({ filters: ['t:wikipedia:1799-12'], limit: 0 });
        expect(dec1799.map((d) => d.id)).toEqual([id]);
        // Coarse queries still glue to fine-stored entries via ancestor ticks…
        const year1769 = await db.list({ filters: ['t:wikipedia:1769'], limit: 0 });
        expect(year1769.map((d) => d.id)).toEqual([id]);
        // …and exact-day queries hit the exact day.
        const exact = await db.list({ filters: ['t:wikipedia:1769-08-15'], limit: 0 });
        expect(exact.map((d) => d.id)).toEqual([id]);
        const dayOff = await db.list({ filters: ['t:wikipedia:1769-08-16'], limit: 0 });
        expect(dayOff.map((d) => d.id)).toEqual([]);
        const before = await db.list({ filters: ['t:wikipedia:1768'], limit: 0 });
        expect(before.map((d) => d.id)).toEqual([]);
    });
});
