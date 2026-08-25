import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const FILE = 'data/schema/file';

const blob = (checksum, locations) => ({
    schema: FILE,
    data: {},
    checksumArray: [`sha256/${checksum}`],
    locations,
});

// `data/backend/*` is DERIVED from locations[], not asserted by the app: synapsd
// knows nothing about `stored`, S3 or IMAP, it just parses a URL into scheme +
// authority exactly as it already does for file://<deviceId>. That keeps the
// storage subsystem's vocabulary out of the index AND makes the tags rebuildable
// from rows, which the asserted version never was.
//
// `data/source/*` is gone, folded into this axis: once both derive from
// locations[] they are two projections of the same fact.
describe('data/backend/* derived from locations', () => {
    let rootPath;
    let db;

    const backendKeys = async (id) => {
        const keys = await db.bitmapIndex.listBitmaps('data/backend');
        const out = [];
        for (const key of keys) {
            const bitmap = await db.bitmapIndex.getBitmap(key, false);
            if (bitmap && bitmap.has(id)) { out.push(key); }
        }
        return out.sort();
    };

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-backend-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('scheme and authority are both ticked, so the scheme is a roll-up', async () => {
        const id = await db.put(blob('aaa', [{ url: 'stored://homenas/k1' }]));

        expect(await backendKeys(id)).toEqual(['data/backend/stored', 'data/backend/stored/homenas']);
    });

    test('"everything from IMAP" is one key, with no enumeration of accounts', async () => {
        const a = await db.put(blob('bbb', [{ url: 'imap://me@gmail.com/INBOX;UID=1' }]));
        const b = await db.put(blob('ccc', [{ url: 'imap://work@corp.tld/INBOX;UID=7' }]));
        const other = await db.put(blob('ddd', [{ url: 's3://awscloud/k' }]));

        const allImap = await db.list({ features: ['data/backend/imap'], limit: 0 });
        expect(allImap.map((d) => d.id).sort()).toEqual([a, b].sort());
        expect(allImap.map((d) => d.id)).not.toContain(other);

        const oneAccount = await db.list({ features: ['data/backend/imap/me@gmail.com'], limit: 0 });
        expect(oneAccount.map((d) => d.id)).toEqual([a]);
    });

    test('a document in several backends ticks all of them', async () => {
        const id = await db.put(blob('eee', [
            { url: 'stored://workspace:data/k' },
            { url: 'imap://me@gmail.com/INBOX;UID=1', metadata: { provenance: true } },
        ]));

        expect(await backendKeys(id)).toEqual([
            'data/backend/imap',
            'data/backend/imap/me@gmail.com',
            'data/backend/stored',
            'data/backend/stored/workspace:data',
        ]);
    });

    // No scheme is exempt. file:// was skipped until 2026-08-25 because device/*
    // "already answered it", which conflated the addressing mode with the machine.
    test('file:// and device:// parse like every other scheme, alongside device/*', async () => {
        const onPath = await db.put(blob('fff', [{ url: 'file://laptop-a/home/x.bin' }]));
        const pathless = await db.put(blob('fff2', [{ url: 'device://laptop-a' }]));

        expect(await backendKeys(onPath)).toEqual(['data/backend/file', 'data/backend/file/laptop-a']);
        expect(await backendKeys(pathless)).toEqual(['data/backend/device', 'data/backend/device/laptop-a']);

        // device/id is the union of the two, which is why it is not redundant.
        const byDevice = await db.list({ features: ['device/id/laptop-a'], limit: 0 });
        expect(byDevice.map((d) => d.id).sort()).toEqual([onPath, pathless].sort());
    });

    // The query the exemption made unanswerable: loose local files with no managed
    // copy, i.e. what a backup sweep is looking for.
    test('"local only, not in stored" is one intersection', async () => {
        const loose = await db.put(blob('lo1', [{ url: 'file://laptop-a/home/x.bin' }]));
        await db.put(blob('lo2', [
            { url: 'file://laptop-a/home/y.bin' },
            { url: 'stored://homenas/y' },
        ]));

        const result = await db.list({
            features: { allOf: ['data/backend/file'], noneOf: ['data/backend/stored'] },
            limit: 0,
        });
        expect(result.map((d) => d.id)).toEqual([loose]);
    });

    test('a declared backend replaces the URL, because a mount URL lies about location', async () => {
        // A NAS mounted at /mnt/nas is addressed file://<deviceId>/mnt/nas/… but
        // the bytes are not on that device, so the declaration overrides rather
        // than adds. device/* is derived separately and still records the mount
        // point, which is correct: the path IS reachable there.
        const id = await db.put(blob('ggg', [
            { url: 'file://laptop-a/mnt/nas/x.bin', metadata: { backend: 'homenas' } },
        ]));

        expect(await backendKeys(id)).toEqual(['data/backend/homenas']);
        const byDevice = await db.list({ features: ['device/id/laptop-a'], limit: 0 });
        expect(byDevice.map((d) => d.id)).toEqual([id]);
    });

    test('{WORKSPACE_ROOT} placeholders are not addressable stores', async () => {
        const id = await db.put(blob('hhh', [{ url: 'stored://{WORKSPACE_ROOT}/home/x.bin' }]));

        // The scheme roll-up still applies; the placeholder is not an authority.
        expect(await backendKeys(id)).toEqual(['data/backend/stored']);
    });

    test('moving a document between backends unticks the old key — the drift case', async () => {
        const id = await db.put(blob('iii', [{ url: 'stored://homenas/k1' }]));
        expect(await backendKeys(id)).toContain('data/backend/stored/homenas');

        await db.put({ id, locations: [{ url: 's3://awscloud/k1' }] });

        const keys = await backendKeys(id);
        // The NEGATIVE half: a positive-only assertion passes even when the untick
        // never fires, and this axis had no stale-diff at all before it was derived.
        expect(keys).not.toContain('data/backend/stored/homenas');
        expect(keys).not.toContain('data/backend/stored');
        expect(keys).toEqual(['data/backend/s3', 'data/backend/s3/awscloud']);
    });

    test('an asserted data/backend/* feature is stripped, so it cannot outlive its locations', async () => {
        // Rev A (2026-08-04) added `data/backend/` to DERIVED_FEATURE_PREFIXES.
        // Before that, a client could put the key into `features[]`, where the
        // derivation's stale-diff could not reach it: the array re-asserted the key
        // on every write, so moving the document to another backend left the old
        // one ticked forever.
        const id = await db.put({
            ...blob('kkk', [{ url: 'stored://homenas/k1' }]),
            features: ['data/backend/madeup', 'tag/keepme'],
        });

        const doc = await db.get(id);
        expect(doc.features).toEqual(['tag/keepme']);
        expect(await backendKeys(id)).toEqual(['data/backend/stored', 'data/backend/stored/homenas']);

        // The NEGATIVE half: the asserted key must not survive a move either.
        await db.put({ id, locations: [{ url: 's3://awscloud/k1' }] });
        expect(await backendKeys(id)).not.toContain('data/backend/madeup');
    });

    test('losing every location unticks the whole axis, and ticks nothing in its place', async () => {
        // The orphan state lives on its own key (feature/orphaned, see
        // orphan-succession.test.js) rather than as a member of this axis: "no
        // backend" and "orphaned" are different questions and a doc can be the
        // first without being the second.
        const id = await db.put(blob('jjj', [{ url: 'stored://homenas/k1' }]));
        await db.put({ id, locations: [] });

        expect(await backendKeys(id)).toEqual([]);
    });

    test('data/source/* is gone — folded into the backend axis', async () => {
        await db.put(blob('kkk', [{ url: 'imap://me@gmail.com/INBOX;UID=1' }]));

        const sourceKeys = await db.bitmapIndex.listBitmaps('data/source');
        expect(sourceKeys).toEqual([]);
    });
});
