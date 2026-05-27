import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import DirectoryTree from './DirectoryTree.js';

function createStore() {
    const data = new Map();
    return {
        get: (key) => data.get(key),
        put: async (key, value) => { data.set(key, value); },
        remove: async (key) => { data.delete(key); },
    };
}

function createTree() {
    return new DirectoryTree({
        dataStore: createStore(),
        bitmapIndex: { createCollection: () => ({ tick: async () => null, makeKey: (id) => id, deleteBitmap: async () => null }) },
        treeId: 'directory-test',
        treeName: 'directory',
    });
}

describe('DirectoryTree', () => {
    test('creates canvas nodes with query specs', async () => {
        const tree = createTree();
        await tree.initialize();

        await tree.insertPath('/inbox/project-foo', {
            leafType: 'canvas',
            querySpec: { q: 'Project FOO' },
            metadata: { toolbox: true },
        });

        const canvas = tree.getLayerForPath('/inbox/project-foo');
        assert.equal(canvas.type, 'canvas');
        assert.equal(canvas.querySpec.query, 'Project FOO');
        assert.deepEqual(canvas.metadata, { toolbox: true });
        assert.equal(tree.buildJsonTree().children[0].children[0].type, 'canvas');
    });

    test('rejects replacing a directory with a canvas', async () => {
        const tree = createTree();
        await tree.initialize();
        await tree.insertPath('/inbox/archive');

        const result = await tree.insertPath('/inbox', { leafType: 'canvas' });

        assert.match(result.error, /already exists as type "directory"/);
    });

    test('converts empty directory leaf to canvas on repeated create', async () => {
        const tree = createTree();
        await tree.initialize();
        await tree.insertPath('/inbox/test-mbox');

        const result = await tree.insertPath('/inbox/test-mbox', {
            leafType: 'canvas',
            querySpec: { query: 'Project FOO' },
        });

        assert.equal(result.error, null);
        assert.equal(tree.getLayerForPath('/inbox/test-mbox').type, 'canvas');
        assert.equal(tree.getLayerForPath('/inbox/test-mbox').querySpec.query, 'Project FOO');
    });

    test('locks directory subtrees and inherits locks for new children', async () => {
        const tree = createTree();
        await tree.initialize();
        await tree.insertPath('/.incoming', { ignoreLocks: true });
        await tree.lockPath('/.incoming', 'system:incoming', { recursive: true });

        await assert.rejects(
            () => tree.insertPath('/.incoming/fs/home'),
            /Layer is locked/
        );

        await tree.put(1, '/.incoming/fs/home');

        const incoming = tree.getLayerForPath('/.incoming');
        const child = tree.getLayerForPath('/.incoming/fs/home');
        assert.equal(incoming.locked, true);
        assert.deepEqual(incoming.lockedBy, ['system:incoming']);
        assert.equal(child.locked, true);
        assert.deepEqual(child.lockedBy, ['system:incoming']);

        await assert.rejects(
            () => tree.removePath('/.incoming/fs/home'),
            /Layer is locked/
        );
        await assert.rejects(
            () => tree.unlockPath('/.incoming', 'system:incoming'),
            /System locks cannot be removed/
        );
    });

    test('returns bitmap snapshots from find', async () => {
        const cachedBitmap = {
            values: new Set([1]),
            clone() {
                return {
                    values: new Set(this.values),
                    clone: this.clone,
                    orInPlace(other) {
                        for (const value of other.values) {
                            this.values.add(value);
                        }
                    },
                };
            },
        };
        const tree = new DirectoryTree({
            dataStore: createStore(),
            bitmapIndex: { createCollection: () => ({ tick: async () => null, getBitmap: async () => cachedBitmap }) },
            treeId: 'directory-test',
            treeName: 'directory',
        });
        await tree.initialize();
        await tree.insertPath('/inbox');

        const firstRead = await tree.find('/inbox');
        firstRead.orInPlace({ values: new Set([2]) });
        const secondRead = await tree.find('/inbox');

        assert.deepEqual([...cachedBitmap.values], [1]);
        assert.deepEqual([...secondRead.values], [1]);
    });
});
