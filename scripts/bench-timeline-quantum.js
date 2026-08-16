#!/usr/bin/env node
'use strict';

/**
 * bench-timeline-quantum.js — the write-amplification vs precision dial for the
 * multi-position membership plane (TODO.md, Timelines): how many cell writes an
 * interval costs at quantum 'year' | 'month' | 'day', on a Wikipedia-shaped
 * interval mix, plus insert/query throughput per quantum.
 *
 * Usage:
 *   node scripts/bench-timeline-quantum.js [docCount] [entriesPerDoc]
 *
 * Default: 2000 docs × 3 extra entries. Interval mix (per entry, uniform):
 *   40% instants (a date), 30% short spans (days–weeks), 20% medium (months–
 *   years), 10% long (decades–centuries) — years drawn from 1500–2030.
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

function randomInterval() {
    const y = 1500 + Math.floor(rand() * 530);
    const m = 1 + Math.floor(rand() * 12);
    const d = 1 + Math.floor(rand() * 28);
    const r = rand();
    if (r < 0.4) { return { start: iso(y, m, d) }; }                       // instant
    if (r < 0.7) {                                                        // days–weeks
        const days = 1 + Math.floor(rand() * 21);
        const end = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
        return { start: iso(y, m, d), end: iso(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()) };
    }
    if (r < 0.9) {                                                        // months–years
        const months = 1 + Math.floor(rand() * 36);
        const end = new Date(Date.UTC(y, m - 1 + months, d));
        return { start: iso(y, m, d), end: iso(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate()) };
    }
    const years = 10 + Math.floor(rand() * 200);                          // decades–centuries
    return { start: iso(y, m, d), end: iso(Math.min(y + years, 2030), m, d) };
}

async function benchQuantum(db, quantum) {
    const timeline = `bench-${quantum}`;
    db.timeline.setQuantum(timeline, quantum);

    seed = 42;
    const batches = [];
    for (let id = 1; id <= docCount; id++) {
        batches.push({ id, intervals: Array.from({ length: perDoc }, randomInterval) });
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

    // Query throughput: 500 mixed ranges (a day, a month, a year, a decade).
    seed = 7;
    const t1 = performance.now();
    let hits = 0;
    for (let i = 0; i < 500; i++) {
        const y = 1500 + Math.floor(rand() * 530);
        const kinds = [
            [iso(y, 6, 15), iso(y, 6, 15)],
            [iso(y, 6, 1), iso(y, 6, 30)],
            [iso(y, 1, 1), iso(y, 12, 31)],
            [iso(y, 1, 1), iso(Math.min(y + 10, 2030), 12, 31)],
        ];
        const [qs, qe] = kinds[i % 4];
        const ids = await db.timeline.queryInterval(timeline, qs, qe);
        hits += ids.length;
    }
    const queryMs = performance.now() - t1;

    const entries = docCount * perDoc;
    console.log(
        `${quantum.padEnd(6)} | cells/entry ${(coverCells / entries).toFixed(2).padStart(7)} | ` +
        `distinct bitmaps c=${stored.c} a=${stored.a} | ` +
        `insert ${(entries / (insertMs / 1000)).toFixed(0).padStart(6)} entries/s | ` +
        `query ${(500 / (queryMs / 1000)).toFixed(0).padStart(5)} q/s (${hits} hits)`,
    );
}

(async () => {
    rmSync(dbPath, { recursive: true, force: true });
    const db = new SynapsD({ path: dbPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
    await db.start();

    console.log(`quantum dial — ${docCount} docs × ${perDoc} entries (Wikipedia-shaped mix)\n`);
    for (const quantum of ['year', 'month', 'day']) {
        await benchQuantum(db, quantum);
    }

    await db.shutdown();
    rmSync(dbPath, { recursive: true, force: true });
})().catch((err) => { console.error(err); process.exit(1); });
