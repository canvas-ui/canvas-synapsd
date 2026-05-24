#!/usr/bin/env node
'use strict';

/**
 * bench-tick-bitmaps.js - Benchmark ticking N IDs into M roaring bitmaps.
 *
 * Usage:
 *   node scripts/bench-tick-bitmaps.js [count] [bitmap-count]
 *
 * Default: 50, 250, 500, 1000, and 1500 IDs across 30, 200, 500, and 1000 bitmaps
 */

import { resolve } from 'path';
import { rmSync } from 'fs';
import LmdbBackend from '../src/backends/lmdb/index.js';
import BitmapIndex from '../src/indexes/bitmaps/index.js';

const requestedCount = parseInt(process.argv[2], 10);
const counts = Number.isInteger(requestedCount)
    ? [requestedCount]
    : [50, 250, 500, 1000, 1500];
const requestedBitmapCount = parseInt(process.argv[3], 10);
const bitmapCounts = Number.isInteger(requestedBitmapCount)
    ? [requestedBitmapCount]
    : [30, 200, 500, 1000];
const dbPath = resolve('/tmp/synapsd-bench-tick-bitmaps');

function generateIds(n) {
    return Array.from({ length: n }, (_, i) => i + 1);
}

function generateKeys(n) {
    return Array.from({ length: n }, (_, i) => `data/bench/bitmap-${i + 1}`);
}

function elapsed(start) {
    const ms = performance.now() - start;
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    return `${(ms / 1000).toFixed(3)}s`;
}

function rate(ops, ms) {
    return (ops / (ms / 1000)).toFixed(0);
}

function createBitmapIndex(path) {
    const db = new LmdbBackend({
        path,
        backupOnOpen: false,
        backupOnClose: false,
    });
    return {
        db,
        bitmapIndex: new BitmapIndex(db.createDataset('bitmaps'), new Map()),
    };
}

async function verify(bitmapIndex, keys, expectedSize) {
    for (const key of keys) {
        const bitmap = await bitmapIndex.getBitmap(key, false);
        if (!bitmap || bitmap.size !== expectedSize) {
            throw new Error(`Bitmap "${key}" has ${bitmap?.size ?? 0} IDs, expected ${expectedSize}`);
        }
    }
}

async function runBenchmark(count, bitmapCount) {
    try { rmSync(dbPath, { recursive: true, force: true }); } catch {}
    try { rmSync(dbPath + '-single', { recursive: true, force: true }); } catch {}

    const ids = generateIds(count);
    const keys = generateKeys(bitmapCount);

    console.log(`\n  Benchmarking bitmap ticks with ${count} IDs across ${bitmapCount} bitmaps\n`);

    const batched = createBitmapIndex(dbPath);
    const t1 = performance.now();
    await batched.bitmapIndex.tickMany(keys, ids);
    const batchedTime = performance.now() - t1;
    console.log(`  tickMany(${bitmapCount} keys, ${count} IDs):  ${elapsed(t1)}  (${rate(count * bitmapCount, batchedTime)} ticks/s)`);

    const t2 = performance.now();
    await verify(batched.bitmapIndex, keys, count);
    console.log(`  verify batched:                 ${elapsed(t2)}  (${keys.length} bitmaps checked)`);

    const single = createBitmapIndex(dbPath + '-single');
    const t3 = performance.now();
    for (const id of ids) {
        await single.bitmapIndex.tickMany(keys, id);
    }
    const singleTime = performance.now() - t3;
    console.log(`  tickMany(${bitmapCount} keys, 1 ID) x${count}:  ${elapsed(t3)}  (${rate(count * bitmapCount, singleTime)} ticks/s)`);

    const t4 = performance.now();
    await verify(single.bitmapIndex, keys, count);
    console.log(`  verify single:                  ${elapsed(t4)}  (${keys.length} bitmaps checked)`);

    const speedup = (singleTime / batchedTime).toFixed(1);
    console.log(`\n  Speedup: ${speedup}x\n`);

    await batched.db.close();
    await single.db.close();

    try { rmSync(dbPath, { recursive: true, force: true }); } catch {}
    try { rmSync(dbPath + '-single', { recursive: true, force: true }); } catch {}
}

async function main() {
    for (const count of counts) {
        for (const bitmapCount of bitmapCounts) {
            await runBenchmark(count, bitmapCount);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
