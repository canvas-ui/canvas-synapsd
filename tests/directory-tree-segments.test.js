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
    test('colon survives in path segments (backend addresses like workspace:home)', async () => {
        const tree = await createDirectoryTree();

        const result = await tree.insertPath('/.backends/file/workspace:home/foo');
        expect(result.error).toBeNull();
        expect(tree.pathExists('/.backends/file/workspace:home/foo')).toBe(true);
        expect(tree.paths).toContain('/.backends/file/workspace:home/foo');

        const node = tree.getLayerForPath('/.backends/file/workspace:home');
        expect(node?.name).toBe('workspace:home');
    });

    test('@ survives in path segments (imap accounts)', async () => {
        const tree = await createDirectoryTree();
        await tree.insertPath('/.backends/imap/me@idnc.sk/Inbox');
        expect(tree.pathExists('/.backends/imap/me@idnc.sk/Inbox')).toBe(true);
    });

    test('system lock blocks removePath of the node but not child creation/removal', async () => {
        const tree = await createDirectoryTree();
        await tree.insertPath('/.backends/file/workspace:home');
        await tree.lockPath('/.backends/file/workspace:home', 'system:backend:workspace:home');

        // Locked node cannot be removed
        await expect(tree.removePath('/.backends/file/workspace:home', true)).rejects.toThrow(/locked/i);

        // Children remain creatable (system locks do not cascade) and removable
        const inserted = await tree.insertPath('/.backends/file/workspace:home/sub', { ignoreLocks: true });
        expect(inserted.error).toBeNull();
        const removed = await tree.removePath('/.backends/file/workspace:home/sub', true);
        expect(removed.error).toBeNull();
    });

    test('system unlock then removePath succeeds', async () => {
        const tree = await createDirectoryTree();
        await tree.insertPath('/.backends/imap/me@idnc.sk');
        await tree.lockPath('/.backends/imap/me@idnc.sk', 'system:backend:imap:mb1');

        await tree.unlockPath('/.backends/imap/me@idnc.sk', 'system:backend:imap:mb1', { system: true });
        const removed = await tree.removePath('/.backends/imap/me@idnc.sk', true);
        expect(removed.error).toBeNull();
        expect(tree.pathExists('/.backends/imap/me@idnc.sk')).toBe(false);
    });

    test('multiple holders on one node: node stays locked until all release', async () => {
        const tree = await createDirectoryTree();
        await tree.insertPath('/.backends/imap/me@idnc.sk');
        await tree.lockPath('/.backends/imap/me@idnc.sk', 'system:backend:imap:mb1');
        await tree.lockPath('/.backends/imap/me@idnc.sk', 'system:backend:imap:mb2');

        await tree.unlockPath('/.backends/imap/me@idnc.sk', 'system:backend:imap:mb1', { system: true });
        await expect(tree.removePath('/.backends/imap/me@idnc.sk', true)).rejects.toThrow(/locked/i);

        await tree.unlockPath('/.backends/imap/me@idnc.sk', 'system:backend:imap:mb2', { system: true });
        const removed = await tree.removePath('/.backends/imap/me@idnc.sk', true);
        expect(removed.error).toBeNull();
    });
});
