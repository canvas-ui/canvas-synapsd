import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const note = (title, content) => ({ schema: 'data/schema/note', data: { title, content } });

describe('db.batch', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-batch-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('writes inside a batch commit together and publish their events after it', async () => {
        const events = [];
        db.on('document.inserted', (evt) => events.push(evt.id));
        let seenInside = null;

        const ids = await db.batch(async () => {
            const a = await db.put(note('a', 'one'), { context: { path: '/inbox' } });
            const b = await db.put(note('b', 'two'), { context: { path: '/inbox' } });
            await db.put({ id: a, schema: 'data/schema/note', data: { title: 'a', content: 'one, edited' } });
            seenInside = [...events];
            return [a, b];
        });

        expect(seenInside).toEqual([]);
        expect(events).toEqual(ids);
        expect((await db.get(ids[0])).data.content).toBe('one, edited');
        expect((await db.get(ids[1])).data.content).toBe('two');
        const listed = await db.list({ context: { path: '/inbox' } });
        expect((listed.data || listed).map((doc) => doc.id).sort()).toEqual([...ids].sort());
    });

    test('a batch that throws leaves nothing behind', async () => {
        const kept = await db.put(note('kept', 'before'));
        const events = [];
        db.on('document.**', function () { events.push(this.event); });
        let lost = null;

        await expect(db.batch(async () => {
            lost = await db.put(note('lost', 'never committed'));
            await db.put({ id: kept, schema: 'data/schema/note', data: { title: 'kept', content: 'changed in the batch' } });
            throw new Error('abort the batch');
        })).rejects.toThrow('abort the batch');

        expect(events).toEqual([]);
        expect((await db.get(kept)).data.content).toBe('before');
        expect(await db.get(lost).catch(() => null)).toBeFalsy();
    });

    test('a write started by an event listener runs after the batch, on its own', async () => {
        const order = [];
        let followUp = null;
        db.on('document.inserted', (evt) => {
            if (followUp) { return; }
            order.push(`event ${evt.id}`);
            followUp = db.put(note('follow-up', 'from a listener')).then((id) => { order.push(`follow-up ${id}`); return id; });
        });

        const id = await db.batch(async () => {
            const first = await db.put(note('first', 'in the batch'));
            order.push('batch body done');
            return first;
        });
        const second = await followUp;

        expect(order).toEqual(['batch body done', `event ${id}`, `follow-up ${second}`]);
        expect((await db.get(second)).data.title).toBe('follow-up');
    });

    test('writes outside a batch still work after one', async () => {
        await db.batch(async () => { await db.put(note('x', 'y')); });
        const id = await db.put(note('after', 'plain'));
        expect((await db.get(id)).data.title).toBe('after');
    });
});
