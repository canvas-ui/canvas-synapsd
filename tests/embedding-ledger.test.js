import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import SynapsD from '../src/index.js';

// synapsd is now store-only: it owns no embedding model. Vectors arrive via
// storeDocumentEmbeddings, query embedding is an injected callback, and the
// "unembedded gap" is a durable bitmap ledger. These tests exercise that ledger
// with a deterministic fake embedder — no fastembed download, no worker.

const NOTE = (title) => ({ schema: 'data/abstraction/note', data: { title, content: title } });
const DIM = 384;
const fakeVec = (seed) => Array.from({ length: DIM }, (_, i) => ((seed + i) % 7) / 7);
const NOTE_SCHEMAS = ['data/abstraction/note'];
const sorted = (a) => [...a].sort((x, y) => x - y);

describe('embedding ledger (store-only synapsd)', () => {
    let dbPath;
    let db;

    beforeEach(async () => {
        dbPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-embed-ledger-'));
        db = new SynapsD({
            path: dbPath,
            backupOnOpen: false,
            backupOnClose: false,
            semantic: { enabled: true, embedQuery: async () => fakeVec(1) },
        });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown(); db = null; }
        if (dbPath) { await fs.rm(dbPath, { recursive: true, force: true }); dbPath = null; }
    });

    test('gap = candidate schemas minus seen; seen vs presence; clearSpace resets', async () => {
        const id1 = await db.put(NOTE('alpha'));
        const id2 = await db.put(NOTE('beta'));

        // Nothing embedded yet → both notes are in the gap.
        expect(sorted(await db.getUnembeddedDocIds('text', NOTE_SCHEMAS))).toEqual(sorted([id1, id2]));

        // Embed id1 (real chunk vector) → leaves the gap AND ticks presence.
        await db.storeDocumentEmbeddings(id1, 'data/abstraction/note', new Date().toISOString(),
            [{ chunkId: 0, text: 'alpha', vector: fakeVec(id1) }], { space: 'text' });
        expect(await db.getUnembeddedDocIds('text', NOTE_SCHEMAS)).toEqual([id2]);
        let stats = await db.getStats();
        expect(stats.semantic.vector.embeddedDocs).toBe(1);

        // "Skip" id2 (0 chunks) → leaves the gap (seen) but does NOT tick presence.
        await db.storeDocumentEmbeddings(id2, 'data/abstraction/note', new Date().toISOString(),
            [], { space: 'text' });
        expect(await db.getUnembeddedDocIds('text', NOTE_SCHEMAS)).toEqual([]);
        stats = await db.getStats();
        expect(stats.semantic.vector.embeddedDocs).toBe(1); // still just id1

        // clearSpace → wipe presence + seen → everything is unembedded again.
        await db.clearSpace('text');
        expect(sorted(await db.getUnembeddedDocIds('text', NOTE_SCHEMAS))).toEqual(sorted([id1, id2]));
        stats = await db.getStats();
        expect(stats.semantic.vector.embeddedDocs).toBe(0);
    });

    test('content update drops a doc back into the gap', async () => {
        const id = await db.put(NOTE('gamma'));
        await db.storeDocumentEmbeddings(id, 'data/abstraction/note', new Date().toISOString(),
            [{ chunkId: 0, text: 'gamma', vector: fakeVec(id) }], { space: 'text' });
        expect(await db.getUnembeddedDocIds('text', NOTE_SCHEMAS)).toEqual([]);

        // Update content (put with id routes to update) → doc should reappear in
        // the gap for re-embedding.
        await db.put({ id, schema: 'data/abstraction/note', data: { title: 'gamma', content: 'gamma changed' } });
        expect(await db.getUnembeddedDocIds('text', NOTE_SCHEMAS)).toEqual([id]);
    });
});
