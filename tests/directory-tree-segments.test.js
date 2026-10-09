import { describe, expect, test } from '@jest/globals';

import DirectoryTree from '../src/views/DirectoryTree.js';

class MemoryStore {
    #data = new Map();

    get(key) { return this.#data.get(key); }
    doesExist(key) { return this.#data.has(key); }
    async put(key, value) { this.#data.set(key, value); }
    putSync(key, value) { this.#data.set(key, value); }
    async remove(key) { this.#data.delete(key); }

    async *getKeys({ start = '', end = '￿' } = {}) {
        for (const key of [...this.#data.keys()].sort()) {
            if (key >= start && key <= end) {
                yield key;
            }
        }
    }
}

const createDirectoryTree = async () => {
    const tree = new DirectoryTree({
        dataStore: new MemoryStore(),
        bitmapIndex: { createCollection: () => ({ deleteBitmap: async () => null }) },
        treeId: 'test-directory-tree',
        treeName: 'directory',
    });
    await tree.initialize();
    return tree;
};

describe('directory tree segments + backend locks', () => {
    test('colon survives in path segments (backend addresses like ws:mount)', async () => {
        const tree = await createDirectoryTree();

        const result = await tree.insertPath('/device/nas/ws:mount/foo');
        expect(result.error).toBeNull();
        expect(tree.pathExists('/device/nas/ws:mount/foo')).toBe(true);
        expect(tree.paths).toContain('/device/nas/ws:mount/foo');

        const node = tree.getLayerForPath('/device/nas/ws:mount');
        expect(node?.name).toBe('ws:mount');
    });

    test('@ survives in path segments (imap accounts)', async () => {
        const tree = await createDirectoryTree();
        await tree.insertPath('/imap/me@idnc.sk/Inbox');
        expect(tree.pathExists('/imap/me@idnc.sk/Inbox')).toBe(true);
    });

    test('system lock blocks removePath of the node but not child creation/removal', async () => {
        const tree = await createDirectoryTree();
        await tree.insertPath('/workspace/home');
        await tree.lockPath('/workspace/home', 'system:backend:workspace:home');

        // Locked node cannot be removed
        await expect(tree.removePath('/workspace/home', true)).rejects.toThrow(/locked/i);

        // Children remain creatable (system locks do not cascade) and removable
        const inserted = await tree.insertPath('/workspace/home/sub', { ignoreLocks: true });
        expect(inserted.error).toBeNull();
        const removed = await tree.removePath('/workspace/home/sub', true);
        expect(removed.error).toBeNull();
    });

    test('storage projection moves a subtree below a protected root without recreating its nodes', async () => {
        const tree = await createDirectoryTree();
        await tree.insertPath('/workspace/home/Kitchen/Empty');
        await tree.lockPath('/workspace/home', 'system:backend:workspace:home');
        const ids = tree.getNodeIdsForPath('/workspace/home/Kitchen', { recursive: true });
        await expect(tree.movePath('/workspace/home/Kitchen', '/workspace/home/Kitchens')).rejects.toThrow(/locked/i);
        await tree.movePath('/workspace/home/Kitchen', '/workspace/home/Kitchens', true, { ignoreLocks: true });
        expect(tree.getNodeIdsForPath('/workspace/home/Kitchens', { recursive: true })).toEqual(ids);
        expect(tree.pathExists('/workspace/home/Kitchen')).toBe(false);
        expect(tree.getLayerForPath('/workspace/home').lockedBy).toContain('system:backend:workspace:home');
        await expect(tree.removePath('/workspace/home', true)).rejects.toThrow(/locked/i);
        await expect(tree.movePath('/workspace/home/Kitchens', '/workspace/home/Kitchens/inside', true, { ignoreLocks: true })).rejects.toThrow(/itself/);
    });

    test('system unlock then removePath succeeds', async () => {
        const tree = await createDirectoryTree();
        await tree.insertPath('/imap/me@idnc.sk');
        await tree.lockPath('/imap/me@idnc.sk', 'system:backend:imap:mb1');

        await tree.unlockPath('/imap/me@idnc.sk', 'system:backend:imap:mb1', { system: true });
        const removed = await tree.removePath('/imap/me@idnc.sk', true);
        expect(removed.error).toBeNull();
        expect(tree.pathExists('/imap/me@idnc.sk')).toBe(false);
    });

    test('multiple holders on one node: node stays locked until all release', async () => {
        const tree = await createDirectoryTree();
        await tree.insertPath('/imap/me@idnc.sk');
        await tree.lockPath('/imap/me@idnc.sk', 'system:backend:imap:mb1');
        await tree.lockPath('/imap/me@idnc.sk', 'system:backend:imap:mb2');

        await tree.unlockPath('/imap/me@idnc.sk', 'system:backend:imap:mb1', { system: true });
        await expect(tree.removePath('/imap/me@idnc.sk', true)).rejects.toThrow(/locked/i);

        await tree.unlockPath('/imap/me@idnc.sk', 'system:backend:imap:mb2', { system: true });
        const removed = await tree.removePath('/imap/me@idnc.sk', true);
        expect(removed.error).toBeNull();
    });

    test('folders created implicitly by filing are announced as tree.path.inserted', async () => {
        const tree = await createDirectoryTree();
        await tree.insertPath('/workspace/home');
        const seen = [];
        tree.on('tree.path.inserted', (event) => seen.push(event.path ?? event.payload?.path));

        await tree.ensurePaths(['/workspace/home/photos/2026']);
        expect(seen).toEqual(['/workspace/home/photos', '/workspace/home/photos/2026']);

        // Existing folders stay quiet.
        seen.length = 0;
        await tree.ensurePaths(['/workspace/home/photos/2026']);
        expect(seen).toEqual([]);

        // insertPath announces the leaf once, plus the parents it had to create.
        await tree.insertPath('/a/b/c');
        expect(seen).toEqual(['/a', '/a/b', '/a/b/c']);

        seen.length = 0;
        const original = tree.getLayerForPath('/a/b/c');
        for (let i = 0; i < 20; i++) {
            const result = await tree.insertPath('/a/b/c', { ignoreLocks: true });
            expect(result.data).toEqual([original.id]);
        }
        expect(seen).toEqual([]);
    });

    test('upserting an existing canvas announces only actual metadata changes', async () => {
        const tree = await createDirectoryTree();
        const inserted = [];
        const updated = [];
        tree.on('tree.path.inserted', event => inserted.push(event.path));
        tree.on('tree.layer.updated', event => updated.push(event.path));
        await tree.insertPath('/view', { leafType: 'canvas', label: 'One' });
        await tree.insertPath('/view', { leafType: 'canvas', label: 'One' });
        await tree.insertPath('/view', { leafType: 'canvas', label: 'Two' });
        expect(inserted).toEqual(['/view']);
        expect(updated).toEqual(['/view']);
        expect(tree.getLayerForPath('/view').label).toBe('Two');

        await tree.insertPath('/folder');
        await tree.insertPath('/folder', { leafType: 'canvas' });
        expect(updated).toEqual(['/view', '/folder']);
    });
});
