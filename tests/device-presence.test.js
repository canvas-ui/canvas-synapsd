import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const DOTFILE_SCHEMA = 'data/abstraction/dotfile';
const APP_SCHEMA = 'data/abstraction/application';
const NOTE_SCHEMA = 'data/abstraction/note';

const DEV_A = 'device-aaa';
const DEV_B = 'device-bbb';

function dotfile(entry, links, type = 'file') {
    // v3: identity is a normalized URI; a bare path resolves to the workspace repo.
    return { schema: DOTFILE_SCHEMA, data: { url: entry, type, links } };
}

// Application.superRefine requires a type-appropriate `source` for
// appimage/flatpak/snap/portable; system + local need none.
const SOURCE_FOR = {
    flatpak: { ref: 'app/com.example.App/x86_64/stable' },
    snap: { name: 'example' },
    appimage: { url: 'https://example.com/app.AppImage' },
    portable: { url: 'https://example.com/app.tar.gz' },
};

function app(appId, installs, type = 'system') {
    const data = { appId, type, installs };
    if (SOURCE_FOR[type]) { data.source = SOURCE_FOR[type]; }
    return { schema: APP_SCHEMA, data };
}

async function featuresOf(db, id) {
    // Ask the index which device bitmaps actually contain this document, rather
    // than trusting the document's own array — this is the thing under test.
    const keys = await db.bitmapIndex.listBitmaps('device/');
    const present = [];
    for (const key of keys) {
        const bitmap = await db.bitmapIndex.getBitmap(key, false);
        if (bitmap && bitmap.has(id)) { present.push(key); }
    }
    return present.sort();
}

describe('device presence bitmaps', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-devpres-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('a dotfile mapped to N devices ticks N device/id bitmaps', async () => {
        const id = await db.put(dotfile('shell/bashrc', {
            [DEV_A]: '$HOME/.bashrc',
            [DEV_B]: '$HOME/.bashrc',
        }));

        expect(await featuresOf(db, id)).toEqual([`device/id/${DEV_A}`, `device/id/${DEV_B}`]);
    });

    test('a FOLDER dotfile ticks presence exactly like a file one', async () => {
        // ~/.ssh is an ordinary dotfile; presence derivation must not assume bytes.
        const id = await db.put(dotfile('ssh', { [DEV_A]: '$HOME/.ssh' }, 'folder'));
        expect(await featuresOf(db, id)).toEqual([`device/id/${DEV_A}`]);
    });

    test('an install WITH a path ticks presence', async () => {
        const id = await db.put(app('com.example.Paths', {
            [DEV_A]: { status: 'available', path: '$HOME/bin/example' },
        }, 'portable'));

        expect(await featuresOf(db, id)).toEqual([`device/id/${DEV_A}`]);
    });

    test('a PATHLESS install still ticks presence (flatpak/snap/system)', async () => {
        // Regression: before 2026-08-02 these produced no location at all, so the
        // install types that never have a path were invisible on the device axis.
        const id = await db.put(app('com.spotify.Client', {
            [DEV_A]: { status: 'available' },
            [DEV_B]: { status: 'available', version: '1.2.3' },
        }, 'flatpak'));

        expect(await featuresOf(db, id)).toEqual([`device/id/${DEV_A}`, `device/id/${DEV_B}`]);
    });

    test('a source URL alone is not device presence', async () => {
        const id = await db.put({
            schema: APP_SCHEMA,
            data: {
                appId: 'com.example.Remote',
                type: 'appimage',
                installs: {},
                source: { url: 'https://example.com/app.AppImage' },
            },
        });

        expect(await featuresOf(db, id)).toEqual([]);
    });

    test('documents with no device-local location tick nothing', async () => {
        const id = await db.put({ schema: NOTE_SCHEMA, data: { title: 'n', content: 'n' } });
        expect(await featuresOf(db, id)).toEqual([]);
    });

    test('removing a device via a SCHEMA-LESS update({data}) unticks presence', async () => {
        // THE DRIFT BUG (regression test — fails without BaseDocument.deriveLocations).
        //
        // Dotfile/Application derived locations in their CONSTRUCTOR only, while
        // BaseDocument.update() overwrote `data` without re-deriving. Two things
        // make this subtle:
        //
        //  1. It is only reachable with a schema-LESS payload. #updateOne runs
        //     parseInitializeDocument() when the payload carries a `schema`, which
        //     re-runs the subclass constructor and derives locations before
        //     update() ever sees them — so schema-ful updates were always safe.
        //  2. The symptom is invisible in `locations`: db.get() rebuilds the
        //     document through the constructor, so a READ re-derives and looks
        //     correct. Only the write-time bitmaps show the damage — hence this
        //     test asserts on bitmap membership, not on doc.locations.
        const id = await db.put(dotfile('shell/bashrc', {
            [DEV_A]: '$HOME/.bashrc',
            [DEV_B]: '$HOME/.bashrc',
        }));
        expect(await featuresOf(db, id)).toEqual([`device/id/${DEV_A}`, `device/id/${DEV_B}`]);

        await db.put({
            id,
            data: { url: 'shell/bashrc', type: 'file', links: { [DEV_A]: '$HOME/.bashrc' } },
        });

        expect(await featuresOf(db, id)).toEqual([`device/id/${DEV_A}`]);
    });

    test('a schema-ful update also unticks (the already-safe path stays safe)', async () => {
        const id = await db.put(dotfile('shell/bashrc', {
            [DEV_A]: '$HOME/.bashrc',
            [DEV_B]: '$HOME/.bashrc',
        }));

        await db.put({
            id,
            schema: DOTFILE_SCHEMA,
            data: { url: 'shell/bashrc', type: 'file', links: { [DEV_A]: '$HOME/.bashrc' } },
        });

        expect(await featuresOf(db, id)).toEqual([`device/id/${DEV_A}`]);
    });

    test('removing a pathless install via update unticks presence', async () => {
        const id = await db.put(app('com.spotify.Client', {
            [DEV_A]: { status: 'available' },
            [DEV_B]: { status: 'available' },
        }, 'flatpak'));
        expect(await featuresOf(db, id)).toHaveLength(2);

        // schema-less payload — the drift-prone path (see the dotfile test above)
        await db.put({
            id,
            data: {
                appId: 'com.spotify.Client',
                type: 'flatpak',
                source: { ref: 'app/com.example.App/x86_64/stable' },
                installs: { [DEV_B]: { status: 'available' } },
            },
        });

        expect(await featuresOf(db, id)).toEqual([`device/id/${DEV_B}`]);
    });

    test('adding a device via update ticks the new presence', async () => {
        const id = await db.put(dotfile('shell/bashrc', { [DEV_A]: '$HOME/.bashrc' }));

        await db.put({
            id,
            schema: DOTFILE_SCHEMA,
            data: {
                url: 'shell/bashrc',
                type: 'file',
                links: { [DEV_A]: '$HOME/.bashrc', [DEV_B]: '$HOME/.bashrc' },
            },
        });

        expect(await featuresOf(db, id)).toEqual([`device/id/${DEV_A}`, `device/id/${DEV_B}`]);
    });

    test('"everything on device X" is a single feature query across schemas', async () => {
        const df = await db.put(dotfile('shell/bashrc', { [DEV_A]: '$HOME/.bashrc' }));
        const application = await db.put(app('com.spotify.Client', { [DEV_A]: { status: 'available' } }));
        const elsewhere = await db.put(dotfile('vim/vimrc', { [DEV_B]: '$HOME/.vimrc' }));

        const onA = await db.list({ features: [`device/id/${DEV_A}`] });
        const ids = (Array.isArray(onA) ? onA : onA.data ?? []).map((d) => d.id);

        expect(ids).toEqual(expect.arrayContaining([df, application]));
        expect(ids).not.toContain(elsewhere);
    });
});

const DEVICE_SCHEMA = 'data/abstraction/device';

function device(deviceId, name, platform, type) {
    return { schema: DEVICE_SCHEMA, data: { deviceId, name, platform, type } };
}

describe('install status gates presence', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-devstatus-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('available and unknown are present; missing, installing and error are not', async () => {
        const cases = [
            ['available', true],
            ['unknown', true],
            ['missing', false],
            ['installing', false],
            ['error', false],
        ];

        for (const [status, shouldBePresent] of cases) {
            const id = await db.put(app(`com.example.${status}`, { [DEV_A]: { status } }));
            const tags = await featuresOf(db, id);
            expect(tags.includes(`device/id/${DEV_A}`)).toBe(shouldBePresent);
        }
    });

    test('"missing on device A" is plain set algebra, no status axis needed', async () => {
        const here = await db.put(app('com.example.Here', { [DEV_A]: { status: 'available' } }));
        const gone = await db.put(app('com.example.Gone', { [DEV_A]: { status: 'missing' } }));

        const missing = await db.list({
            features: { allOf: ['data/abstraction/application'], noneOf: [`device/id/${DEV_A}`] },
        });
        const ids = (Array.isArray(missing) ? missing : missing.data ?? []).map((d) => d.id);

        expect(ids).toContain(gone);
        expect(ids).not.toContain(here);
    });

    test('an install going missing on update unticks presence', async () => {
        const id = await db.put(app('com.example.Vanish', {
            [DEV_A]: { status: 'available' },
            [DEV_B]: { status: 'available' },
        }));
        expect(await featuresOf(db, id)).toHaveLength(2);

        await db.put({
            id,
            data: {
                appId: 'com.example.Vanish',
                type: 'system',
                installs: { [DEV_A]: { status: 'available' }, [DEV_B]: { status: 'missing' } },
            },
        });

        expect(await featuresOf(db, id)).toEqual([`device/id/${DEV_A}`]);
    });
});

describe('derived device/os and device/type facets', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-devfacets-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('documents inherit the os/type of the devices they are present on', async () => {
        await db.put(device(DEV_A, 'work-laptop', 'win32', 'laptop'));
        const id = await db.put(app('com.example.App', { [DEV_A]: { status: 'available' } }));

        // win32 canonicalizes to 'windows'
        expect(await featuresOf(db, id)).toEqual(expect.arrayContaining([
            `device/id/${DEV_A}`, 'device/os/windows', 'device/type/laptop',
        ]));
    });

    test('"all applications on Windows" is a single bitmap AND', async () => {
        await db.put(device(DEV_A, 'win-box', 'win32', 'desktop'));
        await db.put(device(DEV_B, 'linux-box', 'linux', 'server'));

        const winApp = await db.put(app('com.example.Win', { [DEV_A]: { status: 'available' } }));
        const linApp = await db.put(app('com.example.Lin', { [DEV_B]: { status: 'available' } }));

        const result = await db.list({
            features: { allOf: ['data/abstraction/application', 'device/os/windows'] },
        });
        const ids = (Array.isArray(result) ? result : result.data ?? []).map((d) => d.id);

        expect(ids).toContain(winApp);
        expect(ids).not.toContain(linApp);
    });

    test('reinstalling a device with a new OS repairs its documents', async () => {
        await db.put(device(DEV_A, 'box', 'win32', 'laptop'));
        const id = await db.put(app('com.example.App', { [DEV_A]: { status: 'available' } }));
        expect(await featuresOf(db, id)).toContain('device/os/windows');

        // same deviceId, reinstalled with Linux — dedup keys on data.deviceId
        await db.put(device(DEV_A, 'box', 'linux', 'laptop'));

        const tags = await featuresOf(db, id);
        expect(tags).toContain('device/os/linux');
        expect(tags).not.toContain('device/os/windows');
    });

    test('a device shared by two documents does not lose facets another still implies', async () => {
        await db.put(device(DEV_A, 'a', 'linux', 'server'));
        await db.put(device(DEV_B, 'b', 'linux', 'laptop'));

        const both = await db.put(app('com.example.Both', {
            [DEV_A]: { status: 'available' },
            [DEV_B]: { status: 'available' },
        }));

        // A becomes windows; B is still linux, so device/os/linux must survive
        await db.put(device(DEV_A, 'a', 'win32', 'server'));

        const tags = await featuresOf(db, both);
        expect(tags).toContain('device/os/linux');
        expect(tags).toContain('device/os/windows');
    });

    test('an unregistered device contributes only its id', async () => {
        const id = await db.put(app('com.example.Orphan', { 'never-registered': { status: 'available' } }));
        const tags = await featuresOf(db, id);

        expect(tags).toEqual(['device/id/never-registered']);
    });
});
