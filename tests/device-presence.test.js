import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const DOTFILE_SCHEMA = 'data/schema/dotfile';
const APP_SCHEMA = 'data/schema/application';
const NOTE_SCHEMA = 'data/schema/note';

const DEV_A = 'device-aaa';
const DEV_B = 'device-bbb';

function dotfile(entry, links, type = 'file') {
    // v3: identity is a normalized URI; a bare path resolves to the workspace repo.
    return { schema: `${DOTFILE_SCHEMA}/${type}`, data: { url: entry, links } };
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
    const data = { appId, installs };
    if (SOURCE_FOR[type]) { data.source = SOURCE_FOR[type]; }
    return { schema: `${APP_SCHEMA}/${type}`, data };
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
            schema: `${APP_SCHEMA}/appimage`,
            data: {
                appId: 'com.example.Remote',
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
        // THE DRIFT BUG (regression test — fails without Document.deriveLocations).
        //
        // Dotfile/Application derived locations in their CONSTRUCTOR only, while
        // Document.update() overwrote `data` without re-deriving. Two things
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
            data: { url: 'shell/bashrc', links: { [DEV_A]: '$HOME/.bashrc' } },
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
            schema: `${DOTFILE_SCHEMA}/file`,
            data: { url: 'shell/bashrc', links: { [DEV_A]: '$HOME/.bashrc' } },
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
            schema: `${DOTFILE_SCHEMA}/file`,
            data: {
                url: 'shell/bashrc',
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

const DEVICE_SCHEMA = 'data/schema/device';

function device(deviceId, name, platform, type) {
    return { schema: DEVICE_SCHEMA, data: { deviceId, name, platform, type } };
}

// Same thing, keyword-style, for the suites that vary which facets exist.
const box = (deviceId, data) => ({ schema: DEVICE_SCHEMA, data: { deviceId, name: deviceId, ...data } });

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
            features: { allOf: ['data/schema/application'], noneOf: [`device/id/${DEV_A}`] },
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
            features: { allOf: ['data/schema/application', 'device/os/windows'] },
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

describe('capability (data/platform) vs presence (device/id)', () => {
    let rootPath;
    let db;

    const capable = (appId, platform, installs = {}) => ({
        schema: `${APP_SCHEMA}/flatpak`,
        data: { appId, platform, installs, source: SOURCE_FOR.flatpak },
    });

    const idsOf = async (features) => {
        const result = await db.list({ features });
        return (Array.isArray(result) ? result : result.data ?? []).map((d) => d.id);
    };

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-devcap-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('"applicable here" and "already here" are two intersections, no per-app inspection', async () => {
        // The workspace-of-30-apps case: logging into a new box, most are for
        // other platforms and most of the rest are not installed yet.
        await db.put(box(DEV_A, { platform: 'linux', arch: 'x86_64' }));

        const here = await db.put(capable('com.example.Here', ['linux/x86_64'], { [DEV_A]: { status: 'available' } }));
        const installable = await db.put(capable('com.example.Installable', ['linux/x86_64', 'mac/aarch64']));
        const wrongOs = await db.put(capable('com.example.Mac', ['mac/aarch64'], { [DEV_A]: { status: 'available' } }));

        const applicable = ['data/schema/application', 'data/platform/linux/x86_64'];

        expect((await idsOf({ allOf: applicable })).sort()).toEqual([here, installable].sort());
        expect(await idsOf({ allOf: [...applicable, `device/id/${DEV_A}`] })).toEqual([here]);
        expect(await idsOf({ allOf: applicable, noneOf: [`device/id/${DEV_A}`] })).toEqual([installable]);

        // Present but not applicable is a real state (installed before a migration,
        // or a mislabelled package) and stays visible rather than being filtered.
        expect(await idsOf({ allOf: ['data/platform/mac/aarch64', `device/id/${DEV_A}`] })).toEqual([wrongOs]);
    });

    test('an app with no declared platform is in no capability bitmap', async () => {
        // Absence is not "runs everywhere": an undeclared app must not silently
        // pass a capability filter it was never checked against.
        const id = await db.put(capable('com.example.Unknown', undefined, { [DEV_A]: { status: 'available' } }));

        expect(await idsOf({ allOf: ['data/platform/linux/x86_64'] })).toEqual([]);
        expect(await idsOf({ allOf: [`device/id/${DEV_A}`] })).toEqual([id]);
    });
});

describe('the device/os chain and device/arch', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-devchain-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('every prefix of the os chain is ticked, so any tier is one key', async () => {
        await db.put(box(DEV_A, {
            platform: 'linux', osDistro: 'ubuntu', osVersion: '24.04',
            arch: 'x86_64', type: 'laptop',
        }));
        const id = await db.put(app('com.example.App', { [DEV_A]: { status: 'available' } }));

        expect(await featuresOf(db, id)).toEqual([
            'device/arch/x86_64',
            `device/id/${DEV_A}`,
            'device/os/linux',
            'device/os/linux/ubuntu',
            'device/os/linux/ubuntu/24.04',
            'device/type/laptop',
        ]);
    });

    test('a family with no distro tier gets a shorter chain, not a missing version', async () => {
        // "which boxes are still on Windows 10" has to be answerable too, so an
        // empty tier is skipped rather than truncating everything below it.
        await db.put(box(DEV_A, { platform: 'darwin', osVersion: '15.2' }));
        await db.put(box(DEV_B, { platform: 'win32', osVersion: '10' }));

        const onMac = await db.put(app('com.example.Mac', { [DEV_A]: { status: 'available' } }));
        const onWin = await db.put(app('com.example.Win', { [DEV_B]: { status: 'available' } }));

        expect(await featuresOf(db, onMac)).toEqual([`device/id/${DEV_A}`, 'device/os/mac', 'device/os/mac/15.2']);
        expect(await featuresOf(db, onWin)).toEqual([`device/id/${DEV_B}`, 'device/os/windows', 'device/os/windows/10']);
    });

    test('a distro upgrade retires the version key and keeps the tiers above it', async () => {
        // The fleet case: 22.04 -> 24.04 must not leave a box answering both, or
        // "what is still on 22.04" over-reports forever.
        await db.put(box(DEV_A, { platform: 'linux', osDistro: 'ubuntu', osVersion: '22.04' }));
        const id = await db.put(app('com.example.App', { [DEV_A]: { status: 'available' } }));
        expect(await featuresOf(db, id)).toContain('device/os/linux/ubuntu/22.04');

        await db.put(box(DEV_A, { platform: 'linux', osDistro: 'ubuntu', osVersion: '24.04' }));

        const tags = await featuresOf(db, id);
        expect(tags).toContain('device/os/linux/ubuntu/24.04');
        expect(tags).not.toContain('device/os/linux/ubuntu/22.04');
        expect(tags).toEqual(expect.arrayContaining(['device/os/linux', 'device/os/linux/ubuntu']));
    });

    test('a Device document carries its own identity keys', async () => {
        const deviceDoc = await db.put(box(DEV_A, {
            platform: 'linux', osDistro: 'ubuntu', osVersion: '24.04', arch: 'aarch64', type: 'server',
        }));

        const fleet = await db.list({
            features: { allOf: [DEVICE_SCHEMA, 'device/os/linux/ubuntu/24.04', 'device/arch/aarch64'] },
        });
        expect((Array.isArray(fleet) ? fleet : fleet.data ?? []).map((d) => d.id)).toEqual([deviceDoc]);
    });

    test('rebuildL3 restores the Device self-tags', async () => {
        // Regression: these were asserted by the caller and therefore bitmap-only,
        // while rebuildL3 drops the whole device/ namespace and replays it from
        // locations[] — which a Device row has none of pointing at itself. The
        // rebuild deleted them with nothing to put them back.
        const deviceDoc = await db.put(box(DEV_A, { platform: 'linux', osDistro: 'ubuntu', osVersion: '24.04' }));
        const before = await featuresOf(db, deviceDoc);

        await db.rebuildL3();

        expect(await featuresOf(db, deviceDoc)).toEqual(before);
        expect(before).toContain('device/os/linux/ubuntu/24.04');
    });

    test('rebuildL3 restores facets inherited from a device', async () => {
        await db.put(box(DEV_A, { platform: 'linux', osDistro: 'ubuntu', osVersion: '24.04', arch: 'x86_64' }));
        const id = await db.put(app('com.example.App', { [DEV_A]: { status: 'available' } }));
        const before = await featuresOf(db, id);

        await db.rebuildL3();

        expect(await featuresOf(db, id)).toEqual(before);
    });

    test('a tier cannot smuggle in another tier', async () => {
        // The one shape rule enforced: the chain's arity. Which OSs have which
        // tiers is NOT policed (that needs a registry of known systems, wrong the
        // first time a buildroot image shows up), but a value containing '/' would
        // silently deepen the chain and is folded instead.
        await db.put(box(DEV_A, { platform: 'linux', osDistro: 'ubuntu/core', osVersion: '24' }));
        const id = await db.put(app('com.example.App', { [DEV_A]: { status: 'available' } }));

        const tags = await featuresOf(db, id);
        expect(tags).toContain('device/os/linux/ubuntu_core');
        expect(tags).toContain('device/os/linux/ubuntu_core/24');
        expect(tags).not.toContain('device/os/linux/ubuntu');
    });

    test('an unpoliced shape still produces a usable key', async () => {
        // A custom distro lands correctly with no special casing, which is the
        // argument against a known-OS registry.
        await db.put(box(DEV_A, { platform: 'linux', osDistro: 'iolinux', osVersion: '1.2' }));
        const id = await db.put(app('com.example.App', { [DEV_A]: { status: 'available' } }));

        expect(await featuresOf(db, id)).toEqual(expect.arrayContaining([
            'device/os/linux', 'device/os/linux/iolinux', 'device/os/linux/iolinux/1.2',
        ]));
    });

    test('a version with a space is still a legal key', async () => {
        await db.put(box(DEV_A, { platform: 'linux', osDistro: 'ubuntu', osVersion: '22.04 LTS' }));
        const id = await db.put(app('com.example.App', { [DEV_A]: { status: 'available' } }));

        expect(await featuresOf(db, id)).toContain('device/os/linux/ubuntu/22.04_lts');
    });
});
