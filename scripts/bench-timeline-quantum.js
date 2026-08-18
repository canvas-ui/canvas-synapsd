#!/usr/bin/env node
'use strict';

/**
 * bench-timeline-quantum.js — write amplification and throughput of the
 * multi-position membership plane under the ADAPTIVE floor (per-entry
 * notation-derived scale; supersedes the fixed-per-timeline quantum this
 * script originally dialed). Three corpora on separate timelines:
 *
 *   year-notation  every entry written as 'YYYY' (floor: year)
 *   day-notation   every entry written as 'YYYY-MM-DD' (floor: day)
 *   mixed          Wikipedia-shaped: dates day-precise, spans year-precise
 *
 * The first two reproduce the old fixed-'year' / fixed-'day' extremes; the
 * mixed corpus is what adaptive actually buys — day cost only where the data
 * is day-precise. Usage:
 *
 *   node scripts/bench-timeline-quantum.js [docCount] [entriesPerDoc]
 */

import { resolve } from 'path';
import { rmSync } from 'fs';
import SynapsD from '../src/index.js';

const docCount = parseInt(process.argv[2], 10) || 2000;
const perDoc = parseInt(process.argv[3], 10) || 3;
const dbPath = resolve('/tmp/synapsd-bench-timeline-quantum');

// Deterministic PRNG so runs are comparable.
let seed = 42;
const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
};

const pad = (n, w = 2) => String(n).padStart(w, '0');
const iso = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

// Wikipedia-shaped interval mix (per entry, uniform): 40% instants (a date),
// 30% short spans (days–weeks), 20% medium (months–years), 10% long
// (decades–centuries) — years drawn from 1500–2030. `notation` controls the
// precision the entry is WRITTEN with, which under the adaptive floor is
// also the precision it tiles at:
//   'day'   → everything as ISO days
//   'year'  → everything rounded to bare years
//   'mixed' → instants/short spans as days, medium/long spans as years
function randomInterval(notation) {
    const y = 1500 + Math.floor(rand() * 530);
    const m = 1 + Math.floor(rand() * 12);
    const d = 1 + Math.floor(rand() * 28);
    const r = rand();
    const asYear = (from, to) => (to === undefined ? { start: String(from) } : { start: String(from), end: String(to) });
    if (r < 0.4) {                                                        // instant
        if (notation === 'year') { return asYear(y); }
        return { start: iso(y, m, d) };
    }
    if (r < 0.7) {                                                        // days–weeks
        const days = 1 + Math.floor(rand() * 21);
        const end = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
        if (notation === 'year') { return asYear(y, end.getUTCFullYear()); }
        return { start: iso(y, m, d), end: iso(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()) };
    }
    if (r < 0.9) {                                                        // months–years
        const months = 1 + Math.floor(rand() * 36);
        const end = new Date(Date.UTC(y, m - 1 + months, d));
        if (notation === 'day') {
            return { start: iso(y, m, d), end: iso(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()) };
        }
        return asYear(y, end.getUTCFullYear());
    }
    const years = 10 + Math.floor(rand() * 200);                          // decades–centuries
    if (notation === 'day') { return { start: iso(y, m, d), end: iso(Math.min(y + years, 2030), m, d) }; }
    return asYear(y, Math.min(y + years, 2030));
}

async function benchNotation(db, notation) {
    const timeline = `bench-${notation}`;

    seed = 42;
    const batches = [];
    for (let id = 1; id <= docCount; id++) {
        batches.push({ id, intervals: Array.from({ length: perDoc }, () => randomInterval(notation)) });
    }

    let coverCells = 0;
    for (const { intervals } of batches) {
        for (const iv of intervals) {
            coverCells += db.timeline.decomposeRange(timeline, { start: iv.start, end: iv.end ?? iv.start }).cells.length;
        }
    }

    const t0 = performance.now();
    for (const { id, intervals } of batches) {
        await db.timeline.insertEntries(timeline, id, intervals);
    }
    const insertMs = performance.now() - t0;

    const keys = await db.bitmapIndex.listBitmaps(`internal/tsm/${timeline}`);
    const stored = { c: 0, a: 0 };
    for (const key of keys) {
        const plane = key.split('/')[4];
        if (plane in stored) { stored[plane]++; }
    }

    // Query throughput: 500 mixed ranges (a day, a month, a year, a decade) —
    // each query's own notation sets its floor, same as ingest.
    seed = 7;
    const t1 = performance.now();
    let hits = 0;
    for (let i = 0; i < 500; i++) {
        const y = 1500 + Math.floor(rand() * 530);
        const kinds = [
            [iso(y, 6, 15), iso(y, 6, 15)],
            [iso(y, 6, 1), iso(y, 6, 30)],
            [String(y), String(y)],
            [String(y), String(Math.min(y + 10, 2030))],
        ];
        const [qs, qe] = kinds[i % 4];
        const ids = await db.timeline.queryInterval(timeline, qs, qe);
        hits += ids.length;
    }
    const queryMs = performance.now() - t1;

    const entries = docCount * perDoc;
    console.log(
        `${notation.padEnd(6)} | cells/entry ${(coverCells / entries).toFixed(2).padStart(7)} | ` +
        `distinct bitmaps c=${stored.c} a=${stored.a} | ` +
        `insert ${(entries / (insertMs / 1000)).toFixed(0).padStart(6)} entries/s | ` +
        `query ${(500 / (queryMs / 1000)).toFixed(0).padStart(5)} q/s (${hits} hits)`,
    );
}

(async () => {
    rmSync(dbPath, { recursive: true, force: true });
    const db = new SynapsD({ path: dbPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
    await db.start();

    console.log(`adaptive floor — ${docCount} docs × ${perDoc} entries (Wikipedia-shaped mix)\n`);
    for (const notation of ['year', 'day', 'mixed']) {
        await benchNotation(db, notation);
    }

    await db.shutdown();
    rmSync(dbPath, { recursive: true, force: true });
})().catch((err) => { console.error(err); process.exit(1); });
