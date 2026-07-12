import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/abstraction/note';

function note(title, content = title) {
    return {
        schema: NOTE_SCHEMA,
        data: { title, content },
    };
}

describe('tree settings bag + linkContextRoot + linked/unlinked query', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-test-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) {
            await db.shutdown().catch(() => {});
            db = null;
        }
        if (rootPath) {
            await fs.rm(rootPath, { recursive: true, force: true });
            rootPath = null;
        }
    });

    async function createMirrorTree() {
        return await db.createTree('mirror', 'directory', {
            settings: { linkContextRoot: false, protected: true },
        });
    }

    test('createTree persists settings and exposes them on instances across restart', async () => {
        const meta = await createMirrorTree();
        expect(meta.settings).toEqual({ linkContextRoot: false, protected: true });

        const tree = db.getTree('mirror');
        expect(tree.settings.linkContextRoot).toBe(false);

        await db.shutdown();
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();

        const reloaded = (await db.listTrees('directory')).find((t) => t.name === 'mirror');
        expect(reloaded.settings).toEqual({ linkContextRoot: false, protected: true });
        expect(db.getTree('mirror').settings.linkContextRoot).toBe(false);
    });

    test('directory-only insert ticks the default context root unless linkContextRoot is false', async () => {
        await createMirrorTree();
        const contextTree = db.getDefaultContextTree();
        const rootKey = contextTree.collection.makeKey(contextTree.rootLayer.id);

        const defaultDirId = await db.put(note('in default dir tree'), {
            context: null,
            directory: { path: '/inbox' },
        });
        expect(await db.synapses.listSynapses(defaultDirId)).toContain(rootKey);

        const mirrorId = await db.put(note('in mirror tree'), {
            context: null,
            directory: { tree: 'mirror', path: '/imap/me@idnc.sk/Inbox' },
        });
        expect(await db.synapses.listSynapses(mirrorId)).not.toContain(rootKey);
    });

    test('removePath cleans member documents from the synapse reverse index', async () => {
        await createMirrorTree();
        const docId = await db.put(note('mirrored doc'), {
            context: null,
            directory: { tree: 'mirror', path: '/file/workspace:home/projects' },
        });

        const tree = db.getTree('mirror');
        // makeKey('/') yields the normalized collection prefix (synapse keys are
        // stored normalized/lowercased).
        const prefix = tree.collection.makeKey('/');
        const before = await db.synapses.listSynapses(docId);
        expect(before.some((key) => key.startsWith(prefix))).toBe(true);

        const removed = await tree.removePath('/file', true);
        expect(removed.error).toBeNull();
        expect(removed.data.removedNodeIds.length).toBeGreaterThanOrEqual(3);

        const after = await db.synapses.listSynapses(docId);
        expect(after.some((key) => key.startsWith(prefix))).toBe(false);
    });

    test('removePath honors ignoreLocks for system-locked nodes', async () => {
        await createMirrorTree();
        const tree = db.getTree('mirror');
        await tree.insertPath('/imap/me@idnc.sk');
        await tree.lockPath('/imap/me@idnc.sk', 'system:backend:imap:mb1');

        await expect(tree.removePath('/imap/me@idnc.sk', true)).rejects.toThrow(/locked/i);
        const removed = await tree.removePath('/imap/me@idnc.sk', true, { ignoreLocks: true });
        expect(removed.error).toBeNull();
        expect(tree.pathExists('/imap/me@idnc.sk')).toBe(false);
    });

    test('listTreeDocuments filters by linkage into other trees', async () => {
        await createMirrorTree();

        const unfiledId = await db.put(note('mirror only'), {
            context: null,
            directory: { tree: 'mirror', path: '/imap/me@idnc.sk/Inbox' },
        });
        const filedContextId = await db.put(note('mirror + context'), {
            context: { path: '/Projects/Alpha' },
            directory: { tree: 'mirror', path: '/imap/me@idnc.sk/Inbox' },
        });
        // File a third doc into both the mirror tree and the default directory tree.
        const bothTreesId = await db.put(note('mirror + dir tree'), {
            context: null,
            directory: { tree: 'mirror', path: '/imap/me@idnc.sk/Archive' },
        });
        await db.link(bothTreesId, { directory: { path: '/filed' } });

        const all = await db.listTreeDocuments('mirror', { idsOnly: true });
        expect(all.ids.sort((a, b) => a - b)).toEqual([unfiledId, filedContextId, bothTreesId].sort((a, b) => a - b));

        const unlinked = await db.listTreeDocuments('mirror', { linked: false, idsOnly: true });
        expect(unlinked.ids).toEqual([unfiledId]);

        const linked = await db.listTreeDocuments('mirror', { linked: true, idsOnly: true });
        expect(linked.ids.sort((a, b) => a - b)).toEqual([filedContextId, bothTreesId].sort((a, b) => a - b));

        // Path-scoped: only Inbox
        const inboxUnlinked = await db.listTreeDocuments('mirror', {
            path: '/imap/me@idnc.sk/Inbox',
            linked: false,
            idsOnly: true,
        });
        expect(inboxUnlinked.ids).toEqual([unfiledId]);

        // Document form returns hydrated docs
        const docs = await db.listTreeDocuments('mirror', { linked: false });
        expect(docs.count).toBe(1);
        expect(docs.documents[0].id).toBe(unfiledId);
    });

    test('directory selector with recursive:true scopes queries to the whole subtree', async () => {
        await createMirrorTree();
        const inboxId = await db.put(note('recursive inbox doc'), {
            context: null,
            directory: { tree: 'mirror', path: '/imap/me@idnc.sk/Inbox' },
        });
        const archiveId = await db.put(note('recursive archive doc'), {
            context: null,
            directory: { tree: 'mirror', path: '/imap/me@idnc.sk/Archive' },
        });

        // Node-exact (default): docs tick only their leaf node, an ancestor
        // folder scope matches nothing.
        const exact = await db.list({ directory: { tree: 'mirror', path: '/imap' } });
        expect(exact.map((d) => d.id)).toEqual([]);

        // Recursive: the ancestor folder covers the whole subtree.
        const recursive = await db.list({ directory: { tree: 'mirror', path: '/imap', recursive: true } });
        expect(recursive.map((d) => d.id).sort((a, b) => a - b))
            .toEqual([inboxId, archiveId].sort((a, b) => a - b));

        // Scoped to one branch stays scoped.
        const branch = await db.list({
            directory: { tree: 'mirror', path: '/imap/me@idnc.sk/Inbox', recursive: true },
        });
        expect(branch.map((d) => d.id)).toEqual([inboxId]);
    });
});
