#!/usr/bin/env node
'use strict';

/**
 * scan.js — Recursively scan a directory into a SynapsD database, or query that DB.
 *
 *   scan [options] <command> [arguments]
 *
 * Full reference: scripts/scan.readme.md
 */

import { resolve, relative, dirname, basename, join } from 'path';
import { createReadStream, statSync, readdirSync, existsSync, appendFileSync, readFileSync } from 'fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

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
const SCAN_PUT_BATCH = 4096;

/** Default directory tree name used when --tree is not specified. */
const SCAN_DEFAULT_TREE = 'filesystem';

const VERSION = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
).version;

// ── CLI ──────────────────────────────────────────────────────────────────────

const DB_OPT = { db: { type: 'string', short: 'd', default: '.db', desc: 'Database directory' } };
const HELP_OPT = { help: { type: 'boolean', short: 'h', default: false } };
const GLOBAL_OPTS = { ...DB_OPT, ...HELP_OPT, version: { type: 'boolean', short: 'V', default: false } };

function splitFeatures(raw) {
    return raw?.split(',').map((f) => f.trim()).filter(Boolean) ?? null;
}

function parseLimit(raw) {
    if (raw == null) { return null; }
    const n = parseInt(raw, 10);
    if (isNaN(n)) { cliFail('--limit must be a number'); }
    return n;
}

const COMMANDS = {
    scan: {
        desc: 'Walk a directory and ingest files',
        usage: 'scan [options] [path]',
        args: 'path',
        options: {
            ...DB_OPT,
            ...HELP_OPT,
            path: { type: 'string', short: 'p', desc: 'Directory to ingest' },
            tree: { type: 'string', short: 't', default: SCAN_DEFAULT_TREE, desc: 'Tree name' },
            exclude: { type: 'string', short: 'e', multiple: true, desc: 'Extra glob to skip (repeatable)' },
            'no-lance': { type: 'boolean', default: false, desc: 'Skip LanceDB indexing' },
        },
        build(values, positionals) {
            const scanPath = values.path ?? positionals[0];
            if (!scanPath) { cliFail('scan requires a directory (positional or --path)'); }
            return {
                command: 'scan',
                scanPath: resolve(scanPath),
                treeName: values.tree,
                dbDir: resolve(values.db),
                excludes: [...AUTO_EXCLUDE_GLOBS, ...(values.exclude ?? [])],
                noLance: values['no-lance'],
            };
        },
    },
    get: {
        desc: 'Retrieve a document by numeric ID',
        usage: 'get [options] <id>',
        args: 'id',
        options: { ...DB_OPT, ...HELP_OPT },
        build(values, positionals) {
            const raw = positionals[0];
            if (!raw) { cliFail('get requires <id>'); }
            const id = parseInt(raw, 10);
            if (isNaN(id)) { cliFail('<id> must be a number'); }
            return { command: 'get', id, dbDir: resolve(values.db) };
        },
    },
    find: {
        desc: 'List and filter documents',
        usage: 'find [options]',
        options: {
            ...DB_OPT,
            ...HELP_OPT,
            tree: { type: 'string', short: 't', desc: 'Filter by tree name' },
            path: { type: 'string', desc: 'Filter by tree path' },
            features: { type: 'string', short: 'f', desc: 'Comma-separated schema filters' },
            limit: { type: 'string', short: 'l', desc: 'Max results' },
        },
        build(values) {
            return {
                command: 'find',
                treeName: values.tree ?? null,
                treePath: values.path ?? null,
                features: splitFeatures(values.features),
                limit: parseLimit(values.limit),
                dbDir: resolve(values.db),
            };
        },
    },
    search: {
        desc: 'Full-text search documents',
        usage: 'search [options] [query...]',
        args: 'query...',
        options: {
            ...DB_OPT,
            ...HELP_OPT,
            query: { type: 'string', short: 'q', desc: 'Search query' },
            tree: { type: 'string', short: 't', desc: 'Filter by tree name' },
            path: { type: 'string', desc: 'Filter by tree path' },
            features: { type: 'string', short: 'f', desc: 'Comma-separated schema filters' },
            limit: { type: 'string', short: 'l', desc: 'Max results' },
        },
        build(values, positionals) {
            const query = values.query ?? positionals.join(' ');
            if (!query) { cliFail('search requires a query (positional or -q)'); }
            return {
                command: 'search',
                query,
                treeName: values.tree ?? null,
                treePath: values.path ?? null,
                features: splitFeatures(values.features),
                limit: parseLimit(values.limit),
                dbDir: resolve(values.db),
            };
        },
    },
    tree: {
        desc: 'Dump a tree as JSON, or list all trees',
        usage: 'tree [options] [name]',
        args: 'name',
        options: {
            ...DB_OPT,
            ...HELP_OPT,
            name: { type: 'string', short: 'n', desc: 'Tree to dump (omit to list all)' },
        },
        build(values, positionals) {
            return {
                command: 'tree',
                treeName: values.name ?? positionals[0] ?? null,
                dbDir: resolve(values.db),
            };
        },
    },
};

function cliFail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

function formatOptions(options) {
    const lines = [];
    for (const [key, spec] of Object.entries(options)) {
        if (key === 'help') { continue; }
        const long = spec.short ? `-${spec.short}, --${key}` : `--${key}`;
        const pad = long.padEnd(22);
        const extra = spec.default != null && spec.type !== 'boolean'
            ? ` (default: ${spec.default})`
            : '';
        lines.push(`  ${pad}${spec.desc ?? ''}${extra}`);
    }
    return lines;
}

function formatHelp(command) {
    if (!command) {
        return [
            `scan v${VERSION} — SynapsD directory scanner and query tool`,
            '',
            'Usage: scan [options] <command> [arguments]',
            '',
            'Options:',
            '  -d, --db <dir>        Database directory (default: ./.db)',
            '  -h, --help            Show help',
            '  -V, --version         Show version',
            '',
            'Commands:',
            ...Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(12)}${spec.desc}`),
            '',
            'Run `scan <command> --help` for command-specific options.',
        ].join('\n');
    }

    const spec = COMMANDS[command];
    if (!spec) { cliFail(`Unknown command: ${command}`); }

    const lines = [
        `Usage: scan ${spec.usage}`,
        '',
        spec.desc + '.',
    ];
    if (spec.args) {
        lines.push('', 'Arguments:', `  ${spec.args}`);
    }
    lines.push('', 'Options:', ...formatOptions(spec.options));
    return lines.join('\n');
}

function parseArgv(argv) {
    const args = argv.slice(2);
    if (args.length === 0) { return { help: true }; }

    const cmdIdx = args.findIndex((a) => !a.startsWith('-') && COMMANDS[a]);
    if (cmdIdx === -1) {
        try {
            const { values } = parseArgs({ args, options: GLOBAL_OPTS, allowPositionals: true, strict: true });
            if (values.version) { return { version: true }; }
        } catch (err) {
            cliFail(err.message);
        }
        return { help: true };
    }

    const command = args[cmdIdx];
    const spec = COMMANDS[command];
    const rest = [...args.slice(0, cmdIdx), ...args.slice(cmdIdx + 1)];

    try {
        const { values, positionals } = parseArgs({
            args: rest,
            options: { ...GLOBAL_OPTS, ...spec.options },
            allowPositionals: true,
            strict: true,
        });
        if (values.version) { return { version: true }; }
        if (values.help) { return { help: true, command }; }
        return spec.build(values, positionals);
    } catch (err) {
        cliFail(err.message);
    }
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

function* walkGen(dir, rootDir, excludes) {
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        let items;
        try { items = readdirSync(current, { withFileTypes: true }); } catch { continue; }
        for (const item of items) {
            const fullPath = join(current, item.name);
            const rel = relative(rootDir, fullPath);
            if (isExcluded(rel, excludes)) { continue; }
            if (item.isDirectory()) {
                stack.push(fullPath);
            } else if (item.isFile()) {
                yield fullPath;
            }
        }
    }
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
    const parsed = parseArgv(process.argv);
    if (parsed.help) {
        console.log(formatHelp(parsed.command));
        return;
    }
    if (parsed.version) {
        console.log(VERSION);
        return;
    }
    const opts = parsed;

    // Monkey-patch LanceIndex to skip if --no-lance
    if (opts.noLance) {
        const LanceIndex = (await import('../src/indexes/lance/index.js')).default;
        LanceIndex.prototype.initialize = async function () { /* noop */ };
        LanceIndex.prototype.upsert = async function () { /* noop */ };
        LanceIndex.prototype.backfill = async function () { /* noop */ };
    }

    const { default: SynapsD } = await import('../src/index.js');
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
    const treeName = opts.treeName ?? SCAN_DEFAULT_TREE;
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

    const errorLogPath = join(opts.dbDir, 'errors.log');
    const logError = (filePath, kind, err) => {
        const line = `${new Date().toISOString()} [${kind}] ${filePath}: ${err.message}\n`;
        try { appendFileSync(errorLogPath, line); } catch { /* best-effort */ }
    };

    console.log(`  LanceDB: ${opts.noLance ? 'disabled (--no-lance)' : 'enabled'}`);
    console.log(`  scanning ${rootDir} ...`);
    console.log(`  batch size: ${SCAN_PUT_BATCH}`);
    console.log(`  error log: ${errorLogPath}`);

    const MIME_CHUNK = 500;
    const LOG_EVERY = 1000;

    const t3 = performance.now();
    const counters = { inserted: 0, updated: 0, skipped: 0, errors: 0, batchNo: 0, total: 0 };
    const pending = [];

    const progress = () => {
        if (counters.total % LOG_EVERY === 0) {
            const { inserted, updated, skipped, errors, total } = counters;
            process.stdout.write(`\r  processed ${total} (${inserted} new, ${updated} updated, ${skipped} skipped, ${errors} errors)`);
        }
    };

    const walker = walkGen(rootDir, rootDir, opts.excludes);
    let done = false;

    while (!done) {
        // Collect a chunk of files for MIME detection
        const chunk = [];
        while (chunk.length < MIME_CHUNK) {
            const { value, done: iterDone } = walker.next();
            if (iterDone) { done = true; break; }
            chunk.push(value);
        }
        if (chunk.length === 0) { break; }

        detectMimeBatch(chunk);

        for (const filePath of chunk) {
            counters.total++;
            try {
                const rel = relative(rootDir, filePath);
                const dirPath = '/' + dirname(rel).replace(/\\/g, '/');
                const treePath = dirPath === '/.' ? '/' : dirPath;
                const stat = getFileStat(filePath);
                const mime = getMime(filePath);
                const checksum = await checksumFile(filePath);

                // If already stored with same checksum, add this path to locations if not present
                const existing = await db.getByChecksumString(checksum).catch(() => null);
                if (existing) {
                    const uri = `file://${filePath}`;
                    const existingLocations = existing.locations ?? [];
                    if (existingLocations.some((l) => l.url === uri)) {
                        counters.skipped++;
                    } else {
                        const doc = existing.toJSON();
                        doc.locations = [...existingLocations, { url: uri }];
                        await db.put(doc, { tree: treeName, path: treePath }, ['data/abstraction/file'], { emitEvent: false }).catch((err) => {
                            counters.errors++;
                            logError(filePath, 'update', err);
                        });
                        counters.updated++;
                    }
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
                        locations: [{ url: `file://${filePath}` }],
                        checksumArray: [checksum],
                    },
                });
                if (pending.length >= SCAN_PUT_BATCH) {
                    await flushScanPutBatch(db, treeName, pending, counters, opts.noLance);
                }
                progress();
            } catch (err) {
                counters.errors++;
                logError(filePath, 'scan', err);
                progress();
            }
        }
    }

    await flushScanPutBatch(db, treeName, pending, counters, opts.noLance);

    const { inserted, updated, skipped, errors, total } = counters;
    const totalTime = elapsed(t3);
    const rate = ((inserted + updated + skipped) / ((performance.now() - t3) / 1000)).toFixed(0);
    console.log(`\r  done: ${total} files, ${inserted} inserted, ${updated} updated, ${skipped} skipped, ${errors} errors (${totalTime}, ~${rate} docs/s)`);

    if (!opts.noLance && (inserted + updated) > 0) {
        const tOpt = performance.now();
        process.stdout.write('  optimizing lance index ...');
        const stats = await db.optimizeLance();
        const compacted = stats?.compaction?.fragmentsRemoved ?? 0;
        console.log(`\r  lance optimized: ${compacted} fragments compacted (${elapsed(tOpt)})`);
    }

    console.log(`  db stats: ${JSON.stringify(db.stats)}`);
}

async function cmdGet(db, opts) {
    const doc = await db.get(opts.id);
    if (!doc) {
        console.error(`Document ${opts.id} not found`);
        process.exit(1);
    }
    printDoc(doc);
}

async function cmdFind(db, opts) {
    const spec = {};
    if (opts.treeName) { spec.tree = opts.treeName; }
    if (opts.treePath) { spec.path = opts.treePath; }
    if (opts.features) { spec.features = opts.features; }
    if (opts.limit) { spec.limit = opts.limit; }
    const t = performance.now();
    const results = await db.list(spec);
    console.log(`  list completed (${elapsed(t)})`);
    printResults(results);
}

async function cmdSearch(db, opts) {
    const spec = { query: opts.query };
    if (opts.treeName) { spec.tree = opts.treeName; }
    if (opts.treePath) { spec.path = opts.treePath; }
    if (opts.features) { spec.features = opts.features; }
    if (opts.limit) { spec.limit = opts.limit; }
    const t = performance.now();
    const results = await db.search(spec);
    console.log(`  search completed (${elapsed(t)})`);
    printResults(results);
}

async function cmdTree(db, opts) {
    const treeName = opts.treeName;
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
