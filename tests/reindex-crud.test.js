import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import SynapsD from '../src/index.js';
import TimelineIndex from '../src/indexes/inverted/Timeline.js';

const NOTE = (title) => ({ schema: 'data/abstraction/note', data: { title, content: title } });
// crud timeframe tokens ('thisYear') are resolved to absolute bounds at the
// filter layer; for a direct timeline query we expand them the same way.
const thisYear = () => TimelineIndex.getTimeframeBounds('thisYear');

describe('reindexCrudTimelines', () => {
    let dbPath;
    let db;

    beforeEach(async () => {
        dbPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-reindex-'));
        // Disable Lance so no embed worker spins up in the test.
        const LanceIndex = (await import('../src/indexes/lance/index.js')).default;
        LanceIndex.prototype.initialize = async function () {};
        LanceIndex.prototype.backfill = async function () {};
        LanceIndex.prototype.addMany = async function () {};
        db = new SynapsD({ path: dbPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown(); db = null; }
        if (dbPath) { await fs.rm(dbPath, { recursive: true, force: true }); dbPath = null; }
    });

    test('rebuilds crud:created so timeframe filters match again after the tier is wiped', async () => {
        const id1 = await db.put(NOTE('a'));
        const id2 = await db.put(NOTE('b'));

        // Sanity: created-this-year filter finds both up front.
        const before = await db.timeline.queryInterval('crud:created', thisYear());
        expect(before.sort((a, b) => a - b)).toEqual([id1, id2].sort((a, b) => a - b));

        // Simulate orphaning: drop the crud:created timeline entirely.
        await db.timeline.deleteTimeline('crud:created');
        expect(await db.timeline.queryInterval('crud:created', thisYear())).toEqual([]);

        // Reindex from the document store.
        const counts = await db.reindexCrudTimelines();
        expect(counts.scanned).toBe(2);
        expect(counts.created).toBe(2);

        const after = await db.timeline.queryInterval('crud:created', thisYear());
        expect(after.sort((a, b) => a - b)).toEqual([id1, id2].sort((a, b) => a - b));
    });

    test('is idempotent (re-running yields the same membership)', async () => {
        const id = await db.put(NOTE('x'));
        await db.reindexCrudTimelines();
        await db.reindexCrudTimelines();
        const ids = await db.timeline.queryInterval('crud:created', thisYear());
        expect(ids).toEqual([id]);
        expect(await db.timeline.getCount('crud:created')).toBe(1);
    });
});
