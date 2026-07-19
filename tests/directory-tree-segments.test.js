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
});
