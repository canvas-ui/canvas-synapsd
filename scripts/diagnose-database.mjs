#!/usr/bin/env node
// No server imports, startup hooks, source-data writes or backup retention.
// Native LMDB faults are contained in children so their signal stays visible.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const expectedStores = ['documents', 'metadata', 'internal', 'bitmaps', 'checksums', 'synapses', 'edges_fwd', 'edges_inv', 'edge_meta'];
const log = message => fs.writeSync(1, `${message}\n`);

function packageVersion(entry, name) {
    for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
        const pkg = path.join(dir, 'package.json');
        if (fs.existsSync(pkg)) {
            const value = JSON.parse(fs.readFileSync(pkg, 'utf8'));
            if (value.name === name) return value.version;
        }
        if (path.dirname(dir) === dir) return 'unknown';
    }
}

async function probe(dbPath, mode, backupTo, copyCheck = false) {
    const synapsd = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const dependencyRequire = createRequire(synapsd);
    const entry = dependencyRequire.resolve('lmdb');
    log(`Node ${process.version} ${process.platform}/${process.arch}; canvas-synapsd ${packageVersion(synapsd, 'canvas-synapsd')}; lmdb ${packageVersion(entry, 'lmdb')}`);
    log(`LMDB module: ${entry}`);
    const { open } = dependencyRequire('lmdb');
    const readOnly = !copyCheck;
    log(`OPEN environment, readOnly=${readOnly}, safeRestore=${mode === 'safe'}`);
    // safeRestore needs overlappingSync, which lmdb disables by default on
    // read-only opens. Exercise its real startup behavior only on fresh copies:
    // native recovery can rewrite metadata even before the first user write.
    const db = open({ path: dbPath, noSubdir: false, readOnly, maxDbs: 64, compression: true, cache: true,
        strictAsyncOrder: true, safeRestore: mode === 'safe', encoding: 'binary', keyEncoding: 'binary' });
    try {
        log('OPEN environment OK');
        log(`STATS environment ${JSON.stringify(db.getStats())}`);
        if (!backupTo || copyCheck) {
            // Discover every named store, including Stored's receipts, Trash and replica state.
            // Finish the root cursor before openDB renews the read transaction.
            const names = Array.from(db.getKeys(), key => key.toString('utf8').replace(/\0$/, ''));
            for (const name of new Set([...names, ...expectedStores])) {
                log(`OPEN dataset ${name}`);
                const store = db.openDB(name, { create: false });
                if (!store) { log(`MISSING dataset ${name}`); continue; }
                log(`OPEN dataset ${name} OK`);
                log(`STATS dataset ${name}`);
                log(`STATS dataset ${name} ${JSON.stringify(store.getStats())}`);
                let count = 0;
                for (const entry of store.getRange()) { void entry; count++; }
                if (count !== store.getStats().entryCount) throw new Error(`Incomplete dataset ${name}`);
                log(`SCAN dataset ${name} OK (${count} entries)`);
            }
        }
        if (backupTo) {
            // Never replace an existing backup or touch source retention.
            fs.mkdirSync(backupTo);
            log(`BACKUP compact -> ${backupTo}`);
            await db.backup(backupTo, true);
            log('BACKUP compact OK');
        }
    } finally {
        log('CLOSE environment');
        await db.close();
        log('CLOSE environment OK');
    }
}

function main(args) {
    if (!args.length || args.includes('--help')) {
        log(`Usage: node ${process.argv[1]} DB_DIRECTORY [--backup-to NEW_DIRECTORY | --copy-check-to NEW_DIRECTORY]`);
        log('Run with the workspace stopped. Default probes open datasets read-only.');
        log('Optional --backup-to adds isolated compact-copy probes in NEW_DIRECTORY/normal and /safe.');
        log('Read-only probes do not exercise safeRestore recovery because overlappingSync defaults off.');
        log('--copy-check-to copies data.mdb into NEW_DIRECTORY/{normal,safe}, then opens those copies writable');
        log('and compact-backs them up to {normal,safe}-compact. This tests actual safeRestore recovery on copies only.');
        log('Does not change data.mdb, run hooks, restore anything, or prune backups. LMDB manages its normal reader locks.');
        log('Scans all named stores without logging values. This checks readability, not application-level consistency.');
        return;
    }
    const [input, ...rest] = args;
    if (input.startsWith('--') || (rest.length && (rest.length !== 2 || !['--backup-to', '--copy-check-to'].includes(rest[0])))) {
        throw new Error('Expected DB_DIRECTORY and optional --backup-to or --copy-check-to NEW_DIRECTORY');
    }
    const dbPath = fs.realpathSync(input);
    const dataPath = path.join(dbPath, 'data.mdb');
    const stat = fs.statSync(dataPath);
    if (!stat.isFile() || stat.size === 0) throw new Error('Expected an existing, non-empty data.mdb');
    const output = rest.length ? path.resolve(rest[1]) : null;
    const copyCheck = rest[0] === '--copy-check-to';
    const backupTo = !copyCheck && output;
    if (output) fs.mkdirSync(output); // EEXIST is intentional: no overwrites.
    log(`Database: ${dbPath}; data.mdb: ${stat.size} bytes`);
    if (copyCheck) {
        // Copy only the stopped database's data file, never stale locks or the
        // backup tree. Prepare both independent inputs before native probing.
        for (const mode of ['normal', 'safe']) {
            const copyPath = path.join(output, mode);
            fs.mkdirSync(copyPath);
            fs.copyFileSync(dataPath, path.join(copyPath, 'data.mdb'), fs.constants.COPYFILE_EXCL);
            log(`COPY data.mdb -> ${copyPath}`);
        }
    } else {
        log('NOTE: read-only mode does not exercise safeRestore recovery (overlappingSync defaults off).');
    }
    let failed = false;
    for (const operation of copyCheck ? ['copy-check'] : backupTo ? ['datasets', 'backup'] : ['datasets']) {
        for (const mode of ['normal', 'safe']) {
            log(`\n=== ${operation} / ${mode} ===`);
            const childArgs = copyCheck
                ? ['--probe-copy', path.join(output, mode), mode, path.join(output, `${mode}-compact`)]
                : ['--probe', dbPath, mode, ...(operation === 'backup' ? [path.join(backupTo, mode)] : [])];
            const child = spawnSync(process.execPath, [filename, ...childArgs], {
                stdio: ['ignore', 'inherit', 'inherit'], timeout: 30000, killSignal: 'SIGKILL',
            });
            log(`RESULT ${operation}/${mode}: exit=${child.status ?? 'none'}, signal=${child.signal ?? 'none'}${child.error ? `, error=${child.error.message}` : ''}`);
            if (child.status !== 0 || child.signal || child.error) failed = true;
        }
    }
    log(copyCheck ? '\nCopy checks complete. Source data.mdb was not opened by LMDB; no original was repaired or replaced.'
        : '\nRead-only probes complete. No repair or restore was attempted.');
    process.exitCode = failed ? 1 : 0;
}

try {
    if (['--probe', '--probe-copy'].includes(process.argv[2])) {
        await probe(process.argv[3], process.argv[4], process.argv[5], process.argv[2] === '--probe-copy');
    } else {
        main(process.argv.slice(2));
    }
} catch (error) {
    fs.writeSync(2, `${error.stack || error}\n`);
    process.exitCode = 1;
}
