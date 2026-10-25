'use strict';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const note = (title) => ({ schema: 'data/schema/note', data: { title, content: title } });
const sorted = (ids) => [...ids].map(Number).sort((a, b) => a - b);

// A context path also lists what is filed at its deeper paths (/dc-migration
// shows a document filed at /dc-migration/tasks/foo). `currentPathOnly` keeps
// the documents filed at the path itself, as one bitmap operation.
describe('currentPathOnly context selectors', () => {
    let rootPath;
    let db;
    let tree;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-current-path-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
        await db.createTree('projects', 'context', { isDefault: false });
        tree = db.getTree('projects');
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    const at = (treePath, currentPathOnly = false) => ({ context: { tree: tree.id, path: treePath, ...(currentPathOnly ? { currentPathOnly: true } : {}) } });

    test('lists what is filed at each path, root included', async () => {
        const root = await db.put(note('root'), at('/'));
        const project = await db.put(note('project'), at('/dc-migration'));
        const tasks = await db.put(note('tasks'), at('/dc-migration/tasks'));
        const task = await db.put(note('task'), at('/dc-migration/tasks/foo'));

        expect(sorted(await db.list({ ...at('/'), idsOnly: true }))).toEqual(sorted([root, project, tasks, task]));
        expect(sorted(await db.list({ ...at('/', true), idsOnly: true }))).toEqual([root]);
        expect(sorted(await db.list({ ...at('/dc-migration', true), idsOnly: true }))).toEqual([project]);
        expect(sorted(await db.list({ ...at('/dc-migration/tasks', true), idsOnly: true }))).toEqual([tasks]);
        expect(sorted(await db.list({ ...at('/dc-migration/tasks/foo', true), idsOnly: true }))).toEqual([task]);
    });

    test('the contextual CLAUDE.md: one per folder, plus the one filed at /work only', async () => {
        const work = await db.put(note('CLAUDE work'), at('/work'));
        const folders = [];
        for (const folder of ['finance', 'marketing', 'it']) folders.push(await db.put(note(`CLAUDE ${folder}`), at(`/work/${folder}`)));

        expect(sorted(await db.list({ ...at('/work'), idsOnly: true }))).toEqual(sorted([work, ...folders]));
        expect(sorted(await db.list({ ...at('/work', true), idsOnly: true }))).toEqual([work]);
        expect(sorted(await db.list({ ...at('/work/it', true), idsOnly: true }))).toEqual([folders[2]]);
    });

    test('a document linked at a path and at its child counts as filed at the child', async () => {
        // Linking at /a/b already ticks layer a: the bitmaps cannot tell the two
        // links apart, so /a alone does not claim it.
        const both = await db.put(note('both'), at('/a'));
        await db.link(both, at('/a/b'));
        expect(sorted(await db.list({ ...at('/a', true), idsOnly: true }))).toEqual([]);
        expect(sorted(await db.list({ ...at('/a/b', true), idsOnly: true }))).toEqual([both]);
    });

    test('a layer reused under a sibling path does not hide documents filed here', async () => {
        const here = await db.put(note('here'), at('/a'));
        await db.put(note('elsewhere'), at('/b/x'));
        await db.put(note('deeper'), at('/a/x'));
        // Layer `x` exists under /a and /b; only documents in x AND a are deeper than /a.
        expect(sorted(await db.list({ ...at('/a', true), idsOnly: true }))).toEqual([here]);
    });
});
