import fs from 'fs';
import SynapsD from '../src/index.js';

export const TEST_DB_PATH = '/tmp/synapsd-test';

export async function initializeTestDB(options = {}) {
    if (fs.existsSync(TEST_DB_PATH)) {
        fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DB_PATH, { recursive: true });

    const db = new SynapsD({
        path: TEST_DB_PATH,
        ...options,
    });
    await db.start();
    return db;
}

export async function cleanupTestDB(db) {
    if (db && db.isRunning()) {
        await db.shutdown();
    }
    if (fs.existsSync(TEST_DB_PATH)) {
        fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
}
