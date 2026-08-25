#!/usr/bin/env node
'use strict';

/**
 * migrate-schema-v4.js — fold `data.type` into the schema id.
 *
 *   node scripts/migrate-schema-v4.js -d <workspace-db-dir> [--dry-run]
 *
 * ⚠️ RUN THIS BY HAND, AGAINST A BACKUP. A v3 database will refuse to open on
 * this build until this script stamps v4.
 *
 * Event / Application / Dotfile: parent is not writable; `data.type` becomes
 * the leaf (`data/schema/event/calendar`). Identity: parent stays writable;
 * a present type still folds into the id.
 *
 * Device `data.type`, Identity `identifiers[].type`, Message attachments, etc.
 * are unrelated and left alone.
 *
 * Stamp LAST, then reopen and `rebuildL3()` so child bitmap keys exist.
 */

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { open } from 'lmdb';

const TARGET_VERSION = 4;
const VERSION_KEY = 'internal/schemaVersion';

const FAMILIES = {
    'data/schema/event': {
        leaves: new Set(['calendar', 'alert', 'activity']),
        parentWritable: false,
    },
    'data/schema/identity': {
        leaves: new Set(['person', 'organization', 'service', 'bot']),
        parentWritable: true,
    },
    'data/schema/application': {
        leaves: new Set(['appimage', 'flatpak', 'snap', 'portable', 'system', 'local']),
        parentWritable: false,
    },
    'data/schema/dotfile': {
        leaves: new Set(['file', 'folder']),
        parentWritable: false,
    },
};

const OPTS = {
    db: { type: 'string', short: 'd' },
    'users-root': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
};

function usage() {
    console.log(`migrate-schema-v4 — fold data.type into the schema id (schema v${TARGET_VERSION})

Usage:
  node scripts/migrate-schema-v4.js -d <workspace-db-dir> [--dry-run]
  node scripts/migrate-schema-v4.js --users-root <server-users-dir> [--dry-run]

Options:
  -d, --db <dir>         Path to ONE workspace SynapsD database directory
      --users-root <dir> Migrate EVERY workspace found under a server users dir
      --dry-run          Report what would change, write nothing
  -h, --help             Show this help
`);
}

function familyOf(schema) {
    if (typeof schema !== 'string') { return null; }
    if (FAMILIES[schema]) { return { parentId: schema, leaf: null, spec: FAMILIES[schema] }; }
    for (const parentId of Object.keys(FAMILIES)) {
        if (schema.startsWith(`${parentId}/`)) {
            return { parentId, leaf: schema.slice(parentId.length + 1), spec: FAMILIES[parentId] };
        }
    }
    return null;
}

function migrateRow(value) {
    const family = familyOf(value?.schema);
    if (!family) { return null; }

    const type = typeof value.data?.type === 'string' ? value.data.type.trim() : '';
    const next = { ...value, data: { ...(value.data || {}) } };
    delete next.data.type;
    let schema = value.schema;

    if (family.leaf) {
        if (!family.spec.leaves.has(family.leaf)) {
            throw new Error(`${value.schema} is not a known leaf of ${family.parentId}`);
        }
    } else if (type && family.spec.leaves.has(type)) {
        schema = `${family.parentId}/${type}`;
    } else if (type) {
        throw new Error(`${value.schema} has unknown data.type ${JSON.stringify(type)}`);
    } else if (!family.spec.parentWritable) {
        throw new Error(`${value.schema} has no data.type and the parent id is not writable`);
    }

    next.schema = schema;
    const stripped = value.data && Object.prototype.hasOwnProperty.call(value.data, 'type');
    if (schema === value.schema && !stripped) { return null; }
    return next;
}

async function migrateDatabase(dbDir, dryRun) {
    const env = open({ path: dbDir, maxDbs: 64, compression: true });
    const documents = env.openDB('documents');
    const internal = env.openDB('internal');

    const applied = Number(internal.get(VERSION_KEY)) || 0;
    if (applied > TARGET_VERSION) {
        await env.close();
        throw new Error(`database is at schema v${applied}, newer than this script's target v${TARGET_VERSION}`);
    }
    if (applied > 0 && applied < 3) {
        await env.close();
        throw new Error(`database is at schema v${applied}; run scripts/migrate-schema-v3.js first`);
    }

    let rows = 0;
    let rowsChanged = 0;
    const BATCH = 2000;
    let batch = [];
    const flush = () => {
        if (batch.length === 0) { return; }
        const entries = batch;
        batch = [];
        documents.transactionSync(() => {
            for (const [key, row] of entries) { documents.putSync(key, row); }
        });
    };

    for (const { key, value } of documents.getRange()) {
        rows++;
        if (!value || typeof value !== 'object') { continue; }
        let next;
        try { next = migrateRow(value); } catch (e) {
            await env.close();
            throw new Error(`doc ${key}: ${e.message}`);
        }
        if (!next) { continue; }
        rowsChanged++;
        if (!dryRun) {
            batch.push([key, next]);
            if (batch.length >= BATCH) { flush(); }
        }
        if (rows % 100000 === 0) { console.log(`  … ${rows} rows scanned`); }
    }
    if (!dryRun) { flush(); }

    const alreadyDone = applied === TARGET_VERSION && rowsChanged === 0;
    console.log(`rows: ${rows} scanned, ${rowsChanged} rewritten`);

    if (dryRun) {
        console.log('dry run — nothing written, version not stamped.');
        await env.close();
        return;
    }
    if (alreadyDone) {
        console.log(`already at schema v${TARGET_VERSION} with nothing to rewrite — done.`);
        await env.close();
        return;
    }

    internal.putSync(VERSION_KEY, TARGET_VERSION);
    await env.close();
    console.log(`stamped ${VERSION_KEY} = ${TARGET_VERSION}`);

    const { default: SynapsD } = await import('../src/index.js');
    const db = new SynapsD({ path: dbDir, backupOnOpen: false, backupOnClose: false, compression: true });
    await db.start();
    try {
        const stats = await db.rebuildL3({ bitmaps: true, edges: true });
        console.log(`rebuildL3: ${stats.documents} docs, ${stats.bitmapsDropped} stale bitmaps dropped, ${stats.edges} edges replayed`);
    } finally {
        await db.shutdown();
    }
    console.log('done.');
}

function discoverDatabases(usersRoot) {
    const found = [];
    for (const user of fs.readdirSync(usersRoot, { withFileTypes: true })) {
        if (!user.isDirectory()) { continue; }
        for (const bucket of ['workspaces', 'Workspaces', 'agents']) {
            const bucketPath = path.join(usersRoot, user.name, bucket);
            if (!fs.existsSync(bucketPath)) { continue; }
            for (const ws of fs.readdirSync(bucketPath, { withFileTypes: true })) {
                if (!ws.isDirectory()) { continue; }
                const dbDir = path.join(bucketPath, ws.name, 'db');
                if (fs.existsSync(path.join(dbDir, 'data.mdb'))) { found.push(dbDir); }
            }
        }
    }
    return found;
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

    const { db: dbDir, 'users-root': usersRoot, 'dry-run': dryRun, help } = parsed.values;
    if (help) { usage(); return; }
    if (!dbDir && !usersRoot) {
        console.error('Error: either -d/--db <workspace-db-dir> or --users-root <server-users-dir> is required.');
        usage();
        process.exit(1);
    }

    if (dbDir) {
        await migrateDatabase(dbDir, dryRun);
        return;
    }

    const targets = discoverDatabases(usersRoot);
    console.log(`found ${targets.length} workspace database(s) under ${usersRoot}\n`);
    const failures = [];
    for (const target of targets) {
        console.log(`━━ ${target}`);
        try {
            await migrateDatabase(target, dryRun);
        } catch (error) {
            console.error(`✖ FAILED: ${error.message}`);
            failures.push({ target, message: error.message });
        }
        console.log('');
    }
    if (failures.length > 0) {
        console.error(`${failures.length} of ${targets.length} database(s) failed:`);
        for (const f of failures) { console.error(`  - ${f.target}: ${f.message}`); }
        process.exit(1);
    }
    console.log(`all ${targets.length} database(s) migrated.`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
