import { expect, test } from '@jest/globals';
import DirectoryTree from '../src/views/DirectoryTree.js';

function fixture(rows) {
    const records = new Map(rows.map(row => [`nodes/${row.id}`, row]));
    const tree = new DirectoryTree({
        dataStore: { get: key => records.get(key), put: () => { throw new Error('Existing tree must not be rewritten'); } },
        bitmapIndex: { createCollection: () => ({}) }, treeId: 'test-tree',
    });
    return { tree, records };
}

test('loading a large directory tree gives sockets and timers a turn', async () => {
    const children = Array.from({ length: 1024 }, (_, i) => ({ id: `n${i}`, name: `folder${i}`, parentId: 'root', childIds: [] }));
    const { tree } = fixture([{ id: 'root', name: '/', childIds: children.map(child => child.id) }, ...children]);
    let heartbeat = false;
    const marker = new Promise(resolve => setImmediate(() => { heartbeat = true; resolve(); }));
    await tree.initialize();
    expect(heartbeat).toBe(true);
    expect((await tree.listDirectories('/')).length).toBe(children.length);
    expect(await tree.getPathByNodeId('n1023')).toBe('/folder1023');
    await marker;
});

test.each([
    { name: 'child cycle', nodes: [{ id: 'root', childIds: ['a'] }, { id: 'a', childIds: ['root'] }] },
    { name: 'shared child', nodes: [{ id: 'root', childIds: ['a', 'b'] }, { id: 'a', childIds: ['b'] }, { id: 'b', childIds: [] }] },
])('$name fails startup without modifying stored nodes or exposing a partial tree', async ({ nodes }) => {
    const { tree, records } = fixture(nodes);
    const before = structuredClone([...records]);
    await expect(tree.initialize()).rejects.toMatchObject({ code: 'CORRUPT_TREE', treeId: 'test-tree' });
    expect(tree.root).toBeNull();
    expect([...records]).toEqual(before);
});

test('cyclic parent pointers reject path lookup instead of spinning indefinitely', async () => {
    const { tree } = fixture([
        { id: 'root', name: '/', childIds: ['a'] },
        { id: 'a', name: 'a', parentId: 'b', childIds: ['b'] },
        { id: 'b', name: 'b', parentId: 'a', childIds: [] },
    ]);
    await tree.initialize();
    await expect(tree.getPathByNodeId('a')).rejects.toMatchObject({ code: 'CORRUPT_TREE' });
});

test('failed reload retains the last complete in-memory tree', async () => {
    const { tree, records } = fixture([{ id: 'root', name: '/', childIds: ['a'] }, { id: 'a', name: 'a', parentId: 'root' }]);
    await tree.initialize();
    const root = tree.root;
    records.set('nodes/a', { id: 'a', name: 'a', parentId: 'root', childIds: ['a'] });
    await expect(tree.reload()).rejects.toMatchObject({ code: 'CORRUPT_TREE' });
    expect(tree.root).toBe(root);
    expect(tree.pathExists('/a')).toBe(true);
});
