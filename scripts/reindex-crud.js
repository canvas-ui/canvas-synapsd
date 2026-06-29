#!/usr/bin/env node
'use strict';

/**
 * reindex-crud.js — Rebuild the crud:* lifecycle timelines of a SynapsD database.
 *
 *   node scripts/reindex-crud.js -d <workspace-db-dir>
 *
 * When to run: after the crud timelines changed storage format (interval/ms →
 * point-event/second). Documents indexed under the old format have orphaned
 * crud:created/crud:updated memberships, so `t:crud:*` filters return nothing
 * until rebuilt. This deletes the stale crud bitmaps and re-derives them from
 * each document's createdAt/updatedAt. Idempotent; safe to re-run.
 *
 * Each workspace is its own DB — point -d at that workspace's db directory, e.g.
 *   server/users/<user>/workspaces/<workspace>/db
 *
 * Lance/embeddings are disabled (this only touches timeline bitmaps).
 */

import { parseArgs } from 'node:util';

const OPTS = {
    db: { type: 'string', short: 'd' },
    help: { type: 'boolean', short: 'h', default: false },
};

function usage() {
    console.log(`reindex-crud — rebuild crud:* timelines from the document store

Usage:
  node scripts/reindex-crud.js -d <workspace-db-dir>

Options:
  -d, --db <dir>   Path to the workspace SynapsD database directory (required)
  -h, --help       Show this help
`);
}

async function main() {
    let parsed;
    try {
        parsed = parseArgs({ options: OPTS, allowPositionals: false });
    } catch (e) {
        console.error(`Argument error: ${e.message}`);
        usage();
        process.exit(1);
    }

    const { db: dbDir, help } = parsed.values;
    if (help) { usage(); return; }
    if (!dbDir) {
        console.error('Error: -d/--db <workspace-db-dir> is required.');
        usage();
        process.exit(1);
    }

    // Skip Lance/vector setup entirely — this is a pure timeline-bitmap rebuild.
    const LanceIndex = (await import('../src/indexes/lance/index.js')).default;
    LanceIndex.prototype.initialize = async function () { /* noop */ };
    LanceIndex.prototype.backfill = async function () { /* noop */ };
    LanceIndex.prototype.addMany = async function () { /* noop */ };

    const { default: SynapsD } = await import('../src/index.js');
    const db = new SynapsD({
        path: dbDir,
        backupOnOpen: false,
        backupOnClose: false,
        compression: true,
    });

    const started = Date.now();
    await db.start();
    console.log(`db started: ${dbDir}`);

    try {
        const counts = await db.reindexCrudTimelines({
            onProgress: ({ scanned, total }) => {
                process.stdout.write(`\r  rebuilding crud timelines… ${scanned}/${total}`);
            },
        });
        process.stdout.write('\n');
        console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        console.log(`  scanned:          ${counts.scanned}`);
        console.log(`  crud:created set: ${counts.created}`);
        console.log(`  crud:updated set: ${counts.updated}`);
        console.log(`  stale timelines removed: ${counts.removedTimelines}`);
    } finally {
        await db.shutdown();
    }
}

main().catch((e) => {
    console.error(`\nreindex-crud failed: ${e?.stack || e?.message || e}`);
    process.exit(1);
});
