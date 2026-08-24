import { describe, expect, test } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import SynapsD from '../src/index.js';

const NOTE = (content) => ({ schema: 'data/schema/note', data: { content } });

const withDb = async (fn) => {
    const dbPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-merge-down-'));
    const db = new SynapsD({ path: dbPath, backupOnOpen: false, backupOnClose: false });
    try {
        await db.start();
        await fn(db, db.getDefaultContextTree());
    } finally {
        await db.shutdown().catch(() => null);
        await fs.rm(dbPath, { recursive: true, force: true });
    }
};

const ids = async (db, tree, p) => {
    const res = await db.list({ context: { tree: tree.id, path: p } });
    expect(res.error).toBeNull();
    return res.map((doc) => doc.id).sort();
};

describe('ContextTree mergeDown / subtractDown', () => {
    test('moved node reads 0 docs until mergeDown ORs its bitmap into the new ancestors', async () => {
        await withDb(async (db, tree) => {
            const rock = await db.put(NOTE('rock'), { context: { tree: tree.id, path: '/home/music/rock' } });
            await db.put(NOTE('jazz'), { context: { tree: tree.id, path: '/home/music/jazz' } });
            await tree.insertPath('/music/playlists/genre');

            const moved = await tree.movePath('/home/music/rock', '/music/playlists/genre');
            expect(moved.error).toBeNull();
            // As designed: the new ancestors don't carry rock's bits → AND is empty
            expect(await ids(db, tree, '/music/playlists/genre/rock')).toEqual([]);

            const merged = await tree.mergeDown('/music/playlists/genre/rock');
            expect(merged.error).toBeNull();
            expect(merged.data.targets).toHaveLength(3); // music, playlists, genre
            // `music` is ONE layer shared by /home/music and /music — it already
            // had rock's bits, so only playlists + genre actually changed.
            expect(merged.data.affected).toHaveLength(2);

            expect(await ids(db, tree, '/music/playlists/genre/rock')).toEqual([rock]);
            expect(await ids(db, tree, '/music/playlists')).toEqual([rock]);
            // Untouched siblings: jazz stays where it was, rock never leaked into it
            expect(await ids(db, tree, '/home/music/jazz')).not.toContain(rock);
        });
    });

    test('mergeDown is a no-op on a top-level path and refuses root / canvas leaves', async () => {
        await withDb(async (db, tree) => {
            await db.put(NOTE('top'), { context: { tree: tree.id, path: '/top' } });
            const noop = await tree.mergeDown('/top');
            expect(noop.error).toBeNull();
            expect(noop.data.targets).toEqual([]);
            expect(noop.count).toBe(0);

            expect((await tree.mergeDown('/')).error).toMatch(/root/i);

            await tree.insertPath('/top/View', { leafType: 'canvas' });
            expect((await tree.mergeDown('/top/View')).error).toMatch(/canvas/i);
            expect((await tree.mergeDown('/does/not/exist')).error).toMatch(/does not exist/i);
        });
    });

    test('subtractDown reverses a mergeDown', async () => {
        await withDb(async (db, tree) => {
            const piano = await db.put(NOTE('piano'), { context: { tree: tree.id, path: '/home/hudba/instrument/piano' } });
            const other = await db.put(NOTE('other'), { context: { tree: tree.id, path: '/home/other' } });
            await tree.insertPath('/home/playlist');
            const moved = await tree.movePath('/home/hudba/instrument/piano', '/home/playlist');
            expect(moved.error).toBeNull();

            const merged = await tree.mergeDown('/home/playlist/piano');
            expect(merged.error).toBeNull();
            expect(await ids(db, tree, '/home/playlist/piano')).toEqual([piano]);
            expect(await ids(db, tree, '/home/playlist')).toEqual([piano]);

            const sub = await tree.subtractDown('/home/playlist/piano');
            expect(sub.error).toBeNull();
            expect(sub.data.targets).toHaveLength(2); // home, playlist
            expect(await ids(db, tree, '/home/playlist')).toEqual([]);
            expect(await ids(db, tree, '/home/playlist/piano')).toEqual([]);
            // Home still has the doc that lived there for other reasons
            expect(await ids(db, tree, '/home')).toEqual([other]);
            // The leaf's own bitmap is untouched
            expect(await ids(db, tree, '/home/playlist/piano')).toEqual([]);
            const own = await db.list({ context: { tree: tree.id, path: '/' }, features: null });
            expect(own.map((d) => d.id)).toEqual(expect.arrayContaining([piano, other]));
        });
    });

    test('movePath(..., { mergeDown: true }) merges in one step', async () => {
        await withDb(async (db, tree) => {
            const rock = await db.put(NOTE('rock'), { context: { tree: tree.id, path: '/home/music/rock' } });
            await tree.insertPath('/music/playlists/genre');

            const events = [];
            tree.on('tree.layer.merged', (payload) => events.push(payload));

            const moved = await tree.movePath('/home/music/rock', '/music/playlists/genre', false, { mergeDown: true });
            expect(moved.error).toBeNull();
            expect(moved.data.mergeDown.targets).toHaveLength(3);
            expect(await ids(db, tree, '/music/playlists/genre/rock')).toEqual([rock]);
            expect(events).toHaveLength(1);
            expect(events[0].direction ?? events[0].data?.direction ?? events[0].payload?.direction).toBeDefined();

            // Plain move (default) still leaves bitmaps alone
            await tree.insertPath('/archive');
            const plain = await tree.movePath('/music/playlists/genre/rock', '/archive');
            expect(plain.error).toBeNull();
            expect(plain.data.mergeDown).toBeUndefined();
            expect(await ids(db, tree, '/archive/rock')).toEqual([]);
        });
    });
});
