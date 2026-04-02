#!/usr/bin/env node
'use strict';

/**
 * scan.js — Recursively scan a directory into a SynapsD database.
 *
 * Usage:
 *   node scripts/scan.js <path> [options]          # ingest files
 *   node scripts/scan.js <path> get <id>            # retrieve a document
 *   node scripts/scan.js <path> find [--tree T] [--features F] [--limit N]
 *   node scripts/scan.js <path> search <query> [--tree T] [--features F] [--limit N]
 *   node scripts/scan.js <path> tree [name]         # JSON tree dump
 *
 * Options:
 *   --exclude <glob>       Exclude files matching glob (repeatable)
 *   --db <dir>             Database directory (default: ./.db)
 *   --tree <name>          Tree name for queries (default: default directory tree)
 *   --features <f1,f2>     Comma-separated feature list
 *   --limit <n>            Max results
 *   --no-lance             Skip LanceDB indexing (much faster writes)
 *
 * Examples:
 *   node scripts/scan.js ./my-project --exclude "*.pdf" --exclude "node_modules/**"
 *   node scripts/scan.js ./my-project find --features data/abstraction/file --limit 50
 *   node scripts/scan.js ./my-project search "invoice" --limit 20
 *   node scripts/scan.js ./my-project tree filesystem
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

// ── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = argv.slice(2);
    const opts = {
        scanPath: null,
        command: 'scan',       // scan | get | find | search | tree
        commandArg: null,      // id for get, query for search, name for tree
        excludes: [...AUTO_EXCLUDE_GLOBS],
        dbDir: null,
        treeName: null,
        features: null,
        limit: null,
        noLance: false,
    };

    let i = 0;

    // First positional = path
    if (args.length > 0 && !args[0].startsWith('-')) {
        opts.scanPath = resolve(args[0]);
        i = 1;
    }

    // Second positional = command
    const commands = new Set(['get', 'find', 'search', 'tree']);
    if (i < args.length && commands.has(args[i])) {
        opts.command = args[i++];
        // Command argument (id / query / tree name)
        if (i < args.length && !args[i].startsWith('-')) {
            opts.commandArg = args[i++];
        }
    }

    // Flags
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

    if (!opts.scanPath) {
        console.error('Usage: node scripts/scan.js <path> [command] [options]');
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

    const db = new SynapsD({ path: opts.dbDir });

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

    // Ingest
    const t3 = performance.now();
    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    const logInterval = Math.max(100, Math.min(5000, Math.floor(files.length / 20)));

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
                skipped++;
                if ((inserted + skipped) % logInterval === 0) {
                    process.stdout.write(`\r  processed ${inserted + skipped + errors}/${files.length} (${inserted} new, ${skipped} skipped)`);
                }
                continue;
            }

            await db.put(
                {
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
                { tree: treeName, path: treePath },
                ['data/abstraction/file'],
                { emitEvent: false },
            );
            inserted++;
        } catch (err) {
            errors++;
            if (errors <= 5) {
                console.error(`\n  error: ${basename(filePath)}: ${err.message}`);
            }
        }

        if ((inserted + skipped + errors) % logInterval === 0) {
            process.stdout.write(`\r  processed ${inserted + skipped + errors}/${files.length} (${inserted} new, ${skipped} skipped)`);
        }
    }

    const totalTime = elapsed(t3);
    const rate = ((inserted + skipped) / ((performance.now() - t3) / 1000)).toFixed(0);
    console.log(`\r  done: ${inserted} inserted, ${skipped} skipped, ${errors} errors (${totalTime}, ~${rate} docs/s)`);
    console.log(`  db stats: ${JSON.stringify(db.stats)}`);
}

async function cmdGet(db, opts) {
    const id = parseInt(opts.commandArg, 10);
    if (!id) {
        console.error('Usage: scan.js <path> get <id>');
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
        console.error('Usage: scan.js <path> search <query> [--tree T] [--limit N]');
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
