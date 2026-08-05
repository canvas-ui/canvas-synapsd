#!/usr/bin/env node
'use strict';

/**
 * migrate-schema-v3.js — Rev B id rename: `data/abstraction/*` -> `data/schema/*`.
 *
 *   node scripts/migrate-schema-v3.js -d <workspace-db-dir> [--hooks <hooks-dir>]
 *
 * ⚠️ RUN THIS BY HAND, AGAINST A BACKUP. Migration code does not live in the
 * engine (removed 2026-08-04); this script is the one-time operator action the
 * schema-version gate points at.
 *
 * What it does, in order:
 *   1. Opens the LMDB stores RAW (not through Db.start() — the version gate
 *      would refuse a v2 database) and rewrites `doc.schema` on every row
 *      through SCHEMA_ID_RENAMES (email -> message/email, todo -> task, the
 *      rest 1:1 into data/schema/).
 *   2. Rewrites id-bearing CONFIG that would otherwise fail silently:
 *      canvas/directory layer `querySpec.features` (saved stored-db views,
 *      persisted under `tree/<id>/layer/*` in the internal store) and, when a
 *      hooks dir is given/found, workspace hook rules (rules.json +
 *      rules/*.json — `when.schema` matchers and `then` document templates).
 *   3. Stamps `internal/schemaVersion = 3` — LAST, so a run that dies midway
 *      leaves the database still refused by the gate instead of half-migrated
 *      but openable. A crashed run is simply re-runnable.
 *   4. Reopens through Db and runs `rebuildL3({bitmaps, edges})` — drops
 *      `data/abstraction/*` residue, re-derives `data/schema/*` (hierarchy +
 *      subtype segments) and `feature/email/*` flags.
 *   5. `reindexSearchIndex({rebuild: true})` — owed independently since the
 *      FTS object-flattening fix; this is the designated moment.
 *
 * Idempotent: a database already stamped at v3 with no old-prefix rows or
 * config is reported as migrated and left untouched (steps 4–5 skipped; run
 * them directly via the engine if you need a rebuild). Each workspace is its
 * own DB — point -d at that workspace's db directory, e.g.
 *   server/users/<user>/workspaces/<workspace>/db
 */

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { open } from 'lmdb';
import { createRequire } from 'node:module';
const { RoaringBitmap32 } = createRequire(import.meta.url)('roaring');

import { SCHEMA_ID_RENAMES } from '../src/schemas/rename-map.js';

const TARGET_VERSION = 3;
const VERSION_KEY = 'internal/schemaVersion';
const OLD_PREFIX = 'data/abstraction/';

// ── Pre-v2 leg ───────────────────────────────────────────────────────────────
// Live dev databases turned out to still be at v1 (or unversioned) — the v2
// migration (#migrateToV3, deleted from the engine 2026-08-04) never ran on
// them. Its ROW work is folded in here for `applied < 2` databases:
//   - metadata.features -> root features[] (asserted-only; derived keys are
//     recomputed and would otherwise be un-untickable)
//   - recover asserted tags that exist ONLY in bitmaps (the one class of state
//     with no rebuild source — the entire reason features moved onto the row)
//   - drop per-row indexOptions (schema-level since v2)
//   - drop bitmap namespaces v2 retired that rebuildL3 does not know about
//     (rel/* -> dupsort edges, data/source/* -> folded into data/backend/*)
// Kind stamping is deliberately NOT reproduced: the axis was removed.

// Prefixes a row may legitimately ASSERT (everything else is derived state the
// rebuild recomputes). Mirrors normalizeFeatureArray minus per-schema facets.
const ASSERTED_KEY_RE = /^(tag\/|custom\/|client\/|data\/dataset\/|data\/no-location$)/;
const RECOVERY_PREFIXES = ['tag/', 'custom/', 'client/', 'data/dataset/'];
const PRE_V2_DROP_PREFIXES = ['rel/', 'data/source/'];

const OPTS = {
    db: { type: 'string', short: 'd' },
    hooks: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
};

function usage() {
    console.log(`migrate-schema-v3 — rename data/abstraction/* ids to data/schema/* (schema v${TARGET_VERSION})

Usage:
  node scripts/migrate-schema-v3.js -d <workspace-db-dir> [--hooks <hooks-dir>] [--dry-run]

Options:
  -d, --db <dir>     Path to the workspace SynapsD database directory (required)
      --hooks <dir>  Workspace hooks dir holding rules.json / rules/*.json
                     (default: <db-dir>/../hooks when it exists)
      --dry-run      Report what would change, write nothing
  -h, --help         Show this help
`);
}

// Rewrite one schema-id string; null when it needs no change.
const renameId = (value) =>
    (typeof value === 'string' && SCHEMA_ID_RENAMES[value]) ? SCHEMA_ID_RENAMES[value] : null;

// querySpec.features is a string array OR an {allOf,anyOf,noneOf} object.
function migrateFeatureSpec(features) {
    let changed = false;
    const mapArray = (arr) => arr.map((key) => {
        const next = renameId(key);
        if (next) { changed = true; return next; }
        return key;
    });

    if (Array.isArray(features)) {
        const next = mapArray(features);
        return changed ? next : null;
    }
    if (features && typeof features === 'object') {
        const next = { ...features };
        for (const bucket of ['allOf', 'anyOf', 'noneOf']) {
            if (Array.isArray(next[bucket])) { next[bucket] = mapArray(next[bucket]); }
        }
        return changed ? next : null;
    }
    return null;
}

// Deep-rewrite every string equal to an old id anywhere in a JSON document
// (hook rules carry ids in `when.schema`, `then[].schema`, feature arrays).
function migrateJsonDeep(node) {
    let changed = false;
    const walk = (value) => {
        const renamed = renameId(value);
        if (renamed) { changed = true; return renamed; }
        if (Array.isArray(value)) { return value.map(walk); }
        if (value && typeof value === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(value)) { out[k] = walk(v); }
            return out;
        }
        return value;
    };
    const result = walk(node);
    return changed ? result : null;
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

    const { db: dbDir, hooks, 'dry-run': dryRun, help } = parsed.values;
    if (help) { usage(); return; }
    if (!dbDir) {
        console.error('Error: -d/--db <workspace-db-dir> is required.');
        usage();
        process.exit(1);
    }

    const hooksDir = hooks ?? (fs.existsSync(path.join(dbDir, '..', 'hooks'))
        ? path.join(dbDir, '..', 'hooks')
        : null);

    // ── Raw pass: rows + config + stamp ──────────────────────────────────────
    const env = open({ path: dbDir, maxDbs: 64, compression: true });
    const documents = env.openDB('documents');
    const internal = env.openDB('internal');

    const applied = Number(internal.get(VERSION_KEY)) || 0;
    if (applied > TARGET_VERSION) {
        console.error(`Refusing: database is at schema v${applied}, newer than this script's target v${TARGET_VERSION}.`);
        await env.close();
        process.exit(1);
    }
    const preV2 = applied < 2;
    if (preV2) { console.log(`database is at schema v${applied} — running the pre-v2 row work too (features promotion + bitmap-tag recovery)`); }

    // Pre-v2: recover asserted tags living only in bitmaps, BEFORE the row pass.
    const assertedByDoc = new Map();
    let bitmapsDroppedRaw = 0;
    if (preV2) {
        const bitmaps = env.openDB('bitmaps');
        for (const { key, value } of bitmaps.getRange()) {
            if (typeof key !== 'string') { continue; }
            if (RECOVERY_PREFIXES.some((p) => key.startsWith(p))) {
                let roaring;
                try { roaring = RoaringBitmap32.deserialize(value, true); } catch { continue; }
                for (const id of roaring) {
                    if (!assertedByDoc.has(id)) { assertedByDoc.set(id, new Set()); }
                    assertedByDoc.get(id).add(key);
                }
            } else if (PRE_V2_DROP_PREFIXES.some((p) => key.startsWith(p))) {
                if (!dryRun) { bitmaps.removeSync(key); }
                bitmapsDroppedRaw++;
            }
        }
        console.log(`pre-v2: recovered asserted keys for ${assertedByDoc.size} docs, dropped ${bitmapsDroppedRaw} retired bitmaps (rel/, data/source/)`);
    }

    let rows = 0;
    let rowsChanged = 0;
    let featuresMoved = 0;
    let indexOptionsDropped = 0;
    const unknownOldIds = new Set();
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
        let row = value;
        let changed = false;

        const next = renameId(row.schema);
        if (next) { row = { ...row, schema: next }; changed = true; }
        else if (typeof row.schema === 'string' && row.schema.startsWith(OLD_PREFIX)) {
            unknownOldIds.add(row.schema);
        }

        if (preV2) {
            if (row === value) { row = { ...row }; }
            if (row.indexOptions !== undefined) { delete row.indexOptions; indexOptionsDropped++; changed = true; }
            const legacy = Array.isArray(row.metadata?.features) ? row.metadata.features : [];
            const recovered = assertedByDoc.get(Number(key));
            if (legacy.length > 0 || recovered || !Array.isArray(row.features)) {
                const before = Array.isArray(row.features) ? row.features : [];
                const merged = [...before, ...legacy, ...(recovered ? [...recovered] : [])];
                const seen = new Set();
                row.features = merged.filter((k) =>
                    typeof k === 'string' && ASSERTED_KEY_RE.test(k) && !seen.has(k) && seen.add(k));
                if (legacy.length > 0 || recovered) { featuresMoved++; }
                changed = true;
            }
            if (row.metadata && row.metadata.features !== undefined) {
                row.metadata = { ...row.metadata };
                delete row.metadata.features;
                changed = true;
            }
        }

        if (changed) {
            rowsChanged++;
            if (!dryRun) {
                batch.push([key, row]);
                if (batch.length >= BATCH) { flush(); }
            }
        }
        if (rows % 100000 === 0) { console.log(`  … ${rows} rows scanned`); }
    }
    if (!dryRun) { flush(); }
    if (unknownOldIds.size > 0) {
        console.error(`Refusing: rows carry old-prefix ids with no rename entry: ${[...unknownOldIds].join(', ')}`);
        await env.close();
        process.exit(1);
    }
    if (preV2) { console.log(`pre-v2: ${featuresMoved} rows had features promoted/recovered, ${indexOptionsDropped} indexOptions dropped`); }

    // Layer querySpec.features (canvas "stored db view" layers and directory
    // nodes persist under tree/<treeId>/layer/<layerId> in the internal store).
    let layersChanged = 0;
    for (const { key, value } of internal.getRange()) {
        if (typeof key !== 'string' || !/^tree\/.+\/layer\//.test(key)) { continue; }
        if (!value || typeof value !== 'object' || !value.querySpec) { continue; }
        const nextFeatures = migrateFeatureSpec(value.querySpec.features);
        if (nextFeatures) {
            if (!dryRun) {
                internal.putSync(key, {
                    ...value,
                    querySpec: { ...value.querySpec, features: nextFeatures },
                });
            }
            layersChanged++;
        }
    }

    // Workspace hook rules: rules.json + rules/*.json under the hooks dir.
    let ruleFilesChanged = 0;
    if (hooksDir) {
        const ruleFiles = [];
        const rootRules = path.join(hooksDir, 'rules.json');
        if (fs.existsSync(rootRules)) { ruleFiles.push(rootRules); }
        const rulesDir = path.join(hooksDir, 'rules');
        if (fs.existsSync(rulesDir)) {
            for (const entry of fs.readdirSync(rulesDir)) {
                if (entry.endsWith('.json')) { ruleFiles.push(path.join(rulesDir, entry)); }
            }
        }
        for (const filePath of ruleFiles) {
            let json;
            try { json = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) {
                console.warn(`  skipping unparseable rule file ${filePath}: ${e.message}`);
                continue;
            }
            const next = migrateJsonDeep(json);
            if (next) {
                if (!dryRun) { fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + '\n'); }
                ruleFilesChanged++;
            }
        }
    }

    const alreadyDone = applied === TARGET_VERSION && rowsChanged === 0 && layersChanged === 0 && ruleFilesChanged === 0;
    console.log(`rows: ${rows} scanned, ${rowsChanged} rewritten`);
    console.log(`layers: ${layersChanged} querySpecs rewritten`);
    console.log(`hook rules: ${ruleFilesChanged} files rewritten${hooksDir ? '' : ' (no hooks dir found — pass --hooks if the workspace has one)'}`);

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

    // Stamp LAST: a run that died before this line leaves the DB refused by the
    // version gate (correct — it is mid-migration), never half-migrated but open.
    internal.putSync(VERSION_KEY, TARGET_VERSION);
    await env.close();
    console.log(`stamped ${VERSION_KEY} = ${TARGET_VERSION}`);

    // ── Reopen through the engine: rebuild derived plane + FTS ───────────────
    // Lance stays ENABLED: the FTS index lives there, and reindexSearchIndex is
    // owed on migrated databases (the object-flattening fix changed indexed
    // content). Embeddings are NOT recomputed — no embedQuery is wired in.
    const { default: SynapsD } = await import('../src/index.js');
    const db = new SynapsD({
        path: dbDir,
        backupOnOpen: false,
        backupOnClose: false,
        compression: true,
    });
    await db.start();
    try {
        const stats = await db.rebuildL3({ bitmaps: true, edges: true });
        console.log(`rebuildL3: ${stats.documents} docs, ${stats.bitmapsDropped} stale bitmaps dropped, ${stats.edges} edges replayed`);
        try {
            const fts = await db.reindexSearchIndex({ rebuild: true });
            console.log(`reindexSearchIndex: ${JSON.stringify(fts)}`);
        } catch (e) {
            console.warn(`⚠️ FTS rebuild skipped (${e.message}) — run db.reindexSearchIndex({rebuild:true}) where Lance is available; the migration itself is complete.`);
        }
    } finally {
        await db.shutdown();
    }
    console.log('done.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
