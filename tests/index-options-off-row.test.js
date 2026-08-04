import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import schemaRegistry from '../src/schemas/SchemaRegistry.js';
import Document from '../src/schemas/Document.js';
import Note from '../src/schemas/app/Note.js';

const NOTE = 'data/abstraction/note';

// indexOptions was byte-identical config repeated on EVERY row — ~461 B on a
// measured note, ~3.2 GB at 7M rows — for something that is a property of the
// schema, not of the document. It now lives on the schema class and is resolved
// at construction time; the row does not carry it at all.
describe('indexOptions off the row', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-idxopt-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
        delete schemaRegistry.constructor.prototype.__unused;
    });

    test('the stored row does not contain indexOptions', async () => {
        const id = await db.put({ schema: NOTE, data: { title: 'n', content: 'n' } });

        // Read the RAW stored value, not the rehydrated document: db.get() rebuilds
        // through the constructor, which re-resolves indexOptions, so a read would
        // show the field either way.
        const raw = db.documents.get(id);
        const serialized = JSON.stringify(raw);
        expect(serialized).not.toContain('indexOptions');
        expect(serialized).not.toContain('ftsSearchFields');
    });

    test('the resolved document still exposes indexOptions at runtime', async () => {
        // Workspace.js reads doc.indexOptions?.embeddingOptions?.chunking, so the
        // runtime property must survive even though the row does not carry it.
        const doc = await db.get(await db.put({ schema: NOTE, data: { title: 'n', content: 'n' } }));

        expect(doc.indexOptions.ftsSearchFields).toEqual(['data.title', 'data.content']);
        expect(doc.indexOptions.checksumFields).toEqual(['data.title', 'data.content']);
        expect(doc.indexOptions.embeddingOptions.embeddingModel).toBe('bge-small-en-v1.5');
    });

    test('resolution comes from the class static', () => {
        expect(Note.indexOptions.checksumFields).toEqual(['data.title', 'data.content']);
        expect(schemaRegistry.getSchemaEntry(NOTE).indexOptions).toBe(Note.indexOptions);
    });

    test('a caller cannot override indexOptions per document', async () => {
        // Per-document config would apply on write and vanish on read now that the
        // field is not persisted — silently different behaviour per code path. So
        // caller input is ignored outright, which also settles the merge-order
        // inconsistency (half the schemas let the caller win, half discarded it).
        const doc = new Note({
            schema: NOTE,
            data: { title: 'n', content: 'n' },
            indexOptions: { checksumFields: ['data.title'], ftsSearchFields: ['data.title'] },
        });

        expect(doc.indexOptions.checksumFields).toEqual(['data.title', 'data.content']);
        expect(doc.indexOptions.ftsSearchFields).toEqual(['data.title', 'data.content']);
    });

    test('a legacy row carrying indexOptions is ignored, not resurrected', async () => {
        const id = await db.put({ schema: NOTE, data: { title: 'n', content: 'n' } });

        // Simulate a pre-v3 row: stale config stored alongside the document.
        const stored = db.documents.get(id);
        stored.indexOptions = { checksumFields: ['data.nonexistent'], ftsSearchFields: [] };
        await db.documents.put(id, stored);

        const doc = await db.get(id);
        expect(doc.indexOptions.checksumFields).toEqual(['data.title', 'data.content']);
    });

    test('the base default still applies to a schema declaring none', () => {
        class Bare extends Document {}
        const doc = new Bare({ schema: 'data/abstraction/bare', data: { x: 1 } });

        expect(doc.indexOptions.checksumFields).toEqual(['data']);
        expect(doc.indexOptions.ftsSearchFields).toEqual(['data']);
    });

    test('registerSchema indexOptions actually apply to constructed documents', () => {
        class Widget extends Document {
            constructor(options = {}) {
                options.schema = options.schema || 'data/abstraction/widget';
                super(options);
            }
        }

        schemaRegistry.registerSchema('data/abstraction/widget', Widget, {
            indexOptions: { checksumFields: ['data.label'], ftsSearchFields: ['data.label'] },
        });

        try {
            // The registration must reach the DOCUMENT, not just sit in the registry
            // looking authoritative — Document resolves from the class static.
            const doc = new Widget({ data: { label: 'w' } });
            expect(doc.indexOptions.checksumFields).toEqual(['data.label']);
            expect(schemaRegistry.getSchemaEntry('data/abstraction/widget').indexOptions.checksumFields)
                .toEqual(['data.label']);
        } finally {
            schemaRegistry.unregisterSchema('data/abstraction/widget');
        }
    });

    test('checksums are unchanged by the move — identity must not shift', async () => {
        // The whole point of resolving the SAME values from a different place is
        // that nothing about the document's identity changes.
        const id = await db.put({ schema: NOTE, data: { title: 'stable', content: 'stable' } });
        const doc = await db.get(id);

        const expected = new Note({ schema: NOTE, data: { title: 'stable', content: 'stable' } });
        expect(doc.checksumArray).toEqual(expected.generateChecksumStrings());
    });
});
