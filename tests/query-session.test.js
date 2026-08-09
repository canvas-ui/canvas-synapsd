import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import QuerySession from '../src/session/QuerySession.js';
import { EVENTS } from '../src/utils/events.js';

const NOTE = (title, extra = {}) => ({ schema: 'data/schema/note', data: { title, content: title }, ...extra });
const sorted = (a) => [...a].sort((x, y) => x - y);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms)); // let debounced recompute fire

describe('QuerySession', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-session-'));
        // No Lance — every assertion uses count/ids/materialize(null) (slice path).
        const LanceIndex = (await import('../src/indexes/lance/index.js')).default;
        LanceIndex.prototype.initialize = async function () {};
        LanceIndex.prototype.backfill = async function () {};
        LanceIndex.prototype.addMany = async function () {};
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('frozen refinement: add narrows (AND), remove widens, materialize returns docs', async () => {
        const a1 = await db.put(NOTE('a1'), { context: { path: '/Projects/Alpha' }, features: ['tag/urgent'] });
        const a2 = await db.put(NOTE('a2'), { context: { path: '/Projects/Alpha' } });
        await db.put(NOTE('b1'), { context: { path: '/Projects/Beta' }, features: ['tag/urgent'] });

        const s = await db.openSession([], { mode: 'frozen' });
        await s.add({ context: { path: '/Projects/Alpha' } }, 'ctx');
        expect(sorted(s.ids())).toEqual(sorted([a1, a2]));

        await s.add({ features: ['tag/urgent'] }, 'feat');
        expect(sorted(s.ids())).toEqual([a1]);                 // Alpha ∩ urgent
        expect(await s.count()).toBe(1);

        await s.remove('feat');
        expect(sorted(s.ids())).toEqual(sorted([a1, a2]));     // back to Alpha

        const page = await s.materialize(null, { limit: 1 });
        expect(page).toHaveLength(1);
        expect(page.totalCount).toBe(2);
        s.close();
    });

    test('live insert triggers a delta emit with the new id', async () => {
        const s = await db.openSession({ features: ['tag/important'] }, { mode: 'live', emit: 'delta' });
        const events = [];
        s.on('change', (p) => events.push(p));

        const id = await db.put(NOTE('urgent mail'), { context: { path: '/Inbox' }, features: ['tag/important'] });
        await tick();

        expect(events.length).toBe(1);
        expect(sorted(events[0].added)).toEqual([id]);
        expect(events[0].removed).toEqual([]);
        expect(events[0].count).toBe(1);
        s.close();
    });

    test('precise invalidation: a non-matching write fires nothing; a matching one fires once', async () => {
        const s = await db.openSession({ features: ['tag/important'] }, { mode: 'live', emit: 'delta' });
        const events = [];
        s.on('change', (p) => events.push(p));

        // Different feature AND different path → touches no cue key → no emit.
        await db.put(NOTE('noise'), { context: { path: '/Other' }, features: ['tag/noise'] });
        await tick();
        expect(events.length).toBe(0);
        expect(await s.count()).toBe(0);

        // Matching write → exactly one emit.
        const id = await db.put(NOTE('hit'), { context: { path: '/Inbox' }, features: ['tag/important'] });
        await tick();
        expect(events.length).toBe(1);
        expect(sorted(events[0].added)).toEqual([id]);
        s.close();
    });

    test('removal produces a removed delta', async () => {
        const id = await db.put(NOTE('imp'), { context: { path: '/Inbox' }, features: ['tag/important'] });
        const s = await db.openSession({ features: ['tag/important'] }, { mode: 'live', emit: 'delta' });
        const events = [];
        s.on('change', (p) => events.push(p));

        await db.deleteMany([id]);
        await tick();

        expect(events.length).toBe(1);
        expect(events[0].removed).toEqual([id]);
        expect(events[0].added).toEqual([]);
        expect(events[0].count).toBe(0);
        s.close();
    });

    test('serialize / rehydrate reproduces the candidate set', async () => {
        const a1 = await db.put(NOTE('a1'), { context: { path: '/Projects/Alpha' }, features: ['tag/urgent'] });
        await db.put(NOTE('a2'), { context: { path: '/Projects/Alpha' } });

        const s = await db.openSession([], { mode: 'frozen' });
        await s.add({ context: { path: '/Projects/Alpha' } }, 'ctx');
        await s.add({ features: ['tag/urgent'] }, 'feat');
        const beforeIds = sorted(s.ids());
        expect(beforeIds).toEqual([a1]);

        const json = s.serialize();
        s.close();

        const s2 = await QuerySession.rehydrate(db, json);
        expect(sorted(s2.ids())).toEqual(beforeIds);
        expect(await s2.count()).toBe(1);
        s2.close();
    });

    test('patch narrows; clear unconstrains', async () => {
        const a1 = await db.put(NOTE('a1'), { context: { path: '/Projects/Alpha' }, features: ['tag/urgent'] });
        await db.put(NOTE('a2'), { context: { path: '/Projects/Alpha' } });

        const s = await db.openSession({ context: { path: '/Projects/Alpha' } }, { mode: 'frozen' });
        const label = s.labels()[0];
        await s.patch(label, { features: ['tag/urgent'] });
        expect(sorted(s.ids())).toEqual([a1]);

        await s.clear();
        expect(s.ids()).toBeNull();                            // unconstrained
        expect(await s.count()).toBe(await db.documents.getCount());
        s.close();
    });

    test('close() unsubscribes from the db', async () => {
        const s = await db.openSession({ features: ['tag/important'] }, { mode: 'live' });
        expect(db.listenerCount(EVENTS.MEMBERSHIP_CHANGED)).toBeGreaterThan(0);
        const events = [];
        s.on('change', (p) => events.push(p));
        s.close();

        await db.put(NOTE('after-close'), { context: { path: '/Inbox' }, features: ['tag/important'] });
        await tick();
        expect(events.length).toBe(0);
        expect(db.listenerCount(EVENTS.MEMBERSHIP_CHANGED)).toBe(0);
    });

    test('collectionKeys align with the keys a write to that path ticks (load-bearing)', async () => {
        // Capture the exact collection keys a put to /Projects/Alpha ticks.
        const ticked = new Set();
        const handler = (evt) => { for (const ch of evt.changes) { for (const k of ch.keys) { ticked.add(k); } } };
        db.on(EVENTS.MEMBERSHIP_CHANGED, handler);
        await db.put(NOTE('probe'), { context: { path: '/Projects/Alpha' }, features: ['tag/x'] });
        db.off(EVENTS.MEMBERSHIP_CHANGED, handler);
        expect(ticked.size).toBeGreaterThan(0);

        // resolveCandidates for the same path must report an overlapping collection key.
        const ctx = await db.resolveCandidates({ context: { path: '/Projects/Alpha' } });
        expect(ctx.collectionKeys.length).toBeGreaterThan(0);
        expect(ctx.collectionKeys.some((k) => ticked.has(k))).toBe(true);

        // Feature operand keys must align too.
        const feat = await db.resolveCandidates({ features: ['tag/x'] });
        expect(feat.collectionKeys.some((k) => ticked.has(k))).toBe(true);

        // Temporal operand → coarse.
        const temporal = await db.resolveCandidates({ filters: ['t:crud:created:thisYear'] });
        expect(temporal.coarse).toBe(true);
    });

    test('id-set operand: literal bitmap, no collection keys, not coarse', async () => {
        const a = await db.put(NOTE('a'), { context: { path: '/Inbox' } });
        const b = await db.put(NOTE('b'), { context: { path: '/Inbox' } });
        await db.put(NOTE('c'), { context: { path: '/Inbox' } });

        const resolved = await db.resolveCandidates({ ids: [a, b] });
        expect(sorted(resolved.bitmap.toArray())).toEqual(sorted([a, b]));
        expect(resolved.collectionKeys).toEqual([]);
        expect(resolved.coarse).toBe(false);

        // [] is a deliberately-empty constraint, distinct from absent.
        const empty = await db.resolveCandidates({ ids: [] });
        expect(empty.bitmap.size).toBe(0);
        const absent = await db.resolveCandidates({});
        expect(absent.bitmap).toBe(null);

        // Composes under AND with the other buckets.
        const composed = await db.resolveCandidates({ context: { path: '/Inbox' }, ids: [a] });
        expect(composed.bitmap.toArray()).toEqual([a]);

        // Malformed ids fail at parse time, like other spec buckets.
        await expect(db.resolveCandidates({ ids: [0] })).rejects.toThrow(/positive uint32/);
        await expect(db.resolveCandidates({ ids: 'nope' })).rejects.toThrow(/array/);
    });

    test('set() replaces a cue per tick; patch() would accumulate (streaming producer)', async () => {
        const a = await db.put(NOTE('a'), { context: { path: '/Inbox' }, features: ['tag/important'] });
        const b = await db.put(NOTE('b'), { context: { path: '/Inbox' }, features: ['tag/important'] });
        const c = await db.put(NOTE('c'), { context: { path: '/Inbox' } }); // not important

        const s = await db.openSession({ features: ['tag/important'] }, { mode: 'live', emit: 'delta' });
        const events = [];
        s.on('change', (p) => events.push(p));

        // Tick 1: producer emits {a, c} — c is gated out by the feature cue.
        await s.set('viewport', { ids: [a, c] });
        expect(sorted(s.ids())).toEqual([a]);

        // Tick 2: full replacement — a leaves, b enters. patch() would keep a.
        await s.set('viewport', { ids: [b, c] });
        expect(sorted(s.ids())).toEqual([b]);
        const last = events[events.length - 1];
        expect(last.added).toEqual([b]);
        expect(last.removed).toEqual([a]);

        // set() upserts: unknown label was created, labels() reflects it.
        expect(s.labels()).toContain('viewport');

        // A write elsewhere never dirties the literal cue (no keys), but still
        // flows through the OTHER cue and intersects correctly.
        const d = await db.put(NOTE('d'), { context: { path: '/Inbox' }, features: ['tag/important'] });
        await tick();
        expect(sorted(s.ids())).toEqual([b]); // d not in the viewport id-set → unchanged

        await s.set('viewport', { ids: [b, d] });
        expect(sorted(s.ids())).toEqual(sorted([b, d]));
        s.close();
    });

    test('set() replaces non-id buckets too (anchor-filter style cue swap)', async () => {
        const a1 = await db.put(NOTE('a1'), { context: { path: '/Projects/Alpha' } });
        const b1 = await db.put(NOTE('b1'), { context: { path: '/Projects/Beta' } });

        const s = await db.openSession([], { mode: 'frozen' });
        await s.set('scope', { context: { path: '/Projects/Alpha' } });
        expect(s.ids()).toEqual([a1]);

        // Wholesale replacement — patch() would OR the two paths together.
        await s.set('scope', { context: { path: '/Projects/Beta' } });
        expect(s.ids()).toEqual([b1]);
        s.close();
    });

    test('id-set cue survives serialize/rehydrate', async () => {
        const a = await db.put(NOTE('a'), { context: { path: '/Inbox' } });
        const b = await db.put(NOTE('b'), { context: { path: '/Inbox' } });

        const s = await db.openSession([], { mode: 'live', emit: 'delta' });
        await s.set('viewport', { ids: [a, b] });
        const snapshot = s.serialize();
        s.close();

        const restored = await QuerySession.rehydrate(db, snapshot);
        expect(sorted(restored.ids())).toEqual(sorted([a, b]));
        expect(restored.labels()).toContain('viewport');
        restored.close();
    });
});
