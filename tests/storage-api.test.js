import { test, expect } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { open as nativeOpen } from 'lmdb';
import { openKeyValueStore, verifyDatabase } from '../src/storage.js';

test('key/value storage reads existing Stored environments and preserves transactions across named stores', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-kv-'));
    const native = nativeOpen({ path: root, name: 'metadata', compression: true, maxDbs: 64 });
    native.putSync('object', { content: 'original'.repeat(1000) });
    native.openDB('paths').putSync('home:file', 'object');
    await native.close();
    const store = openKeyValueStore({ path: root, name: 'metadata', compression: true });
    try {
        const paths = store.openDB({ name: 'paths' });
        expect(paths.get('home:file')).toBe('object');
        expect(store.get('object').content).toBe('original'.repeat(1000));
        expect(() => store.transactionSync(() => {
            store.putSync('rolled-back', { value: true });
            paths.putSync('rolled-back', 'rolled-back');
            throw new Error('abort');
        })).toThrow('abort');
        expect(store.get('rolled-back')).toBeUndefined();
        expect(paths.get('rolled-back')).toBeUndefined();
        expect(store.openDB('absent', { create: false })).toBeUndefined();
    } finally { await store.close(); }
    try {
        const result = await verifyDatabase(root);
        expect(result.datasets.metadata.count).toBe(1);
        expect(result.datasets.paths.count).toBe(1);
        expect(await fs.readdir(root)).not.toContain('backup');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('verification isolates a truncated mmap, reports its path and preserves the data file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-truncated-'));
    try {
        const db = openKeyValueStore({ path: root, name: 'metadata' });
        for (let i = 0; i < 40; i++) { db.putSync(`object-${i}`, { payload: 'payload'.repeat(1000) }); }
        await db.close();
        const file = path.join(root, 'data.mdb');
        await fs.truncate(file, 8192); // valid metapages referencing pages beyond EOF
        const before = await fs.readFile(file);
        await expect(verifyDatabase(root)).rejects.toMatchObject({ code: 'DATABASE_INTEGRITY_FAILED', databasePath: file });
        expect(await fs.readFile(file)).toEqual(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('verification of a first-run directory does not create it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-absent-'));
    try {
        expect(await verifyDatabase(path.join(root, 'absent'))).toBeNull();
        expect(await fs.readdir(root)).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
