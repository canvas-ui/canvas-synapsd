// Lightweight storage entry point: no document engine, search or inference.
// Consumers use SynapsD's database implementation and native dependency pins.
import Db from './backends/lmdb/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runBackupWorker } from './backups/DatabaseBackups.js';

export function openKeyValueStore(options) {
    return new Db({ cache: false, strictAsyncOrder: false, ...options,
        backupOnOpen: false, backupOnClose: false });
}

/** Check an existing environment in a child before opening it in a long-lived
 * process. A corrupt mmap can SIGBUS; JavaScript try/catch cannot contain it.
 * Does not repair, truncate, replace or create data.mdb. Normal reader locks
 * may be created by LMDB. Call before starting writers for this environment.
 */
export async function verifyDatabase(directory) {
    const databasePath = path.resolve(directory);
    const file = path.join(databasePath, 'data.mdb');
    try {
        let stat;
        try { stat = await fs.stat(file); }
        catch (error) { if (error.code === 'ENOENT') { return null; } throw error; }
        if (!stat.isFile() || stat.size === 0) { throw new Error('Expected a non-empty data.mdb'); }
        return await runBackupWorker('verify', databasePath);
    } catch (cause) {
        throw Object.assign(new Error(`Database verification failed for ${file}: ${cause.message}. No repair or replacement was attempted.`, { cause }),
            { code: 'DATABASE_INTEGRITY_FAILED', databasePath: file, statusCode: 500 });
    }
}
