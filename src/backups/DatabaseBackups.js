import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const BACKUP_RETENTION = Object.freeze({ startup: 14, hourly: 24 });
const worker = fileURLToPath(new URL('./worker.js', import.meta.url));
const idPattern = /^(startup|hourly|manual|pre-restore)-[0-9T.Z-]+-[a-f0-9-]{36}$/;
const failure = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

async function digest(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) { hash.update(chunk); }
    return hash.digest('hex');
}
async function sync(file) {
    const handle = await fs.open(file, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
}
async function exists(file) {
    try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') { return false; } throw error; }
}
export function runBackupWorker(action, source, destination = '') {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, action, source, destination], {
            stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' },
        });
        let output = '', errors = '';
        child.stdout.on('data', data => { output += data; });
        child.stderr.on('data', data => { errors = (errors + data).slice(-4096); });
        const timeout = setTimeout(() => child.kill('SIGKILL'), 30 * 60 * 1000);
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.on('close', (code, signal) => {
            clearTimeout(timeout);
            if (code !== 0) { reject(failure(`Database ${action} failed (${signal || `exit ${code}`}): ${errors.trim()}`, 500)); return; }
            try { resolve(JSON.parse(output)); } catch { reject(failure('Invalid backup worker response', 500)); }
        });
    });
}

/** LMDB-only, transaction-consistent checkpoints. No file backend is restored.
 * Legacy dated backups are deliberately never removed by this manager.
 * Callers must close every database handle before restore().
 */
export default class DatabaseBackups {
    #busy = false;
    constructor(dbPath, { backupPath = path.join(dbPath, 'backup'), retention = BACKUP_RETENTION } = {}) {
        this.dbPath = dbPath;
        this.backupPath = backupPath;
        this.retention = { ...retention };
    }
    async list() {
        let names;
        try { names = await fs.readdir(this.backupPath); } catch (error) { if (error.code === 'ENOENT') { return []; } throw error; }
        const result = [];
        for (const id of names.filter(name => idPattern.test(name))) {
            try {
                const manifest = JSON.parse(await fs.readFile(path.join(this.backupPath, id, 'manifest.json'), 'utf8'));
                if (manifest.format === 1 && manifest.id === id && manifest.verified === true) { result.push(manifest); }
            } catch { /* Incomplete/unrecognized folders are not restore candidates. */ }
        }
        return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    }
    async #exclusive(action) {
        if (this.#busy) { throw failure('A database backup or restore is already running'); }
        this.#busy = true;
        try { return await action(); } finally { this.#busy = false; }
    }
    async create(kind = 'manual') {
        return this.#exclusive(() => this.#create(kind));
    }
    async #create(kind) {
        if (!['startup', 'hourly', 'manual', 'pre-restore'].includes(kind)) { throw failure('Invalid backup kind', 400); }
        if (!await exists(path.join(this.dbPath, 'data.mdb'))) {
            if (kind === 'startup') { return null; } // First-ever start has no database yet.
            throw failure('No workspace database exists yet', 404);
        }
        const createdAt = new Date().toISOString();
        const id = `${kind}-${createdAt.replaceAll(':', '-')}-${randomUUID()}`;
        await fs.mkdir(this.backupPath, { recursive: true, mode: 0o700 });
        const staging = path.join(this.backupPath, `.pending-${id}`);
        await fs.mkdir(staging, { mode: 0o700 });
        try {
            await runBackupWorker('copy', this.dbPath, staging);
            const { datasets } = await runBackupWorker('verify', staging);
            const file = path.join(staging, 'data.mdb');
            const manifest = { format: 1, id, kind, createdAt, verified: true,
                bytes: (await fs.stat(file)).size, sha256: await digest(file), datasets };
            await fs.rm(path.join(staging, 'lock.mdb'), { force: true });
            await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
            await sync(file); await sync(path.join(staging, 'manifest.json')); await sync(staging);
            await fs.rename(staging, path.join(this.backupPath, id));
            await sync(this.backupPath);
            // Publish first. Never sacrifice a good checkpoint for a failed one.
            const keep = this.retention[kind];
            if (Number.isInteger(keep) && keep > 0) {
                const older = (await this.list()).filter(item => item.kind === kind).slice(keep);
                for (const item of older) { await fs.rm(path.join(this.backupPath, item.id), { recursive: true }); }
            }
            return manifest;
        } finally { await fs.rm(staging, { recursive: true, force: true }); }
    }
    async restore(id) {
        return this.#exclusive(async () => {
            if (!idPattern.test(id)) { throw failure('Invalid backup identifier', 400); }
            const manifest = (await this.list()).find(item => item.id === id);
            if (!manifest) { throw failure('Verified backup not found', 404); }
            const source = path.join(this.backupPath, id, 'data.mdb');
            // Validate a private copy, so the verified file is exactly what will
            // be installed, even if an external process changes the backup.
            const staging = await fs.mkdtemp(path.join(this.dbPath, '.restore-'));
            try {
                const target = path.join(staging, 'data.mdb');
                await fs.copyFile(source, target);
                if (await digest(target) !== manifest.sha256) { throw failure('Backup checksum mismatch; nothing was restored'); }
                const { datasets } = await runBackupWorker('verify', staging);
                if (JSON.stringify(datasets) !== JSON.stringify(manifest.datasets)) { throw failure('Backup dataset verification failed'); }
                // Refuse to overwrite a database that cannot itself be backed
                // up. Recovery of damaged databases remains an offline action.
                const preserved = await this.#create('pre-restore');
                // This marker survives crashes on either side of the atomic
                // rename. On next start, discard only derived search state.
                const marker = path.join(this.dbPath, 'restore-search.json');
                await fs.writeFile(marker, JSON.stringify({ backupId: id, preservedId: preserved.id }), { mode: 0o600 });
                await sync(marker); await sync(target); await sync(this.dbPath);
                await fs.rm(path.join(this.dbPath, 'lock.mdb'), { force: true });
                await fs.rename(target, path.join(this.dbPath, 'data.mdb'));
                await sync(this.dbPath);
                return { restoredId: id, preservedId: preserved.id };
            } finally { await fs.rm(staging, { recursive: true, force: true }); }
        });
    }
}
