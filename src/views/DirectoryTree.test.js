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
        bitmapIndex: { createCollection: () => ({ deleteBitmap: async () => null }) },
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
});
