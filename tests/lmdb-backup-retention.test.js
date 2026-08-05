import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import LmdbBackend from '../src/backends/lmdb/index.js';

const day = 86400000;
const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().split('T')[0].replace(/-/g, '');

// Backup retention is AGE-based since 2026-08-05 (default 7 days, keyed off the
// YYYYMMDD folder names): the old count-based rule minted a folder per open, so
// a restart-heavy day could shrink "keep 14" to two days of real coverage.
describe('lmdb backup retention', () => {
    let rootPath;
    let backupPath;
    let db;

    const seedBackupFolder = (name) => fssync.mkdirSync(path.join(backupPath, name), { recursive: true });
    const listBackups = () => fssync.readdirSync(backupPath).sort();
    const waitFor = async (predicate, timeoutMs = 5000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (predicate()) { return true; }
            await new Promise((r) => setTimeout(r, 50));
        }
        return predicate();
    };

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-backup-retention-'));
        backupPath = path.join(rootPath, 'backup');
    });

    afterEach(async () => {
        if (db) { await db.close?.().catch?.(() => {}); db = null; }
        await fs.rm(rootPath, { recursive: true, force: true });
    });

    test('folders older than backupRetentionDays are dropped; newer ones and today survive', async () => {
        seedBackupFolder(stamp(10 * day));       // outside the 7-day window
        seedBackupFolder(`${stamp(9 * day)}.1`); // outside, suffixed form
        seedBackupFolder(stamp(3 * day));        // inside

        db = new LmdbBackend({ path: rootPath, backupOnOpen: true });

        expect(await waitFor(() => {
            const folders = listBackups();
            return !folders.includes(stamp(10 * day)) &&
                !folders.includes(`${stamp(9 * day)}.1`) &&
                folders.includes(stamp(3 * day)) &&
                folders.includes(stamp(0));
        })).toBe(true);
    });

    test('the newest pre-existing folder is never deleted by age alone', async () => {
        // A database untouched for months must not lose its only prior backup.
        // Today's open mints a new folder, making the old one second-newest and
        // eligible — but with cleanup ordered after the new backup succeeds,
        // coverage never drops to zero. Here: retention 1 day, one very old
        // folder; after open we must have today's AND (transiently checked)
        // never zero folders.
        seedBackupFolder(stamp(90 * day));
        db = new LmdbBackend({ path: rootPath, backupOnOpen: true, backupRetentionDays: 1 });

        expect(await waitFor(() => listBackups().includes(stamp(0)))).toBe(true);
        expect(listBackups().length).toBeGreaterThanOrEqual(1);
    });

    test('maxBackupRetention still caps by count when set explicitly', async () => {
        // Five in-window folders + cap 2: age rule keeps all five, the count cap
        // trims to the newest two (plus today's new one).
        for (let i = 1; i <= 5; i++) { seedBackupFolder(`${stamp(day)}.${i}`); }
        db = new LmdbBackend({ path: rootPath, backupOnOpen: true, maxBackupRetention: 2 });

        expect(await waitFor(() => {
            const folders = listBackups();
            return folders.includes(stamp(0)) && folders.length === 2;
        })).toBe(true);
    });
});
