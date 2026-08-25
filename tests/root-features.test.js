import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import Note from '../src/schemas/app/Note.js';
import Document from '../src/schemas/Document.js';
import schemaRegistry from '../src/schemas/SchemaRegistry.js';

const NOTE = 'data/schema/note';
const note = (title, features) => ({
    schema: NOTE,
    data: { title, content: title },
    ...(features ? { features } : {}),
});

// D2: asserted features move from `metadata` (which holds EXTRACTED facts written
// by derivers) to a root array (ASSERTED membership written by humans/clients).
// Modelled on `comment` line for line: top-level, outside checksumFields, own
// update() branch outside the data path.
describe('root features[]', () => {
    let rootPath;
    let db;

    const hasBitmap = async (key, id) => {
        const bitmap = await db.bitmapIndex.getBitmap(key, false);
        return !!bitmap && bitmap.has(id);
    };

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-features-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('asserted features live at the root and drive their bitmaps', async () => {
        const id = await db.put(note('tagged', ['tag/red', 'custom/mine', 'client/app/firefox']));

        const doc = await db.get(id);
        expect(doc.features).toEqual(['tag/red', 'custom/mine', 'client/app/firefox']);
        expect(doc.metadata.features).toBeUndefined();

        expect(await hasBitmap('tag/red', id)).toBe(true);
        expect(await hasBitmap('custom/mine', id)).toBe(true);
    });

    test('the schema id is no longer injected into the asserted array', async () => {
        // It used to be unshifted onto EVERY construct — triple-redundant (clients
        // send it, #putOne re-adds it) and a DERIVED key inside an asserted-only
        // array. The schema bitmap must still be ticked, by the derivation.
        const id = await db.put(note('plain'));

        expect((await db.get(id)).features).toEqual([]);
        expect(await hasBitmap(NOTE, id)).toBe(true);
    });

    test('derived keys supplied by a client are ignored, not ticked', async () => {
        // A stored derived key is indistinguishable from a genuinely derived one
        // while being immune to the derivation's stale-diff — it could never be
        // unticked. Same reasoning that made device/* a strip, not a merge.
        const id = await db.put(note('sneaky', [
            'tag/keep',
            'data/schema/file',
            'data/mime/image/png',
            'data/kind/browser/tab',
            'device/id/other-machine',
            'feature/has-comment',
        ]));

        expect((await db.get(id)).features).toEqual(['tag/keep']);
        expect(await hasBitmap('data/schema/file', id)).toBe(false);
        expect(await hasBitmap('data/mime/image/png', id)).toBe(false);
        expect(await hasBitmap('device/id/other-machine', id)).toBe(false);
    });

    test('data/dataset/* survives a client re-put that omits it', async () => {
        const id = await db.put(note('provenance', ['tag/red', 'data/dataset/wikipedia']));
        expect((await db.get(id)).features).toContain('data/dataset/wikipedia');

        // A client resending only its own tags must not silently drop ingest
        // provenance it never knew about.
        await db.put({ id, features: ['tag/blue'] });

        const after = await db.get(id);
        expect(after.features).toContain('data/dataset/wikipedia');
        expect(after.features).toContain('tag/blue');
        expect(after.features).not.toContain('tag/red');
        expect(await hasBitmap('data/dataset/wikipedia', id)).toBe(true);
    });

    test('a feature-only update does NOT change the checksum (the comment precedent)', async () => {
        const id = await db.put(note('stable', ['tag/red']));
        const before = (await db.get(id)).checksumArray;

        await db.put({ id, features: ['tag/red', 'tag/blue'] });

        expect((await db.get(id)).checksumArray).toEqual(before);
    });

    test('two documents differing ONLY in features dedup to one', async () => {
        const first = await db.put(note('same', ['tag/red']));
        const second = await db.put(note('same', ['tag/blue']));
        expect(second).toBe(first);
    });

    test('a feature-only update leaves the embedding input untouched', async () => {
        // Otherwise bulk-tagging a gallery would re-embed (re-CLIP) every document.
        const id = await db.put(note('embeddable', ['tag/red']));
        const before = (await db.get(id)).generateEmbeddingsData();

        await db.put({ id, features: ['tag/red', 'tag/blue'] });

        expect((await db.get(id)).generateEmbeddingsData()).toEqual(before);
    });

    // ⚠️ THE regression the plan warns about twice: in putMany, existing.update(doc)
    // mutates in place and returns the SAME instance, so prevFeatureKeys must be
    // snapshotted BEFORE that call. Computed after, the stale set is always empty,
    // the untick never fires — and every positive-case test still passes.
    test('removing a feature unticks its bitmap (assert the NEGATIVE case)', async () => {
        const id = await db.put(note('tagged', ['tag/red', 'tag/blue']));
        expect(await hasBitmap('tag/red', id)).toBe(true);

        await db.put({ id, features: ['tag/blue'] });

        expect(await hasBitmap('tag/red', id)).toBe(false);
        expect(await hasBitmap('tag/blue', id)).toBe(true);
    });

    test('the same untick happens through the batch path, in one transaction', async () => {
        const ids = await db.putMany([note('a', ['tag/red']), note('b', ['tag/red'])]);
        const [a, b] = Array.isArray(ids) ? ids : ids.data;

        await db.putMany([
            { id: a, features: ['tag/green'] },
            { id: b, features: ['tag/green'] },
        ]);

        expect(await hasBitmap('tag/red', a)).toBe(false);
        expect(await hasBitmap('tag/red', b)).toBe(false);
        expect(await hasBitmap('tag/green', a)).toBe(true);
        expect(await hasBitmap('tag/green', b)).toBe(true);
    });

    test('a schema-LESS patch that omits features leaves them alone', async () => {
        const id = await db.put(note('keep', ['tag/red']));

        await db.put({ id, data: { title: 'keep', content: 'edited' } });

        expect((await db.get(id)).features).toEqual(['tag/red']);
        expect(await hasBitmap('tag/red', id)).toBe(true);
    });

    test('a schema-FUL put is a replace, so it clears tags it does not resend', async () => {
        // Pre-existing whole-document-replacement semantics, unchanged by this move
        // (before it, the metadata merge wiped tags the same way). Documented
        // because it is a real footgun: patch content WITHOUT a schema, or resend
        // the tag array. Preserved prefixes still survive — see the dataset test.
        const id = await db.put(note('replace-me', ['tag/red']));

        await db.put({ id, schema: NOTE, data: { title: 'replace-me', content: 'edited' } });

        expect((await db.get(id)).features).toEqual([]);
        expect(await hasBitmap('tag/red', id)).toBe(false);
    });

    test('legacy metadata.features is promoted on read until Phase 6 rewrites rows', async () => {
        // Pre-v3 rows carry tags under metadata; they must keep working, and must
        // not leave a second stale copy behind.
        const doc = new Note({ schema: NOTE, data: { title: 't', content: 'c' }, metadata: { features: ['tag/legacy'] } });

        expect(doc.features).toEqual(['tag/legacy']);
        expect(doc.metadata.features).toBeUndefined();
    });

    test('a metadata patch carrying features is routed to the root array', async () => {
        const id = await db.put(note('legacy-writer'));

        await db.put({ id, metadata: { features: ['tag/via-metadata'] } });

        const doc = await db.get(id);
        expect(doc.features).toEqual(['tag/via-metadata']);
        expect(doc.metadata.features).toBeUndefined();
        expect(await hasBitmap('tag/via-metadata', id)).toBe(true);
    });

    test('duplicates and invalid entries are dropped without failing the write', async () => {
        const id = await db.put(note('messy', ['tag/red', 'tag/red', '', 'tag/blue']));
        expect((await db.get(id)).features).toEqual(['tag/red', 'tag/blue']);
    });
});

// A schema's own facet namespace is derived too — per-schema, so it is computed
// rather than listed in DERIVED_FEATURE_PREFIXES.
describe('schema-declared facet namespaces are derived, not assertable', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-facetassert-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('a client cannot assert data/status/* on a schema that derives it', async () => {
        const id = await db.put({
            schema: 'data/schema/task',
            data: { title: 'ship it', status: 'pending' },
            features: ['tag/urgent', 'data/status/completed'],
        });

        const doc = await db.get(id);
        // Otherwise the array would re-assert the key on every write and the facet
        // stale-diff could never untick it.
        expect(doc.features).toEqual(['tag/urgent']);

        const completed = await db.list({ features: ['data/status/completed'], limit: 0 });
        expect(completed.map((d) => d.id)).not.toContain(id);

        const pending = await db.list({ features: ['data/status/pending'], limit: 0 });
        expect(pending.map((d) => d.id)).toContain(id);
    });

    test('changing the derived status unticks the old facet', async () => {
        const id = await db.put({
            schema: 'data/schema/task',
            data: { title: 'ship it', status: 'pending' },
        });

        await db.put({ id, schema: 'data/schema/task', data: { title: 'ship it', status: 'completed' } });

        const pending = await db.list({ features: ['data/status/pending'], limit: 0 });
        expect(pending.map((d) => d.id)).not.toContain(id);
        const completed = await db.list({ features: ['data/status/completed'], limit: 0 });
        expect(completed.map((d) => d.id)).toContain(id);
    });
});

// A CAPABILITY facet ("this app runs on x86_64 AND aarch64") is multi-valued,
// which only works because every write path diffs the previous key SET against
// the current one rather than swapping a single value.
describe('multi-valued facet fields', () => {
    const PORTABLE = 'data/schema/portable';
    let rootPath;
    let db;

    class Portable extends Document {
        static facetFields = ['data.platforms'];
        constructor(options = {}) {
            options.schema = options.schema || PORTABLE;
            super(options);
        }
    }

    const ids = async (key) => (await db.list({ features: [key], limit: 0 })).map((d) => d.id);

    beforeEach(async () => {
        schemaRegistry.registerSchema(PORTABLE, Portable);
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-multifacet-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
        schemaRegistry.unregisterSchema(PORTABLE);
    });

    test('every entry is queryable, and dropping one unticks only that key', async () => {
        const id = await db.put({
            schema: PORTABLE,
            data: { name: 'ripgrep', platforms: ['linux/x86_64', 'linux/aarch64', 'mac/aarch64'] },
        });

        expect(await ids('data/platforms/linux/x86_64')).toEqual([id]);
        expect(await ids('data/platforms/linux/aarch64')).toEqual([id]);
        expect(await ids('data/platforms/mac/aarch64')).toEqual([id]);

        // Drop one arch, keep the others. The negative half is the point: a
        // tick-only derivation would leave the dropped key set forever.
        await db.put({
            id,
            schema: PORTABLE,
            data: { name: 'ripgrep', platforms: ['linux/x86_64', 'mac/aarch64'] },
        });

        expect(await ids('data/platforms/linux/aarch64')).toEqual([]);
        expect(await ids('data/platforms/linux/x86_64')).toEqual([id]);
        expect(await ids('data/platforms/mac/aarch64')).toEqual([id]);
    });

    test('rebuildL3 reproduces the whole set from the row', async () => {
        const id = await db.put({
            schema: PORTABLE,
            data: { name: 'fd', platforms: ['linux/x86_64', 'windows/x86_64'] },
        });
        await db.bitmapIndex.tick('data/platforms/linux/aarch64', id);

        await db.rebuildL3();

        expect(await ids('data/platforms/linux/x86_64')).toEqual([id]);
        expect(await ids('data/platforms/windows/x86_64')).toEqual([id]);
        expect(await ids('data/platforms/linux/aarch64')).toEqual([]);
    });
});
