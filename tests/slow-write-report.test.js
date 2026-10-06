'use strict';

import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const note = (title) => ({ schema: 'data/schema/note', data: { title, content: title } });

describe('slow write reports', () => {
    let rootPath;
    let db;

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    async function open(options) {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-slow-write-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, ...options });
        await db.start();
    }

    test('a write queued behind others names them as lock holders', async () => {
        const reports = [];
        await open({ onSlowWrite: (report) => reports.push(report), slowWriteMs: 0.001 });
        const [first] = await db.putMany([note('a'), note('b')], { context: { path: '/x' } });

        // A big batch and a link enqueued together: the link waits for the batch.
        const batch = db.putMany(Array.from({ length: 200 }, (_, i) => note(`n${i}`)), { context: { path: '/bulk' } });
        const link = db.linkMany([first], { context: { path: '/pasted' } });
        await Promise.all([batch, link]);

        const linkReport = reports.filter((r) => /linkMany/.test(r.method || '')).pop();
        expect(linkReport).toBeDefined();
        expect(linkReport.waitMs).toBeGreaterThanOrEqual(0);
        expect(linkReport.aheadCount).toBeGreaterThan(0);
        expect(linkReport.ahead.some((op) => /putMany/.test(op.method || ''))).toBe(true);
        // The caller outside synapsd (this test file) is named too.
        expect(linkReport.caller).toBeTruthy();
    });

    test('fast writes stay silent under the default threshold', async () => {
        const reports = [];
        await open({ onSlowWrite: (report) => reports.push(report) });
        await db.put(note('quick'), { context: { path: '/q' } });
        expect(reports).toHaveLength(0);
    });

    test('a throwing reporter never breaks the write', async () => {
        await open({ onSlowWrite: () => { throw new Error('boom'); }, slowWriteMs: 0.001 });
        await expect(db.put(note('still saved'), { context: { path: '/q' } })).resolves.toBeGreaterThan(0);
    });
});
