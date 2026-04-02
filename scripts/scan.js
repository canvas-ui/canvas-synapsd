#!/usr/bin/env node
'use strict';

/**
 * scan.js — Recursively scan a directory into a SynapsD database, or query that DB.
 *
 * Usage:
 *   node scripts/scan.js <path> [options]              # ingest (path = directory to scan)
 *   node scripts/scan.js scan <path> [options]         # same
 *   node scripts/scan.js get <id> [--db DIR]
 *   node scripts/scan.js find [--tree T] [--features F] [--limit N] [--db DIR]
 *   node scripts/scan.js search <query> [...] [--db DIR]
 *   node scripts/scan.js tree [name] [--db DIR]
 *
 * Only ingest uses a filesystem path; queries use --db (default ./.db).
 *
 * Options:
 *   --exclude <glob>       Exclude files matching glob (repeatable; ingest only)
 *   --db <dir>             Database directory (default: ./.db)
 *   --tree <name>          Tree name for queries
 *   --features <f1,f2>     Comma-separated feature list
 *   --limit <n>            Max results
 *   --no-lance             Skip LanceDB indexing (ingest only)
 *
 * Examples:
 *   node scripts/scan.js ./my-project --exclude "*.pdf"
 *   node scripts/scan.js find --features data/abstraction/file --limit 50
 *   node scripts/scan.js search "invoice" --limit 20
 *   node scripts/scan.js tree
 *   node scripts/scan.js get 7
 *
 * Full CLI: scripts/scan.readme.md
 */

import { resolve, relative, dirname, basename, extname, join } from 'path';
import { createReadStream, statSync, readdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import SynapsD from '../src/index.js';

// ── Auto-excluded patterns (sockets, runtime, binary junk) ───────────────────

const AUTO_EXCLUDE_GLOBS = [
    '*.sock', '*.socket', '*.pid', '*.lock',
    '*.swp', '*.swo', '*~',
    '.DS_Store', 'Thumbs.db', 'desktop.ini',
    '.git/**', '.hg/**', '.svn/**',
    'node_modules/**', '__pycache__/**', '.cache/**',
    '*.o', '*.a', '*.so', '*.dylib', '*.dll', '*.exe',
];

/** Documents queued before flush; each flush runs putMany per directory path. */
const SCAN_PUT_BATCH = 64;

// ── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = argv.slice(2);
    const opts = {
        scanPath: null,
        command: 'scan',
        commandArg: null,
        excludes: [...AUTO_EXCLUDE_GLOBS],
        dbDir: null,
        treeName: null,
        features: null,
        limit: null,
        noLance: false,
    };

    const subcommands = new Set(['get', 'find', 'search', 'tree']);

    if (args.length === 0) {
        console.error('Usage: node scripts/scan.js <path> | scan <path> | get | find | search | tree ...');
        console.error('  Ingest needs a directory; queries use --db (default ./.db). See scripts/scan.readme.md');
        process.exit(1);
    }

    let i = 0;
    const head = args[0];

    if (head === 'scan') {
        opts.command = 'scan';
        if (args.length < 2 || args[1].startsWith('-')) {
            console.error('Usage: node scripts/scan.js scan <path> [options]');
            process.exit(1);
        }
        opts.scanPath = resolve(args[1]);
        i = 2;
    } else if (subcommands.has(head)) {
        opts.command = head;
        i = 1;
        if (i < args.length && !args[i].startsWith('-')) {
            opts.commandArg = args[i++];
        }
    } else if (!head.startsWith('-')) {
        opts.command = 'scan';
        opts.scanPath = resolve(head);
        i = 1;
        if (i < args.length && subcommands.has(args[i])) {
            console.error(
                'Query commands do not take a scan directory. Use e.g.\n' +
                `  node scripts/scan.js ${args[i]} ... [--db <dir>]\n` +
                '(Only ingest uses a path; omit it for find/search/get/tree.)',
            );
            process.exit(1);
        }
    } else {
        console.error('Usage: node scripts/scan.js <path> | scan <path> | get | find | search | tree ...');
        process.exit(1);
    }

    while (i < args.length) {
        const flag = args[i++];
        if (flag === '--exclude' && i < args.length) {
            opts.excludes.push(args[i++]);
        } else if (flag === '--db' && i < args.length) {
            opts.dbDir = resolve(args[i++]);
        } else if (flag === '--tree' && i < args.length) {
            opts.treeName = args[i++];
        } else if (flag === '--features' && i < args.length) {
            opts.features = args[i++].split(',').map(f => f.trim()).filter(Boolean);
        } else if (flag === '--limit' && i < args.length) {
            opts.limit = parseInt(args[i++], 10);
        } else if (flag === '--no-lance') {
            opts.noLance = true;
        } else {
            console.error(`Unknown flag: ${flag}`);
            process.exit(1);
        }
    }

    if (opts.command === 'scan' && !opts.scanPath) {
        console.error('Usage: node scripts/scan.js <path> [options]   or   node scripts/scan.js scan <path> [options]');
        process.exit(1);
    }

    if (!opts.dbDir) {
        opts.dbDir = resolve('.db');
    }

    return opts;
}

// ── Glob matching (minimatch-lite, no deps) ──────────────────────────────────

function globToRegex(glob) {
    let re = '';
    let i = 0;
    while (i < glob.length) {
        const c = glob[i++];
        if (c === '*') {
            if (glob[i] === '*') {
                i++;
                if (glob[i] === '/') { i++; }
                re += '(?:.+/)?';
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '.') {
            re += '\\.';
        } else {
            re += c;
        }
    }
    return new RegExp(`^${re}$`);
}

function isExcluded(relPath, excludePatterns) {
    for (const pattern of excludePatterns) {
        const re = globToRegex(pattern);
        if (re.test(relPath) || re.test(basename(relPath))) {
            return true;
        }
    }
    return false;
}

// ── File walking ─────────────────────────────────────────────────────────────

function walkSync(dir, rootDir, excludes) {
    const entries = [];
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return entries; }

    for (const item of items) {
        const fullPath = join(dir, item.name);
        const rel = relative(rootDir, fullPath);

        if (isExcluded(rel, excludes)) { continue; }

        if (item.isDirectory()) {
            entries.push(...walkSync(fullPath, rootDir, excludes));
        } else if (item.isFile()) {
            entries.push(fullPath);
        }
    }
    return entries;
}

// ── Checksum ─────────────────────────────────────────────────────────────────

function checksumFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(`sha256/${hash.digest('hex')}`));
        stream.on('error', reject);
    });
}

// ── MIME detection (uses `file` command, fast) ───────────────────────────────

const MIME_CACHE = new Map();

function detectMimeBatch(filePaths) {
    // `file --mime-type --files-from -` reads paths from stdin — safe with any filename
    const batchSize = 500;
    for (let i = 0; i < filePaths.length; i += batchSize) {
        const batch = filePaths.slice(i, i + batchSize);
        try {
            const out = execSync(
                `file --mime-type -F '|||' --files-from -`,
                { input: batch.join('\n'), maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
            );
            for (const line of out.trim().split('\n')) {
                const sep = line.lastIndexOf('|||');
                if (sep === -1) continue;
                const fp = line.slice(0, sep).trim();
                const mime = line.slice(sep + 3).trim();
                MIME_CACHE.set(fp, mime);
            }
        } catch {
            for (const p of batch) { MIME_CACHE.set(p, 'application/octet-stream'); }
        }
    }
}

function getMime(filePath) {
    return MIME_CACHE.get(filePath) || 'application/octet-stream';
}

// ── File stat ────────────────────────────────────────────────────────────────

function getFileStat(filePath) {
    try {
        const st = statSync(filePath);
        return { size: st.size, mtime: st.mtime.toISOString(), ctime: st.ctime.toISOString() };
    } catch {
        return { size: 0, mtime: null, ctime: null };
    }
}

// ── Pretty print helpers ─────────────────────────────────────────────────────

function printDoc(doc) {
    const d = typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
    console.log(JSON.stringify(d, null, 2));
}

function printResults(results) {
    console.log(`\n  ${results.totalCount} total, showing ${results.count}\n`);
    for (const doc of results) {
        const d = typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
        const name = d.data?.filename || d.data?.title || d.schema;
        console.log(`  [${d.id}] ${name}`);
    }
    console.log();
}

// ── Timer helper ─────────────────────────────────────────────────────────────

function elapsed(start) {
    const ms = performance.now() - start;
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const opts = parseArgs(process.argv);

    // Monkey-patch LanceIndex to skip if --no-lance
    if (opts.noLance) {
        const LanceIndex = (await import('../src/indexes/lance/index.js')).default;
        LanceIndex.prototype.initialize = async function () { /* noop */ };
        LanceIndex.prototype.upsert = async function () { /* noop */ };
        LanceIndex.prototype.backfill = async function () { /* noop */ };
    }

    const db = new SynapsD({
        path: opts.dbDir,
        backupOnOpen: false,
        backupOnClose: false,
        compression: true,
     });

    const t0 = performance.now();
    await db.start();
    console.log(`  db started (${elapsed(t0)})`);

    try {
        switch (opts.command) {
            case 'get':
                await cmdGet(db, opts);
                break;
            case 'find':
                await cmdFind(db, opts);
                break;
            case 'search':
                await cmdSearch(db, opts);
                break;
            case 'tree':
                await cmdTree(db, opts);
                break;
            case 'scan':
            default:
                await cmdScan(db, opts);
                break;
        }
    } finally {
        await db.shutdown();
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * Flush queued file docs: one LMDB txn via putManyDirectoryPaths when possible; Lance once per flush.
 */
async function flushScanPutBatch(db, treeName, batch, counters, noLance) {
    if (batch.length === 0) { return; }
    const docCount = batch.length;
    const tBatch = performance.now();
    counters.batchNo = (counters.batchNo ?? 0) + 1;
    const batchNo = counters.batchNo;

    const items = batch.map(({ treePath, document }) => ({ path: treePath, document }));
    batch.length = 0;
    const pathCount = new Set(items.map((i) => i.path)).size;

    const deferredLance = noLance ? null : [];

    let pathMsMax = 0;
    let pathMsSum = 0;
    let fallbackPaths = 0;
    let usedSingleTxn = false;

    try {
        await db.putManyDirectoryPaths(
            items,
            treeName,
            ['data/abstraction/file'],
            {
                emitEvent: false,
                skipLance: true,
                deferredLanceBuffer: deferredLance,
            },
        );
        counters.inserted += docCount;
        usedSingleTxn = true;
    } catch (err) {
        console.error(`\n  putManyDirectoryPaths failed, fallback per-path: ${err.message}`);
        const byPath = new Map();
        for (const { path: p, document } of items) {
            if (!byPath.has(p)) { byPath.set(p, []); }
            byPath.get(p).push(document);
        }
        for (const [treePath, documents] of byPath) {
            const tPath = performance.now();
            try {
                await db.putMany(
                    documents,
                    { tree: treeName, path: treePath },
                    ['data/abstraction/file'],
                    {
                        emitEvent: false,
                        skipLance: true,
                        deferredLanceBuffer: deferredLance,
                    },
                );
                counters.inserted += documents.length;
            } catch {
                fallbackPaths++;
                for (const document of documents) {
                    try {
                        await db.put(
                            document,
                            { tree: treeName, path: treePath },
                            ['data/abstraction/file'],
                            { emitEvent: false },
                        );
                        counters.inserted++;
                    } catch (e2) {
                        counters.errors++;
                        if (counters.errors <= 5) {
                            console.error(`\n  error: ${document?.data?.filename ?? '?'}: ${e2.message}`);
                        }
                    }
                }
            }
            const pathMs = performance.now() - tPath;
            pathMsSum += pathMs;
            if (pathMs > pathMsMax) { pathMsMax = pathMs; }
        }
    }

    if (deferredLance?.length) {
        const tL = performance.now();
        await db.indexDocumentsInLance(deferredLance);
        console.log(
            `  lance batch #${batchNo}: ${deferredLance.length} rows (${elapsed(tL)})`,
        );
    }

    const ms = performance.now() - tBatch;
    const rate = docCount / (ms / 1000);
    let detail;
    if (usedSingleTxn) {
        detail = `${docCount} docs, ${pathCount} path(s), single LMDB txn`;
    } else {
        const avgPath = pathCount ? (pathMsSum / pathCount).toFixed(1) : '0';
        detail = `${docCount} docs, ${pathCount} path(s), max(path) ${pathMsMax.toFixed(0)}ms, avg(path) ${avgPath}ms`;
        if (fallbackPaths) {
            detail += `, putMany→put fallback: ${fallbackPaths} path(s)`;
        }
    }
    console.log(
        `  insert batch #${batchNo}: ${detail}; batch wall ${elapsed(tBatch)} (~${rate.toFixed(0)} docs/s)`,
    );
}

async function cmdScan(db, opts) {
    const rootDir = opts.scanPath;
    if (!existsSync(rootDir)) {
        console.error(`Path does not exist: ${rootDir}`);
        process.exit(1);
    }

    // Ensure a directory tree for the scanned path
    const treeName = 'filesystem';
    let tree;
    try {
        tree = db.getTree(treeName);
        if (!tree) {
            await db.createTree(treeName, 'directory');
            tree = db.getTree(treeName);
        }
    } catch {
        tree = db.getTree(treeName);
    }

    console.log(`  LanceDB: ${opts.noLance ? 'disabled (--no-lance)' : 'enabled'}`);

    // Walk
    console.log(`  scanning ${rootDir} ...`);
    const t1 = performance.now();
    const files = walkSync(rootDir, rootDir, opts.excludes);
    console.log(`  found ${files.length} files (${elapsed(t1)})`);

    if (files.length === 0) { return; }

    // Batch MIME detection
    const t2 = performance.now();
    detectMimeBatch(files);
    console.log(`  mime detection done (${elapsed(t2)})`);

    // Batch size
    console.log(`  batch size: ${SCAN_PUT_BATCH}`);

    // Ingest
    const t3 = performance.now();
    const counters = { inserted: 0, skipped: 0, errors: 0, batchNo: 0 };
    const pending = [];

    const logInterval = Math.max(100, Math.min(5000, Math.floor(files.length / 20)));

    const progress = () => {
        const { inserted, skipped, errors } = counters;
        const done = inserted + skipped + errors + pending.length;
        if (done % logInterval === 0) {
            process.stdout.write(`\r  processed ${done}/${files.length} (${inserted} new, ${skipped} skipped)`);
        }
    };

    for (const filePath of files) {
        try {
            const rel = relative(rootDir, filePath);
            const dirPath = '/' + dirname(rel).replace(/\\/g, '/');
            const treePath = dirPath === '/.' ? '/' : dirPath;
            const stat = getFileStat(filePath);
            const mime = getMime(filePath);
            const checksum = await checksumFile(filePath);

            // Skip if already stored with same checksum
            const existing = await db.getByChecksumString(checksum).catch(() => null);
            if (existing) {
                counters.skipped++;
                progress();
                continue;
            }

            pending.push({
                treePath,
                document: {
                    schema: 'data/abstraction/file',
                    data: {
                        filename: basename(filePath),
                        size: stat.size,
                        mime,
                    },
                    metadata: {
                        dataPaths: [`file://${filePath}`],
                    },
                    checksumArray: [checksum],
                },
            });
            if (pending.length >= SCAN_PUT_BATCH) {
                await flushScanPutBatch(db, treeName, pending, counters, opts.noLance);
            }
            progress();
        } catch (err) {
            counters.errors++;
            if (counters.errors <= 5) {
                console.error(`\n  error: ${basename(filePath)}: ${err.message}`);
            }
            progress();
        }
    }

    await flushScanPutBatch(db, treeName, pending, counters, opts.noLance);

    const { inserted, skipped, errors } = counters;
    const totalTime = elapsed(t3);
    const rate = ((inserted + skipped) / ((performance.now() - t3) / 1000)).toFixed(0);
    console.log(`\r  done: ${inserted} inserted, ${skipped} skipped, ${errors} errors (${totalTime}, ~${rate} docs/s)`);
    console.log(`  db stats: ${JSON.stringify(db.stats)}`);
}

async function cmdGet(db, opts) {
    const id = parseInt(opts.commandArg, 10);
    if (!id) {
        console.error('Usage: node scripts/scan.js get <id> [--db <dir>]');
        process.exit(1);
    }
    const doc = await db.get(id);
    if (!doc) {
        console.error(`Document ${id} not found`);
        process.exit(1);
    }
    printDoc(doc);
}

async function cmdFind(db, opts) {
    const spec = {};
    if (opts.treeName) { spec.tree = opts.treeName; }
    if (opts.features) { spec.features = opts.features; }
    if (opts.limit) { spec.limit = opts.limit; }
    const t = performance.now();
    const results = await db.find(spec);
    console.log(`  find completed (${elapsed(t)})`);
    printResults(results);
}

async function cmdSearch(db, opts) {
    const query = opts.commandArg;
    if (!query) {
        console.error('Usage: node scripts/scan.js search <query> [--tree T] [--limit N] [--db <dir>]');
        process.exit(1);
    }
    const spec = { query };
    if (opts.treeName) { spec.tree = opts.treeName; }
    if (opts.features) { spec.features = opts.features; }
    if (opts.limit) { spec.limit = opts.limit; }
    const t = performance.now();
    const results = await db.search(spec);
    console.log(`  search completed (${elapsed(t)})`);
    printResults(results);
}

async function cmdTree(db, opts) {
    const treeName = opts.commandArg || opts.treeName;
    if (treeName) {
        const tree = db.getTree(treeName);
        if (!tree) {
            console.error(`Tree not found: ${treeName}`);
            process.exit(1);
        }
        console.log(JSON.stringify(tree.buildJsonTree(), null, 2));
    } else {
        // List all trees
        const trees = await db.listTrees();
        for (const meta of trees) {
            const tree = db.getTree(meta.id);
            const pathCount = tree?.paths?.length ?? '?';
            console.log(`  [${meta.type}] ${meta.name} (${pathCount} paths)`);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
