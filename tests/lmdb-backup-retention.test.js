import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { open } from 'lmdb';
import DatabaseBackups from '../src/backups/DatabaseBackups.js';

describe('verified LMDB checkpoints', () => {
    let root, db, backups;
    const connect = () => open({ path: root, maxDbs: 64, compression: true });
    const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-backups-'));
        db = connect();
        await db.openDB('documents').put(100001, { title: 'Original', version: 8 });
        await db.openDB('bitmaps').put('context/important', Buffer.from([1, 3, 5]));
        await db.openDB('checksums').put('old-sha', 100001);
        const edges = db.openDB('edges_fwd', { dupSort: true, encoding: 'ordered-binary' });
        await edges.put(100001, ['related', 100002]);
        await edges.put(100001, ['related', 100003]);
        backups = new DatabaseBackups(root, { retention: { startup: 2, hourly: 3 } });
    });
    afterEach(async () => { if (db) { await db.close(); } await fs.rm(root, { recursive: true, force: true }); });

    test('verified backups retain every named dataset, duplicate edge values, and independent retention buckets', async () => {
        await fs.mkdir(path.join(backups.backupPath, '20261001'), { recursive: true });
        const manual = await backups.create();
        expect(manual.datasets.documents.count).toBe(1);
        expect(manual.datasets.edges_fwd.count).toBe(2);
        for (let i = 0; i < 4; i++) { await backups.create('startup'); await backups.create('hourly'); }
        const list = await backups.list();
        expect(list.filter(x => x.kind === 'startup')).toHaveLength(2);
        expect(list.filter(x => x.kind === 'hourly')).toHaveLength(3);
        expect(list.filter(x => x.kind === 'manual')).toHaveLength(1);
        expect(await fs.stat(path.join(backups.backupPath, '20261001'))).toBeTruthy();
        expect((await fs.readdir(backups.backupPath)).some(x => x.startsWith('.pending'))).toBe(false);
    });

    test('restore rolls back rows, placements and relations together, preserving the newer database first', async () => {
        const original = await backups.create();
        await db.openDB('documents').put(100001, { title: 'After', version: 9 });
        await db.openDB('bitmaps').put('context/important', Buffer.from([9]));
        await db.openDB('edges_fwd', { dupSort: true, encoding: 'ordered-binary' }).put(100001, ['related', 100004]);
        await db.close(); db = null;
        const restored = await backups.restore(original.id);
        db = connect();
        expect(db.openDB('documents').get(100001)).toEqual({ title: 'Original', version: 8 });
        expect(db.openDB('bitmaps').get('context/important')).toEqual(Buffer.from([1, 3, 5]));
        expect(db.openDB('edges_fwd', { dupSort: true, encoding: 'ordered-binary' }).getStats().entryCount).toBe(2);
        const preserved = open({ path: path.join(backups.backupPath, restored.preservedId), noSubdir: false, readOnly: true, compression: true, maxDbs: 64 });
        try { expect(preserved.openDB('documents').get(100001).title).toBe('After'); }
        finally { await preserved.close(); }
        expect(JSON.parse(await fs.readFile(path.join(root, 'restore-search.json'))).backupId).toBe(original.id);
    });

    test('altered backups and traversal cannot overwrite the current database', async () => {
        const snapshot = await backups.create();
        await db.close(); db = null;
        const before = await hash(path.join(root, 'data.mdb'));
        await fs.appendFile(path.join(backups.backupPath, snapshot.id, 'data.mdb'), 'bad');
        await expect(backups.restore(snapshot.id)).rejects.toThrow('checksum mismatch');
        await expect(backups.restore('../data.mdb')).rejects.toThrow('Invalid backup');
        expect(await hash(path.join(root, 'data.mdb'))).toBe(before);
    });

    test('native worker failure leaves originals and all good backups intact, and releases the operation lock', async () => {
        await backups.create('startup');
        await db.close(); db = null;
        await fs.truncate(path.join(root, 'data.mdb'), 4096);
        const before = await hash(path.join(root, 'data.mdb'));
        await expect(backups.create('startup')).rejects.toThrow('Database copy failed');
        expect(await hash(path.join(root, 'data.mdb'))).toBe(before);
        expect(await backups.list()).toHaveLength(1);
        expect((await fs.readdir(backups.backupPath)).some(x => x.startsWith('.pending'))).toBe(false);
        await expect(backups.create()).rejects.toThrow('Database copy failed');
    });

    test('overlapping operations are rejected instead of racing retention or restore', async () => {
        const pending = backups.create();
        await expect(backups.create()).rejects.toThrow('already running');
        await pending;
    });
});
