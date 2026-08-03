import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import schemaRegistry from '../src/schemas/SchemaRegistry.js';

const EVENT_SCHEMA = 'data/abstraction/event';
const TODO_SCHEMA = 'data/abstraction/todo';

const at = (h, dayOffset = 0) => {
    const d = new Date();
    d.setHours(h, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    return d.toISOString();
};

// Event exists to serve the founding query: "show me everything happening under
// /work/customer-foo". Calendar entries, alerts and activity logs are three
// lenses on ONE time-bound set, so they are one entity with a subtype and one
// 'events' timeline — not three corpora a client has to union by hand.
describe('event schema + events timeline', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-event-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('is registered as a core schema with an event/* kind axis', () => {
        expect(schemaRegistry.getSchemaEntry(EVENT_SCHEMA).tier).toBe('core');
        expect(schemaRegistry.resolveKind(EVENT_SCHEMA, { data: { type: 'calendar' } })).toBe('event/calendar');
        expect(schemaRegistry.resolveKind(EVENT_SCHEMA, { data: { type: 'alert' } })).toBe('event/alert');
        expect(schemaRegistry.resolveKind(EVENT_SCHEMA, { data: { type: 'activity' } })).toBe('event/activity');
    });

    test('type is required — a silent default would mis-file into the kind query', async () => {
        await expect(db.put({
            schema: EVENT_SCHEMA,
            data: { title: 'Untyped', start: at(9) },
        })).rejects.toThrow();
    });

    test('start is required — an event with no position on the timeline is not an event', async () => {
        await expect(db.put({
            schema: EVENT_SCHEMA,
            data: { title: 'Nowhen', type: 'calendar' },
        })).rejects.toThrow();
    });

    test('a calendar entry with an end is stored as an interval, and found by a range covering it', async () => {
        const id = await db.put({
            schema: EVENT_SCHEMA,
            data: { title: 'Standup', type: 'calendar', start: at(9), end: at(10) },
        });

        const found = await db.list({ features: [EVENT_SCHEMA], filters: ['t:events:today'], limit: 0 });
        expect(found.map((d) => d.id)).toEqual([id]);
    });

    test('an alert with no end is an instant on the same timeline', async () => {
        const id = await db.put({
            schema: EVENT_SCHEMA,
            data: { title: 'Disk almost full', type: 'alert', start: at(11) },
        });

        const doc = await db.get(id);
        const entry = doc.timelines.find((t) => t.timeline === 'events');
        expect(entry).toBeDefined();
        expect(entry.start).toBe(at(11));
        // Omitted, not `end: undefined` — the index reads a present key as a
        // bound and would treat an explicit undefined differently from absence.
        expect('end' in entry).toBe(false);

        const found = await db.list({ features: [EVENT_SCHEMA], filters: ['t:events:today'], limit: 0 });
        expect(found.map((d) => d.id)).toEqual([id]);
    });

    test('end: null is an ongoing interval, distinct from an omitted end', async () => {
        const ongoing = await db.put({
            schema: EVENT_SCHEMA,
            data: { title: 'Incident open', type: 'alert', start: at(9), end: null },
        });
        const instant = await db.put({
            schema: EVENT_SCHEMA,
            data: { title: 'Incident noticed', type: 'alert', start: at(9) },
        });

        const doc = await db.get(ongoing);
        const entry = doc.timelines.find((t) => t.timeline === 'events');
        expect('end' in entry).toBe(true);
        expect(entry.end).toBeNull();

        // Both started this morning, so `today` cannot tell them apart — the
        // discriminating query is TOMORROW, which only an unbounded interval
        // still overlaps. Asserting on today would pass either way.
        const today = await db.list({ features: [EVENT_SCHEMA], filters: ['t:events:today'], limit: 0 });
        expect(today.map((d) => d.id).sort()).toEqual([ongoing, instant].sort());

        const tomorrow = await db.list({ features: [EVENT_SCHEMA], filters: ['t:events:tomorrow'], limit: 0 });
        expect(tomorrow.map((d) => d.id)).toEqual([ongoing]);
    });

    // A document occupies exactly ONE position per timeline (the index is a BSI
    // keyed id -> a single value, so a second insert overwrites the first), so a
    // series cannot be expanded into N entries. The entry spans an envelope and
    // the client expands the RRULE — the CalDAV contract.
    describe('recurrence envelope', () => {
        const RULE_UNTIL = 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T235959Z';

        test('a bounded rule spans first occurrence → UNTIL', async () => {
            const id = await db.put({
                schema: EVENT_SCHEMA,
                data: {
                    title: 'Standup', type: 'calendar',
                    start: '2026-01-06T09:00:00.000Z', end: '2026-01-06T09:15:00.000Z',
                    recurrence: RULE_UNTIL,
                },
            });

            const doc = await db.get(id);
            const entry = doc.timelines.find((t) => t.timeline === 'events');
            expect(entry.start).toBe('2026-01-06T09:00:00.000Z');
            // NOT data.end — that is one occurrence's duration, not the envelope.
            expect(entry.end).toBe('2026-12-31T23:59:59.000Z');

            const inside = await db.list({ features: [EVENT_SCHEMA], filters: ['t:events:2026-08-01..2026-08-31'], limit: 0 });
            expect(inside.map((d) => d.id)).toEqual([id]);

            const after = await db.list({ features: [EVENT_SCHEMA], filters: ['t:events:2027-06-01..2027-06-30'], limit: 0 });
            expect(after.map((d) => d.id)).toEqual([]);
        });

        test('an unbounded rule is an open envelope', async () => {
            const id = await db.put({
                schema: EVENT_SCHEMA,
                data: { title: 'Daily sync', type: 'calendar', start: '2026-01-06T09:00:00.000Z', recurrence: 'FREQ=DAILY' },
            });

            const doc = await db.get(id);
            expect(doc.timelines.find((t) => t.timeline === 'events').end).toBeNull();

            const farFuture = await db.list({ features: [EVENT_SCHEMA], filters: ['t:events:2030-01-01..2030-12-31'], limit: 0 });
            expect(farFuture.map((d) => d.id)).toEqual([id]);
        });

        test('COUNT yields an OPEN envelope — over-matching is recoverable, under-matching is not', async () => {
            const id = await db.put({
                schema: EVENT_SCHEMA,
                data: { title: 'Onboarding', type: 'calendar', start: '2026-01-06T09:00:00.000Z', recurrence: 'FREQ=WEEKLY;COUNT=4' },
            });

            const doc = await db.get(id);
            expect(doc.timelines.find((t) => t.timeline === 'events').end).toBeNull();

            // Resolving COUNT needs rule expansion; a guessed end could stop
            // matching before the real final occurrence, which nothing downstream
            // could recover. The client's expansion drops the surplus instead.
            const later = await db.list({ features: [EVENT_SCHEMA], filters: ['t:events:2027-01-01..2027-12-31'], limit: 0 });
            expect(later.map((d) => d.id)).toEqual([id]);
        });

        test('a non-recurring event is unaffected — data.end stays the interval end', async () => {
            const id = await db.put({
                schema: EVENT_SCHEMA,
                data: {
                    title: 'One-off', type: 'calendar',
                    start: '2026-01-06T09:00:00.000Z', end: '2026-01-06T10:00:00.000Z',
                },
            });

            const doc = await db.get(id);
            expect(doc.timelines.find((t) => t.timeline === 'events').end).toBe('2026-01-06T10:00:00.000Z');
        });

        test('the rule must be a real RRULE value', async () => {
            await expect(db.put({
                schema: EVENT_SCHEMA,
                data: { title: 'Bad', type: 'calendar', start: '2026-01-06T09:00:00.000Z', recurrence: 'every tuesday' },
            })).rejects.toThrow();
        });

        test('editing the rule edits the series, it does not fork a new event', async () => {
            const id = await db.put({
                schema: EVENT_SCHEMA,
                data: { title: 'Standup', type: 'calendar', start: '2026-01-06T09:00:00.000Z', recurrence: RULE_UNTIL },
            });

            const again = await db.put({
                schema: EVENT_SCHEMA,
                data: { title: 'Standup', type: 'calendar', start: '2026-01-06T09:00:00.000Z', recurrence: 'FREQ=WEEKLY;BYDAY=TH' },
            });

            // recurrence is NOT a checksum field — same title/start/type is the
            // same event, so this dedups onto the existing document (CalDAV keeps
            // the same UID when a rule changes).
            expect(again).toBe(id);
        });
    });

    test('the timeline entry is regenerated on update, never drifting from the doc', async () => {
        const id = await db.put({
            schema: EVENT_SCHEMA,
            data: { title: 'Review', type: 'calendar', start: at(9), end: at(10) },
        });

        await db.put({
            id,
            schema: EVENT_SCHEMA,
            data: { title: 'Review', type: 'calendar', start: at(14), end: at(15) },
        });

        const doc = await db.get(id);
        const entries = doc.timelines.filter((t) => t.timeline === 'events');
        expect(entries).toHaveLength(1);
        expect(entries[0].start).toBe(at(14));
    });

    test('same title at a different time is a different event, not a dedup collision', async () => {
        const morning = await db.put({
            schema: EVENT_SCHEMA,
            data: { title: 'Standup', type: 'calendar', start: at(9) },
        });
        const afternoon = await db.put({
            schema: EVENT_SCHEMA,
            data: { title: 'Standup', type: 'calendar', start: at(14) },
        });
        expect(afternoon).not.toBe(morning);
    });

    test('a calendar entry and an alert sharing a title stay distinct', async () => {
        const cal = await db.put({
            schema: EVENT_SCHEMA,
            data: { title: 'Deploy', type: 'calendar', start: at(9) },
        });
        const alert = await db.put({
            schema: EVENT_SCHEMA,
            data: { title: 'Deploy', type: 'alert', start: at(9) },
        });
        expect(alert).not.toBe(cal);
    });

    // The use case this entity was built for: an app bound to a context asks one
    // question and gets every time-bound document under it, across schemas —
    // then zooms out and gets the superset, with no per-schema client logic.
    describe('context zoom-out', () => {
        const seed = async () => ({
            taskEvent: await db.put({
                schema: EVENT_SCHEMA,
                data: { title: 'Review task-bar', type: 'calendar', start: at(9) },
            }, { context: { path: '/work/customer-foo/task-bar' } }),
            taskTodo: await db.put({
                schema: TODO_SCHEMA,
                data: { title: 'Finish task-bar', dueDate: at(17) },
            }, { context: { path: '/work/customer-foo/task-bar' } }),
            siblingEvent: await db.put({
                schema: EVENT_SCHEMA,
                data: { title: 'Customer sync', type: 'calendar', start: at(11) },
            }, { context: { path: '/work/customer-foo/task-baz' } }),
            elsewhere: await db.put({
                schema: EVENT_SCHEMA,
                data: { title: 'Dentist', type: 'calendar', start: at(15) },
            }, { context: { path: '/personal' } }),
        });

        test('a focused context returns only its own time-bound docs', async () => {
            const { taskEvent, taskTodo } = await seed();

            const found = await db.list({
                context: { path: '/work/customer-foo/task-bar' },
                filters: ['t:events:today', 't:tasks:today'],
                limit: 0,
            });

            expect(found.map((d) => d.id).sort()).toEqual([taskEvent, taskTodo].sort());
        });

        test('zooming out to the parent context widens the set to the whole subtree', async () => {
            const { taskEvent, taskTodo, siblingEvent, elsewhere } = await seed();

            const found = await db.list({
                context: { path: '/work/customer-foo' },
                filters: ['t:events:today', 't:tasks:today'],
                limit: 0,
            });

            const ids = found.map((d) => d.id);
            expect(ids.sort()).toEqual([taskEvent, taskTodo, siblingEvent].sort());
            expect(ids).not.toContain(elsewhere);
        });

        test('a calendar-only lens narrows by kind without changing the context query', async () => {
            const { taskEvent, taskTodo, siblingEvent } = await seed();

            const all = await db.list({
                context: { path: '/work/customer-foo' },
                features: [EVENT_SCHEMA],
                limit: 0,
            });

            const ids = all.map((d) => d.id);
            expect(ids.sort()).toEqual([taskEvent, siblingEvent].sort());
            expect(ids).not.toContain(taskTodo);
        });
    });
});
