import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Db, { EVENTS } from '../src/index.js';

const note = title => ({ schema: 'data/schema/note', data: { title, content: title } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('engine lifecycle coordination', () => {
    let root;
    let db;
    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-lifecycle-'));
        db = new Db({ path: root, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
    });
    afterEach(async () => {
        await db.shutdown();
        await fs.rm(root, { recursive: true, force: true });
    });

    test('start/shutdown are idempotent and restart reopens storage on the same facade', async () => {
        const events = [];
        db.on(EVENTS.STARTED, () => events.push('start'));
        db.on(EVENTS.SHUTDOWN, () => events.push('stop'));
        await Promise.all([db.start(), db.start()]);
        const id = await db.put(note('persisted'), { context: { path: '/saved' } });
        const treeId = db.getDefaultContextTree().id;
        const oldBackend = db.db;
        await db.restart();
        expect(db.db).not.toBe(oldBackend);
        expect(db.isRunning()).toBe(true);
        expect(db.getDefaultContextTree().id).toBe(treeId);
        expect((await db.list({ context: { path: '/saved' }, idsOnly: true }))[0]).toBe(id);
        await db.put({ id, data: { content: 'updated after restart' } });
        expect((await db.get(id)).data.content).toBe('updated after restart');
        await Promise.all([db.shutdown(), db.shutdown()]);
        expect(events).toEqual(['start', 'stop', 'start', 'stop']);
        await db.start();
        expect((await db.get(id)).data.content).toBe('updated after restart');
    });

    test('shutdown drains accepted writes and rejects new writes before closing', async () => {
        await db.start();
        const entered = deferred();
        const release = deferred();
        const realPut = db.documents.put.bind(db.documents);
        db.documents.put = async (...args) => { entered.resolve(); await release.promise; return realPut(...args); };
        const accepted = db.put(note('accepted'));
        await entered.promise;
        const closed = db.shutdown();
        await new Promise(resolve => setImmediate(resolve));
        try {
            await expect(db.put(note('late'))).rejects.toThrow(/shutting down|closed/);
            expect(db.status).toBe('shutting down');
        } finally { release.resolve(); }
        const id = await accepted;
        await closed;
        expect(db.status).toBe('shutdown');
        await db.start();
        expect((await db.get(id)).data.title).toBe('accepted');
        expect(db.documents.getCount()).toBe(1);
    });

    test('failed initialization can be shut down and reopened without poisoning transitions', async () => {
        const create = db.bitmapIndex.createBitmap.bind(db.bitmapIndex);
        db.bitmapIndex.createBitmap = async () => { throw new Error('initialization failure'); };
        await expect(db.start()).rejects.toThrow('initialization failure');
        expect(db.status).toBe('error');
        db.bitmapIndex.createBitmap = create;
        await db.shutdown();
        await db.start();
        expect(db.isRunning()).toBe(true);
        await db.put(note('recovered'));
    });

    test.each(['shutdown', 'start'])('%s after a failed close recovers the lifecycle and write queue', async method => {
        await db.start();
        const close = db.db.close.bind(db.db);
        db.db.close = async () => { throw new Error('close failure'); };
        await expect(db.shutdown()).rejects.toThrow('close failure');
        expect(db.status).toBe('error');
        db.db.close = close;
        await db[method]();
        if (method === 'shutdown') { expect(db.status).toBe('shutdown'); }
        else {
            expect(db.isRunning()).toBe(true);
            await db.put(note('after failed close'));
        }
    });
    test('shutdown closes sessions so cached candidates cannot survive a restart', async () => {
        await db.start();
        const session = await db.openSession([{ features: ['tag/session'] }]);
        await db.restart();
        await expect(session.materialize()).rejects.toThrow('QuerySession is closed');
        expect(db.listenerCount(EVENTS.MEMBERSHIP_CHANGED)).toBe(0);
        session.close();
    });

});
