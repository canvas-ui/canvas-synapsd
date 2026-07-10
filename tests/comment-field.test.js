import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import Note from '../src/schemas/abstractions/Note.js';

const NOTE_SCHEMA = 'data/abstraction/note';
const TAB_SCHEMA = 'data/abstraction/tab';
const COMMENT_KEY = 'feature/has-comment';

const note = (title, comment) => ({ schema: NOTE_SCHEMA, data: { title, content: title }, ...(comment !== undefined ? { comment } : {}) });
const tab = (url, comment) => ({ schema: TAB_SCHEMA, data: { url, title: url }, ...(comment !== undefined ? { comment } : {}) });

// The user-authored comment: a top-level field (not under data, so no checksum
// churn), always FTS'd, and tracked by the feature/has-comment presence bitmap.
describe('BaseDocument comment field', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-comment-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('comment round-trips and ticks the feature/has-comment bitmap', async () => {
        const id = await db.put(note('sofa', 'sofa from the cozmo bar in Košice'));
        const stored = await db.getDocument(id);
        expect(stored.comment).toBe('sofa from the cozmo bar in Košice');
        expect(stored.hasComment).toBe(true);

        const withComment = await db.list({ features: { allOf: [COMMENT_KEY] } });
        expect(withComment.map(d => d.id)).toContain(id);
    });

    test('a doc with no comment does not tick the bitmap', async () => {
        const id = await db.put(note('plain'));
        const withComment = await db.list({ features: { allOf: [COMMENT_KEY] } });
        expect(withComment.map(d => d.id)).not.toContain(id);
    });

    test('clearing the comment on update unticks the bitmap without touching content checksum', async () => {
        const id = await db.put(note('sofa', 'a comment'));
        const before = await db.getDocument(id);
        const beforeChecksum = before.getPrimaryChecksum();

        // Comment-only edit: same data, comment cleared.
        await db.put({ id, schema: NOTE_SCHEMA, data: { title: 'sofa', content: 'sofa' }, comment: '' });

        const after = await db.getDocument(id);
        expect(after.comment).toBe('');
        expect(after.hasComment).toBe(false);
        // Content unchanged → checksum unchanged (comment is not a checksum field).
        expect(after.getPrimaryChecksum()).toBe(beforeChecksum);

        const withComment = await db.list({ features: { allOf: [COMMENT_KEY] } });
        expect(withComment.map(d => d.id)).not.toContain(id);
    });

    test('generateFtsData always includes the comment, even with no ftsSearchFields', () => {
        // A note surfaces title/content AND the comment.
        const n = Note.fromData({ data: { title: 'sofa', content: 'a couch' }, comment: 'from Košice' });
        expect(n.generateFtsData()).toContain('from Košice');

        // A doc that declares no ftsSearchFields still FTS's its comment alone.
        const blobLike = new Note({ data: {}, comment: 'blob note' });
        blobLike.indexOptions.ftsSearchFields = [];
        expect(blobLike.generateFtsData()).toEqual(['blob note']);
    });

    test('comment gap ledger: a commented non-embeddable doc joins the text gap only', async () => {
        // Tab is not in embeddableSchemas, but carrying a comment must pull it into
        // the text gap (comment always embeds into the text space) — and only text.
        const id = await db.put(tab('https://example.com', 'my annotation'));

        const textGap = await db.getUnembeddedDocIds('text');
        expect(textGap).toContain(id);

        const imageGap = await db.getUnembeddedDocIds('image');
        expect(imageGap).not.toContain(id);
    });
});
