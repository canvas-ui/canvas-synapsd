import { describe, expect, test } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import SynapsD from '../src/index.js';
import ContextTree from '../src/views/ContextTree.js';
import DirectoryTree from '../src/views/DirectoryTree.js';

class MemoryStore {
    #data = new Map();

    get(key) { return this.#data.get(key); }
    doesExist(key) { return this.#data.has(key); }
    async put(key, value) { this.#data.set(key, value); }
    async remove(key) { this.#data.delete(key); }

    async *getKeys({ start = '', end = '\uffff' } = {}) {
        for (const key of [...this.#data.keys()].sort()) {
            if (key >= start && key <= end) {
                yield key;
            }
        }
    }
}

const createContextTree = async () => {
    const tree = new ContextTree({
        dataStore: new MemoryStore(),
        treeId: 'test-context-tree',
        treeName: 'context',
    });
    await tree.initialize();
    return tree;
};

const createDirectoryTree = async () => {
    const tree = new DirectoryTree({
        dataStore: new MemoryStore(),
        bitmapIndex: { createCollection: () => ({}) },
        treeId: 'test-directory-tree',
        treeName: 'directory',
    });
    await tree.initialize();
    return tree;
};

describe('canvas tree semantics', () => {
    test('canvas and context layers can share a display name in different namespaces', async () => {
        const tree = await createContextTree();

        const contextResult = await tree.insertPath('/foo/files');
        const canvasResult = await tree.insertPath('/bar/Files', {
            leafType: 'canvas',
            querySpec: { features: ['feature/email'], filters: ['filter/today'] },
            metadata: { layout: 'mailbox' },
        });

        expect(contextResult.error).toBeNull();
        expect(canvasResult.error).toBeNull();

        const contextLayer = tree.getLayerForPath('/foo/files');
        const canvasLayer = tree.getLayerForPath('/bar/Files');

        expect(contextLayer.type).toBe('context');
        expect(canvasLayer.type).toBe('canvas');
        expect(canvasLayer.id).not.toBe(contextLayer.id);
        expect(tree.getLayer('files').id).toBe(contextLayer.id);
        expect(tree.getLayer('Files', { type: 'canvas' }).id).toBe(canvasLayer.id);
    });

    test('creating a canvas does not upgrade an existing same-name context layer', async () => {
        const tree = await createContextTree();

        await tree.insertPath('/bar/test1');
        const contextLayer = tree.getLayerForPath('/bar/test1');
        const result = await tree.insertPath('/foo/test1', { leafType: 'canvas' });
        const canvasLayer = tree.getLayerForPath('/foo/test1');

        expect(result.error).toBeNull();
        expect(contextLayer.type).toBe('context');
        expect(canvasLayer.type).toBe('canvas');
        expect(canvasLayer.id).not.toBe(contextLayer.id);
    });

    test('canvas leaves are stored views, not path bitmap layers', async () => {
        const tree = await createContextTree();

        await tree.insertPath('/foo/Files', { leafType: 'canvas' });

        const fooLayer = tree.getLayerForPath('/foo');
        const canvasLayer = tree.getLayerForPath('/foo/Files');

        expect(canvasLayer.type).toBe('canvas');
        expect(tree.resolveLayerIds(['foo', 'Files'])).toEqual([fooLayer.id]);
    });

    test('reusing a canvas rejects duplicate placement under the same parent', async () => {
        const tree = await createContextTree();

        await tree.insertPath('/foo/shared', { leafType: 'canvas' });
        await tree.insertPath('/bar');
        await tree.copyPath('/foo/shared', '/bar');

        const moveResult = await tree.movePath('/bar/shared', '/foo');

        expect(moveResult.error).toContain('already contains');
        await expect(tree.copyPath('/foo/shared', '/bar')).rejects.toThrow('already contains');
    });

    test('directory tree move and copy reject duplicate folder targets', async () => {
        const tree = await createDirectoryTree();

        await tree.insertPath('/a/foo');
        await tree.insertPath('/b/foo');

        await expect(tree.movePath('/a/foo', '/b/foo')).rejects.toThrow('already exists');
        await expect(tree.copyPath('/a/foo', '/b/foo')).rejects.toThrow('already exists');
    });

    test('startup repairs missing context root bitmap from documents source', async () => {
        const dbPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-root-canvas-'));
        let db = new SynapsD({ path: dbPath, backupOnOpen: false, backupOnClose: false });

        try {
            await db.start();
            const tree = db.getDefaultContextTree();

            await db.put({
                schema: 'data/abstraction/note',
                data: { content: 'dev note' },
            }, { context: { tree: tree.id, path: '/dev' } });
            await tree.insertPath('/Files', { leafType: 'canvas' });

            // Simulate older datasets where root membership was not backfilled.
            await tree.collection.deleteBitmap(tree.rootLayer.id);
            await db.shutdown();

            db = new SynapsD({ path: dbPath, backupOnOpen: false, backupOnClose: false });
            await db.start();
            const repairedTree = db.getDefaultContextTree();

            const result = await db.list({ context: { tree: repairedTree.id, path: '/Files' } });

            expect(result.error).toBeNull();
            expect(result.count).toBe(1);
            expect(result[0].data.content).toBe('dev note');
        } finally {
            await db.shutdown().catch(() => null);
            await fs.rm(dbPath, { recursive: true, force: true });
        }
    });

    test('canvas directly under root composes saved feature filters with root data', async () => {
        const dbPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-root-canvas-filter-'));
        const db = new SynapsD({ path: dbPath, backupOnOpen: false, backupOnClose: false });

        try {
            await db.start();
            const tree = db.getDefaultContextTree();

            await db.put({
                schema: 'data/abstraction/file',
                data: { filename: 'invoice.pdf', mime: 'application/pdf' },
                checksumArray: ['sha256:file'],
            }, { context: { tree: tree.id, path: '/dev' } });
            await db.put({
                schema: 'data/abstraction/note',
                data: { content: 'note' },
            }, { context: { tree: tree.id, path: '/dev' } });
            await tree.insertPath('/Files', {
                leafType: 'canvas',
            });

            const result = await db.list({
                context: { tree: tree.id, path: '/Files' },
                features: { allOf: ['data/abstraction/file'] },
            });

            expect(result.error).toBeNull();
            expect(result.count).toBe(1);
            expect(result[0].schema).toBe('data/abstraction/file');
        } finally {
            await db.shutdown().catch(() => null);
            await fs.rm(dbPath, { recursive: true, force: true });
        }
    });

    test('startup repairs stale context root bitmap from documents source', async () => {
        const dbPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-root-canvas-stale-root-'));
        let db = new SynapsD({ path: dbPath, backupOnOpen: false, backupOnClose: false });

        try {
            await db.start();
            const tree = db.getDefaultContextTree();

            const fileId = await db.put({
                schema: 'data/abstraction/file',
                data: { filename: 'invoice.pdf', mime: 'application/pdf' },
                checksumArray: ['sha256:file'],
            }, { context: { tree: tree.id, path: '/dev' } });
            const noteId = await db.put({
                schema: 'data/abstraction/note',
                data: { content: 'note' },
            }, { context: { tree: tree.id, path: '/dev' } });
            await tree.insertPath('/Files', { leafType: 'canvas' });

            // Simulate old/bad root membership: non-empty, but missing the file.
            await tree.collection.deleteBitmap(tree.rootLayer.id);
            await tree.collection.tick(tree.rootLayer.id, noteId);
            await db.shutdown();

            db = new SynapsD({ path: dbPath, backupOnOpen: false, backupOnClose: false });
            await db.start();
            const repairedTree = db.getDefaultContextTree();

            const result = await db.list({
                context: { tree: repairedTree.id, path: '/Files' },
                features: { allOf: ['data/abstraction/file'] },
            });

            expect(result.error).toBeNull();
            expect(result.count).toBe(1);
            expect(result[0].id).toBe(fileId);
        } finally {
            await db.shutdown().catch(() => null);
            await fs.rm(dbPath, { recursive: true, force: true });
        }
    });
});
