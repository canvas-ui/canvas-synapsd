#!/usr/bin/env node
'use strict';

/**
 * bench-putmany.js — Benchmark putMany with N lightweight JSON documents (simulating browser tabs).
 *
 * Usage:
 *   node scripts/bench-putmany.js [count] [--no-lance]
 *
 * Default: 250 documents
 */

import { resolve } from 'path';
import { rmSync } from 'fs';
import SynapsD from '../src/index.js';

const count = parseInt(process.argv[2], 10) || 250;
const noLance = process.argv.includes('--no-lance');
const dbPath = resolve('/tmp/synapsd-bench-putmany');

// Clean slate
try { rmSync(dbPath, { recursive: true, force: true }); } catch {}

function generateTabs(n) {
    const tabs = [];
    for (let i = 0; i < n; i++) {
        tabs.push({
            schema: 'data/abstraction/tab',
            data: {
                title: `Tab ${i} — ${randomTitle()}`,
                url: `https://example.com/page/${i}?q=${Math.random().toString(36).slice(2)}`,
                favIconUrl: `https://example.com/favicon-${i}.ico`,
                windowId: Math.floor(Math.random() * 5),
                index: i,
                active: i === 0,
                pinned: i < 3,
            },
            locations: [{ url: `browser://tab/${i}` }],
        });
    }
    return tabs;
}

function randomTitle() {
    const words = ['GitHub', 'Stack Overflow', 'MDN', 'Reddit', 'Hacker News', 'YouTube', 'Twitter',
        'Linear', 'Figma', 'Notion', 'Slack', 'Discord', 'Gmail', 'Calendar', 'Docs'];
    return words[Math.floor(Math.random() * words.length)] + ' - ' +
        words[Math.floor(Math.random() * words.length)];
}

function elapsed(start) {
    const ms = performance.now() - start;
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    return `${(ms / 1000).toFixed(3)}s`;
}

async function main() {
    if (noLance) {
        const LanceIndex = (await import('../src/indexes/lance/index.js')).default;
        LanceIndex.prototype.initialize = async function () {};
        LanceIndex.prototype.upsert = async function () {};
        LanceIndex.prototype.backfill = async function () {};
    }

    const db = new SynapsD({ path: dbPath });
    await db.start();
    await db.createTree('browser', 'directory');

    const tabs = generateTabs(count);
    console.log(`\n  Benchmarking putMany with ${count} tab documents${noLance ? ' (no lance)' : ''}\n`);

    // Benchmark putMany
    const t1 = performance.now();
    const ids = await db.putMany(tabs, { tree: 'browser', path: '/tabs/window-1' }, ['data/abstraction/tab']);
    const putManyTime = performance.now() - t1;
    console.log(`  putMany(${count}):  ${elapsed(t1)}  (${(count / (putManyTime / 1000)).toFixed(0)} docs/s)`);

    // Verify
    const t2 = performance.now();
    const found = await db.list({ tree: 'browser', path: '/tabs/window-1', features: ['data/abstraction/tab'] });
    console.log(`  list:           ${elapsed(t2)}  (${found.totalCount} docs found)`);

    // Benchmark single put in a loop (for comparison)
    try { rmSync(dbPath + '-single', { recursive: true, force: true }); } catch {}
    const db2 = new SynapsD({ path: dbPath + '-single' });
    await db2.start();
    await db2.createTree('browser', 'directory');

    const tabs2 = generateTabs(count);
    const t3 = performance.now();
    for (const tab of tabs2) {
        await db2.put(tab, { tree: 'browser', path: '/tabs/window-1' }, ['data/abstraction/tab'], { emitEvent: false });
    }
    const singleTime = performance.now() - t3;
    console.log(`  put() x${count}:    ${elapsed(t3)}  (${(count / (singleTime / 1000)).toFixed(0)} docs/s)`);

    const speedup = (singleTime / putManyTime).toFixed(1);
    console.log(`\n  Speedup: ${speedup}x\n`);

    await db.shutdown();
    await db2.shutdown();

    // Cleanup
    try { rmSync(dbPath, { recursive: true, force: true }); } catch {}
    try { rmSync(dbPath + '-single', { recursive: true, force: true }); } catch {}
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
