import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/abstraction/note';

function note(title, content = title) {
    return { schema: NOTE_SCHEMA, data: { title, content } };
}

// The bitmap-churn guard: an edit (same id, changed content/checksum) must
// keep the document id stable, so every layer/context/timeline reference that
// keys off the id survives the edit. This is the invariant any editing client
// depends on.
describe('SynapsD putMany id-preserving updates', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-update-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('putMany with a supplied id updates in place, preserving the id and context membership', async () => {
        const [id] = await db.putMany([note('Draft', 'v1 content')], {
            context: { path: '/Projects/Alpha' },
            features: ['tag/red'],
        });
        expect(typeof id).toBe('number');

        const before = await db.getDocument(id);
        const beforeChecksum = before.getPrimaryChecksum();

        // Edit: same id, new content -> new checksum
        const result = await db.putMany([{ id, schema: NOTE_SCHEMA, data: { title: 'Draft', content: 'v2 EDITED' } }]);
        expect(result).toEqual([id]); // id preserved, NOT a new doc

        const after = await db.getDocument(id);
        expect(after.id).toBe(id);
        expect(after.data.content).toBe('v2 EDITED');
        expect(after.getPrimaryChecksum()).not.toBe(beforeChecksum);

        // createdAt preserved, only one document exists
        expect(after.createdAt).toBe(before.createdAt);

        // Context membership survived the edit (bitmap keyed by id)
        const inAlpha = await db.list({ context: { path: '/Projects/Alpha' } });
        expect(inAlpha.map(d => d.id)).toContain(id);
    });

    test('checksum index re-points: old checksum is freed, new checksum resolves to same id', async () => {
        const [id] = await db.putMany([note('Note', 'original')]);
        const before = await db.getDocument(id);
        const oldChecksum = before.getPrimaryChecksum();

        await db.putMany([{ id, schema: NOTE_SCHEMA, data: { title: 'Note', content: 'changed' } }]);

        const after = await db.getDocument(id);
        const newChecksum = after.getPrimaryChecksum();

        // New checksum resolves to the same id
        const byNew = await db.getByChecksumString(newChecksum);
        expect(byNew.id).toBe(id);

        // Old checksum no longer resolves to it (freed)
        const byOld = await db.getByChecksumString(oldChecksum).catch(() => null);
        expect(byOld == null || byOld.id !== id).toBe(true);
    });

    test('id-less content-addressed dedup still works (re-import path)', async () => {
        const [first] = await db.putMany([note('Same', 'identical body')]);
        // No id supplied, identical content -> dedup to the same doc, no new id
        const [second] = await db.putMany([note('Same', 'identical body')]);
        expect(second).toBe(first);
    });

    test('a string id still resolves to the numeric doc and updates in place', async () => {
        const [id] = await db.putMany([note('Coerced', 'first')]);
        // A caller may supply the id as a string; it must still resolve
        const result = await db.putMany([{ id: String(id), schema: NOTE_SCHEMA, data: { title: 'Coerced', content: 'second' } }]);
        expect(result).toEqual([id]); // numeric id, not the string, not a fork

        const after = await db.getDocument(id);
        expect(after.id).toBe(id);
        expect(typeof after.id).toBe('number');
        expect(after.data.content).toBe('second');

        // No phantom string-keyed twin
        const allNotes = (await db.list({})).filter(d => d.schema === NOTE_SCHEMA);
        expect(allNotes).toHaveLength(1);
    });

    test('a supplied id that does not exist still inserts as new (no throw)', async () => {
        // Unknown id falls through to the insert path; a fresh id is minted
        const result = await db.putMany([{ id: 999999, schema: NOTE_SCHEMA, data: { title: 'X', content: 'y' } }]);
        expect(result).toHaveLength(1);
        const doc = await db.getDocument(result[0]);
        expect(doc.data.content).toBe('y');
    });
});
