'use strict';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/schema/note';

function note(title) {
    return { schema: NOTE_SCHEMA, data: { title, content: title } };
}

// A path selector resolves to AND(layers along the path), so every document
// linked BELOW /a is also listed AT /a. Subtracting the children is how a
// caller asks the only other question there is: what is linked at /a ITSELF.
//
// The string grammar has nowhere to put a tree id, so `!ctx:/a` can only mean
// "/a of the default context tree". Anything working in a named tree needs the
// selector-object form, or its exclusion silently subtracts nothing.
describe('path exclusions in a named tree', () => {
    let rootPath;
    let db;
    let tree;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-path-exclusion-test-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
        // Not the default context tree — that is the whole point of the test.
        await db.createTree('projects', 'context', { isDefault: false });
        tree = db.getTree('projects');
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    const at = (treePath) => ({ context: { tree: tree.id, path: treePath } });

    test('a selector-object exclusion subtracts the subtree, leaving what is linked at the path', async () => {
        const root = await db.put(note('root'), at('/'));
        const project = await db.put(note('project'), at('/dc-migration'));
        const task = await db.put(note('task'), at('/dc-migration/tasks/foo'));

        // Everything below the path is listed at the path.
        const all = await db.list({ ...at('/'), idsOnly: true });
        expect([...all].sort((a, b) => a - b)).toEqual([root, project, task].sort((a, b) => a - b));

        const localToRoot = await db.list({
            ...at('/'),
            paths: { not: [{ tree: tree.id, path: '/dc-migration' }] },
            idsOnly: true,
        });
        expect([...localToRoot]).toEqual([root]);

        const localToProject = await db.list({
            ...at('/dc-migration'),
            paths: { not: [{ tree: tree.id, path: '/dc-migration/tasks' }] },
            idsOnly: true,
        });
        expect([...localToProject]).toEqual([project]);

        // The leaf has no children to subtract: it is its own local set.
        const leaf = await db.list({ ...at('/dc-migration/tasks/foo'), idsOnly: true });
        expect([...leaf]).toEqual([task]);
    });

    test('tree.list scopes to the path it was given', async () => {
        const root = await db.put(note('root'), at('/'));
        const project = await db.put(note('project'), at('/dc-migration'));
        const task = await db.put(note('task'), at('/dc-migration/tasks/foo'));

        // The db scopes by a `context` SELECTOR; `tree`/`path` at the top level
        // of a spec are read by nobody, so passing them there dropped the scope
        // and every path answered with every document in the workspace.
        const listed = async (treePath) => (await tree.list({ path: treePath, parse: true }))
            .map((doc) => doc.id)
            .sort((a, b) => a - b);

        expect(await listed('/')).toEqual([root, project, task].sort((a, b) => a - b));
        expect(await listed('/dc-migration')).toEqual([project, task].sort((a, b) => a - b));
        expect(await listed('/dc-migration/tasks/foo')).toEqual([task]);
    });

    test('a bare string exclusion targets the default tree, not this one', async () => {
        const root = await db.put(note('root'), at('/'));
        const project = await db.put(note('project'), at('/dc-migration'));

        const listed = await db.list({
            ...at('/'),
            paths: { not: ['ctx:/dc-migration'] },
            idsOnly: true,
        });

        // /dc-migration does not exist in the DEFAULT context tree, so the
        // exclusion is a no-op here — the documented reason the object form
        // exists at all.
        expect([...listed].sort((a, b) => a - b)).toEqual([root, project].sort((a, b) => a - b));
    });
});
