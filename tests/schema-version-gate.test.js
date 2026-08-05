import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE = 'data/schema/note';

// Migration code was removed from the engine 2026-08-04 — migrations are one-time
// operator actions and were living on the startup path. The REFUSAL stayed, and it
// is the part that needs a test: without it, current code opens a stale database
// and writes to it, and rows whose `metadata.features` was never promoted lose the
// asserted tags that exist only in bitmaps — the one class of state with no rebuild
// source. Silent, and not recoverable.
describe('schema version gate', () => {
    let rootPath;
    let db;

    const open = async () => {
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
        return db;
    };

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-version-gate-'));
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('a fresh database is stamped, and reopening it stays clean', async () => {
        await open();
        expect(Number(db.internalStore.get('internal/schemaVersion'))).toBe(3);
        await db.shutdown();

        await expect(open()).resolves.toBeDefined();
    });

    test('an empty database is stamped rather than refused', async () => {
        // A brand-new install has nothing to be stale about and must not hit the
        // refusal — the gate keys off the version, so the empty case is explicit.
        await open();
        await db.internalStore.put('internal/schemaVersion', 0);
        await db.shutdown();

        await expect(open()).resolves.toBeDefined();
        expect(Number(db.internalStore.get('internal/schemaVersion'))).toBe(3);
    });

    test('a NON-empty database below the current version refuses to open', async () => {
        await open();
        await db.put({ schema: NOTE, data: { title: 'n', content: 'c' } });
        await db.internalStore.put('internal/schemaVersion', 2);
        await db.shutdown();
        db = null;

        await expect(open()).rejects.toThrow(/is at schema v2, this build needs v3/);
    });
});
