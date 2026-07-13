import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import Todo from '../src/schemas/abstractions/Todo.js';

const TODO_SCHEMA = 'data/abstraction/todo';

const iso = (d) => d.toISOString();
const today = () => { const d = new Date(); d.setHours(18, 0, 0, 0); return d; };
const inDays = (n) => { const d = today(); d.setDate(d.getDate() + n); return d; };

// Todo v2.1: VTODO/JSCalendar-aligned status, dueDate derived onto the 'tasks'
// point timeline (doc declares, index derives), dueDate in the checksum so
// same-title tasks on different days never dedup-collide.
describe('todo schema + tasks timeline', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-todo-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('the PWA flow: title + description + due today → t:tasks:today finds it', async () => {
        const id = await db.put({
            schema: TODO_SCHEMA,
            data: { title: 'Call plumber', description: 'from the phone call', dueDate: iso(today()) },
        });

        const due = await db.list({ features: [TODO_SCHEMA], filters: ['t:tasks:today'], limit: 0 });
        expect(due.map((d) => d.id)).toEqual([id]);

        const stored = await db.getDocument(id);
        expect(stored.timelines).toEqual([{ timeline: 'tasks', start: iso(today()) }]);
        expect(stored.data.status).toBe('pending');
        expect(stored.data.completed).toBe(false);
    });

    test('due list sorts by the tasks timeline, undated todos trail', async () => {
        const day3 = await db.put({ schema: TODO_SCHEMA, data: { title: 'later', dueDate: iso(inDays(3)) } });
        const day1 = await db.put({ schema: TODO_SCHEMA, data: { title: 'soon', dueDate: iso(inDays(1)) } });
        const someday = await db.put({ schema: TODO_SCHEMA, data: { title: 'someday' } });

        const res = await db.list({ features: [TODO_SCHEMA], sortBy: 'tasks', order: 'asc', limit: 0 });
        expect(res.map((d) => d.id)).toEqual([day1, day3, someday]);
    });

    test('legacy completed:true maps to status completed, both stay in sync', async () => {
        const legacy = Todo.fromData({ data: { title: 'old client', completed: true } });
        expect(legacy.data.status).toBe('completed');
        expect(legacy.data.completed).toBe(true);

        const canceled = Todo.fromData({ data: { title: 'nope', status: 'cancelled' } });
        expect(canceled.data.completed).toBe(false);
    });

    test('same title, different due date → different checksums (no dedup collision)', async () => {
        const tue = Todo.fromData({ data: { title: 'Call plumber', dueDate: iso(inDays(1)) } });
        const fri = Todo.fromData({ data: { title: 'Call plumber', dueDate: iso(inDays(4)) } });
        expect(tue.getPrimaryChecksum()).not.toBe(fri.getPrimaryChecksum());
    });

    test('changing the due date on update moves the tasks timeline entry', async () => {
        const id = await db.put({ schema: TODO_SCHEMA, data: { title: 'moving target', dueDate: iso(inDays(1)) } });
        await db.put({ id, schema: TODO_SCHEMA, data: { title: 'moving target', dueDate: iso(inDays(10)) } });

        const soon = await db.list({ filters: [`t:tasks:${iso(inDays(0)).slice(0, 10)}..${iso(inDays(2)).slice(0, 10)}`], limit: 0 });
        expect(soon.map((d) => d.id)).toEqual([]);
        const later = await db.list({ filters: [`t:tasks:${iso(inDays(9)).slice(0, 10)}..${iso(inDays(11)).slice(0, 10)}`], limit: 0 });
        expect(later.map((d) => d.id)).toEqual([id]);
    });

    test('status is queryable via derived data/status/* bitmaps', async () => {
        const pending = await db.put({ schema: TODO_SCHEMA, data: { title: 'open item' } });
        const done = await db.put({ schema: TODO_SCHEMA, data: { title: 'closed item', status: 'completed' } });

        const pendingIds = await db.list({ filters: ['data/status/pending'], limit: 0 });
        expect(pendingIds.map((d) => d.id)).toEqual([pending]);
        const doneIds = await db.list({ filters: ['data/status/completed'], limit: 0 });
        expect(doneIds.map((d) => d.id)).toEqual([done]);
    });

    test('status change unticks the stale bitmap (update path)', async () => {
        const id = await db.put({ schema: TODO_SCHEMA, data: { title: 'flip me' } });
        await db.put({ id, schema: TODO_SCHEMA, data: { title: 'flip me', status: 'completed' } });

        const pendingIds = await db.list({ filters: ['data/status/pending'], limit: 0 });
        expect(pendingIds.map((d) => d.id)).toEqual([]);
        const doneIds = await db.list({ filters: ['data/status/completed'], limit: 0 });
        expect(doneIds.map((d) => d.id)).toEqual([id]);
    });

    test('status change through putMany batch also unticks stale keys', async () => {
        const id = await db.put({ schema: TODO_SCHEMA, data: { title: 'batch flip' } });
        await db.putMany([{ id, schema: TODO_SCHEMA, data: { title: 'batch flip', status: 'cancelled' } }]);

        const pendingIds = await db.list({ filters: ['data/status/pending'], limit: 0 });
        expect(pendingIds.map((d) => d.id)).toEqual([]);
        const cancelledIds = await db.list({ filters: ['data/status/cancelled'], limit: 0 });
        expect(cancelledIds.map((d) => d.id)).toEqual([id]);
    });

    test('the agent probe: pending todos due this week, zero-fetch composable', async () => {
        const hit = await db.put({ schema: TODO_SCHEMA, data: { title: 'due soon', dueDate: iso(inDays(1)) } });
        await db.put({ schema: TODO_SCHEMA, data: { title: 'done already', status: 'completed', dueDate: iso(inDays(1)) } });
        await db.put({ schema: TODO_SCHEMA, data: { title: 'far future', dueDate: iso(inDays(30)) } });

        const res = await db.list({
            features: ['data/abstraction/todo'],
            // '+' on a raw bitmap key is stripped to the AND default (regression:
            // it used to leak into the key and silently match nothing).
            filters: ['+data/status/pending', `+t:tasks:${iso(inDays(0)).slice(0, 10)}..${iso(inDays(7)).slice(0, 10)}`],
            sortBy: 'tasks',
            limit: 0,
        });
        expect(res.map((d) => d.id)).toEqual([hit]);
    });

    test('non-todo docs with a data.status string do not pollute the axis', async () => {
        await db.put({ schema: 'data/abstraction/note', data: { title: 'note', content: 'x', status: 'pending' } });
        const pendingIds = await db.list({ filters: ['data/status/pending'], limit: 0 });
        expect(pendingIds).toHaveLength(0);
    });

    test('priority validates the RFC 5545 1..9 scale', () => {
        expect(() => Todo.validateData({ schema: TODO_SCHEMA, data: { title: 'x', priority: 5 } })).not.toThrow();
        expect(() => Todo.validateData({ schema: TODO_SCHEMA, data: { title: 'x', priority: 0 } })).toThrow();
        expect(() => Todo.validateData({ schema: TODO_SCHEMA, data: { title: 'x', priority: 10 } })).toThrow();
    });
});
