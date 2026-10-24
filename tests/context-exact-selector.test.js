'use strict';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const note = (title) => ({ schema: 'data/schema/note', data: { title, content: title } });
const sorted = (ids) => [...ids].map(Number).sort((a, b) => a - b);

// A context path lists its whole subtree; `exact` asks for the documents filed
// at the path itself, as one bitmap operation.
describe('exact context selectors', () => {
    let rootPath;
    let db;
    let tree;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-exact-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
        await db.createTree('projects', 'context', { isDefault: false });
        tree = db.getTree('projects');
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    const at = (treePath, exact = false) => ({ context: { tree: tree.id, path: treePath, ...(exact ? { exact: true } : {}) } });

    test('lists what is filed at each depth, root included', async () => {
        const root = await db.put(note('root'), at('/'));
        const project = await db.put(note('project'), at('/dc-migration'));
        const task = await db.put(note('task'), at('/dc-migration/tasks/foo'));
        const both = await db.put(note('both'), at('/dc-migration'));
        await db.link(both, at('/dc-migration/tasks'));

        expect(sorted(await db.list({ ...at('/'), idsOnly: true }))).toEqual(sorted([root, project, task, both]));
        expect(sorted(await db.list({ ...at('/', true), idsOnly: true }))).toEqual([root]);
        expect(sorted(await db.list({ ...at('/dc-migration', true), idsOnly: true }))).toEqual([project]);
        expect(sorted(await db.list({ ...at('/dc-migration/tasks', true), idsOnly: true }))).toEqual([both]);
        expect(sorted(await db.list({ ...at('/dc-migration/tasks/foo', true), idsOnly: true }))).toEqual([task]);
    });

    test('combined with ids it answers which listed documents are filed here', async () => {
        const project = await db.put(note('project'), at('/dc-migration'));
        const task = await db.put(note('task'), at('/dc-migration/tasks'));
        const page = await db.list({ ...at('/dc-migration'), idsOnly: true });
        expect(sorted(page)).toEqual(sorted([project, task]));
        expect(sorted(await db.list({ ...at('/dc-migration', true), ids: [...page].map(Number), idsOnly: true }))).toEqual([project]);
    });

    test('a layer reused under a sibling path does not hide documents filed here', async () => {
        const here = await db.put(note('here'), at('/a'));
        await db.put(note('elsewhere'), at('/b/x'));
        await db.put(note('below'), at('/a/x'));
        // Layer `x` exists under /a and /b; only documents in x AND a are below /a.
        expect(sorted(await db.list({ ...at('/a', true), idsOnly: true }))).toEqual([here]);
    });
});
