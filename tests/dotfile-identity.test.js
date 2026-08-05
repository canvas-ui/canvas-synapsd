import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import { normalizeDotfileUrl, dotfileEntryPath } from '../src/utils/path-helpers.js';

const DOTFILE = 'data/schema/dotfile';
const TAB = 'data/schema/tab';
const LINK = 'data/schema/link';

const dotfile = (url, links = {}, type = 'file') => ({
    schema: DOTFILE,
    data: { url, type, links },
});

// A dotfile's identity is WHICH ENTRY IN WHICH REPO — a URI, not a bare path.
// `data.repoPath` could not express an external repo at all, and as an
// un-normalized string it made four spellings of one entry into four documents.
describe('dotfile identity (data.url)', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-dotfile-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('the four un-normalized spellings resolve to ONE document', async () => {
        // Identity is sha*(JSON.stringify(url)), so before normalization these were
        // four separate documents for one repo file.
        const spellings = ['shell/bashrc', './shell/bashrc', 'shell//bashrc', 'shell/bashrc/'];
        const ids = [];
        for (const spelling of spellings) {
            ids.push(await db.put(dotfile(spelling, { 'dev-a': '$HOME/.bashrc' })));
        }

        expect(new Set(ids).size).toBe(1);
        expect((await db.get(ids[0])).data.url).toBe('workspace:dotfiles#shell/bashrc');
    });

    test('a leading slash and an explicit workspace URI are the same document', async () => {
        const bare = await db.put(dotfile('/shell/bashrc'));
        const explicit = await db.put(dotfile('workspace:dotfiles#shell/bashrc'));
        expect(explicit).toBe(bare);
    });

    test('path traversal is rejected', async () => {
        await expect(db.put(dotfile('../etc/passwd'))).rejects.toThrow();
        await expect(db.put(dotfile('shell/../../etc/passwd'))).rejects.toThrow();
    });

    test('an empty entry path is rejected', () => {
        expect(() => normalizeDotfileUrl('workspace:dotfiles#')).toThrow(/empty entry path/);
        expect(() => normalizeDotfileUrl('   ')).toThrow(/must not be empty/);
    });

    test('a workspace-local and an external-repo entry with the same path are DISTINCT', async () => {
        // This is what repoPath could not express: one implicit repo was a
        // hardcoded invariant, so `shell/bashrc` in two repos was one document.
        const local = await db.put(dotfile('workspace:dotfiles#shell/bashrc'));
        const external = await db.put(dotfile('git+ssh://git@github.com/me/dotfiles#shell/bashrc'));

        expect(external).not.toBe(local);
        expect((await db.get(external)).data.url)
            .toBe('git+ssh://git@github.com/me/dotfiles#shell/bashrc');
    });

    test('scheme and host are case-insensitive, the entry path is NOT', async () => {
        const a = await db.put(dotfile('GIT+SSH://Git@GitHub.com/me/dotfiles#shell/bashrc'));
        const b = await db.put(dotfile('git+ssh://git@github.com/me/dotfiles#shell/bashrc'));
        expect(b).toBe(a);

        // Repo paths are case-sensitive — Bashrc is a different file.
        const upper = await db.put(dotfile('git+ssh://git@github.com/me/dotfiles#shell/Bashrc'));
        expect(upper).not.toBe(a);
    });

    test('a folder dotfile round-trips with no content checksum', async () => {
        // A dotfile can be a directory (~/.ssh, ~/.config/nvim) — it has no bytes,
        // which is one of the two reasons it is not a `file` entity.
        const id = await db.put(dotfile('ssh', { 'dev-a': '$HOME/.ssh' }, 'folder'));
        const doc = await db.get(id);

        expect(doc.data.type).toBe('folder');
        expect(doc.data.url).toBe('workspace:dotfiles#ssh');
    });

    test('entryPath exposes what a client joins onto its checkout', async () => {
        const doc = await db.get(await db.put(dotfile('shell/bashrc')));
        expect(doc.entryPath).toBe('shell/bashrc');
        expect(dotfileEntryPath('git+ssh://git@github.com/me/dotfiles#a/b')).toBe('a/b');
    });

    test('a partial write does NOT delete another device\'s link', async () => {
        const id = await db.put(dotfile('shell/bashrc', {
            'dev-a': '$HOME/.bashrc',
            'dev-b': '$HOME/.bashrc',
        }));

        // A direct POST carrying only its own device's mapping. Before the
        // schema-declared merge this replaced the stored doc wholesale.
        const again = await db.put(dotfile('shell/bashrc', { 'dev-c': '$HOME/dotfiles/.bashrc' }));

        expect(again).toBe(id);
        const doc = await db.get(id);
        expect(Object.keys(doc.data.links).sort()).toEqual(['dev-a', 'dev-b', 'dev-c']);
    });

    test('an incoming mapping wins for its own device', async () => {
        const id = await db.put(dotfile('shell/bashrc', { 'dev-a': '$HOME/.bashrc' }));
        await db.put(dotfile('shell/bashrc', { 'dev-a': '$HOME/.config/bashrc' }));

        expect((await db.get(id)).data.links['dev-a']).toBe('$HOME/.config/bashrc');
    });

    test('the merge widens derived device presence too', async () => {
        const id = await db.put(dotfile('shell/bashrc', { 'dev-a': '$HOME/.bashrc' }));
        await db.put(dotfile('shell/bashrc', { 'dev-b': '$HOME/.bashrc' }));

        // locations derive from links, and device/id/* derives from locations —
        // a merge that widens the map must widen both.
        for (const device of ['dev-a', 'dev-b']) {
            const found = await db.list({ features: [`device/id/${device}`], limit: 0 });
            expect(found.map((d) => d.id)).toContain(id);
        }
    });
});

// The checksum index is global per workspace and carries no schema prefix, so two
// schemas whose checksumFields serialize to the same string collided and the
// incoming document silently OVERWROTE the other's id.
describe('checksum dedup is scoped by schema', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-cksum-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('a Tab and a Link with the same URL string keep separate ids', async () => {
        // Tab checksums data.url, Link checksums data.uri — identical strings, so
        // identical checksums, so a collision across two unrelated entities.
        const tab = await db.put({ schema: TAB, data: { url: 'https://example.com/x', title: 't' } });
        const link = await db.put({ schema: LINK, data: { uri: 'https://example.com/x', label: 'l' } });

        expect(link).not.toBe(tab);
        expect((await db.get(tab)).schema).toBe(TAB);
        expect((await db.get(link)).schema).toBe(LINK);
    });

    test('same-schema dedup still works — this must not disable blob dedup', async () => {
        const first = await db.put({ schema: TAB, data: { url: 'https://example.com/y', title: 'a' } });
        const second = await db.put({ schema: TAB, data: { url: 'https://example.com/y', title: 'b' } });
        expect(second).toBe(first);
    });

    test('an unscoped lookup still matches across schemas (find-by-bytes stays intact)', async () => {
        const tab = await db.put({ schema: TAB, data: { url: 'https://example.com/z', title: 't' } });
        const checksum = (await db.get(tab)).getPrimaryChecksum();

        // Route handlers and stored reconciliation ask "which doc has these bytes",
        // where cross-schema matching is correct — so scoping is opt-in, not default.
        expect((await db.getByChecksumString(checksum))?.id).toBe(tab);
        expect((await db.getByChecksumString(checksum, { schema: LINK }))).toBeNull();
    });
});
