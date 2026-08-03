#!/usr/bin/env node
'use strict';

/**
 * migrate-v3.js — apply the refactor-v3 schema migration (v1 -> v2) to a SynapsD DB.
 *
 *   node scripts/migrate-v3.js -d <workspace-db-dir> [--dry-run]
 *
 * The migration REWRITES every document row, which is why opening a stale DB
 * throws instead of migrating implicitly on a server restart. What it does:
 *
 *   - drops `indexOptions` from every row (schema-level now; ~414 B/row)
 *   - moves `metadata.features` -> root `features[]`, stripping DERIVED keys and
 *     keeping tag/ custom/ client/ data/dataset/
 *   - recovers asserted tags that exist ONLY in bitmaps (pre-2026-07-15 rows had
 *     no doc-side record — they are the last state with no rebuild source)
 *   - stamps `kind`, migrates dotfile repoPath -> normalized url
 *   - drops rel/*, data/source/*, and re-derives data/backend/* + data/kind/*
 *   - replays asserted edges from data.relations
 *
 * Idempotent: every step makes the row match what current code would produce, so
 * re-running is a no-op. Back up first anyway — it is a full-table rewrite.
 *
 * Each workspace is its own DB — point -d at that workspace's db directory, e.g.
 *   server/users/<user>/workspaces/<workspace>/db
 */

import { parseArgs } from 'node:util';
import Db from '../src/index.js';

const OPTS = {
    db: { type: 'string', short: 'd' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
};

function usage() {
    console.log(`migrate-v3 — apply the refactor-v3 schema migration

Usage:
  node scripts/migrate-v3.js -d <workspace-db-dir> [--dry-run]

Options:
  -d, --db <dir>   workspace db directory (required)
      --dry-run    report what would change without writing
  -h, --help       show this help
`);
}

const { values } = parseArgs({ options: OPTS, allowPositionals: false });

if (values.help || !values.db) {
    usage();
    process.exit(values.help ? 0 : 1);
}

const db = new Db({
    path: values.db,
    migrate: !values['dry-run'],
    backupOnOpen: true,
    backupOnClose: false,
    semantic: { enabled: false },
});

try {
    if (values['dry-run']) {
        // Opening without `migrate` throws when the DB is stale — that IS the check.
        try {
            await db.start();
            console.log('Nothing to do: database is already at the current schema version.');
        } catch (error) {
            if (/needs v/.test(error.message)) {
                console.log('Migration REQUIRED. Re-run without --dry-run to apply it.');
                console.log(`  ${error.message}`);
                process.exit(0);
            }
            throw error;
        }
    } else {
        await db.start();
        const stats = db.lastMigrationStats;
        if (!stats) {
            console.log('Nothing to do: database was already at the current schema version.');
        } else {
            console.log('Migration complete:');
            for (const [key, value] of Object.entries(stats)) {
                console.log(`  ${key.padEnd(22)} ${value}`);
            }
        }
    }
} catch (error) {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
} finally {
    await db.shutdown().catch(() => {});
}
