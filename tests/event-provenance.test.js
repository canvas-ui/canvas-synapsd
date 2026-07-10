import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import { createEvent } from '../src/utils/events.js';

const tab = (url) => ({ schema: 'data/abstraction/tab', data: { url } });

// Every event envelope must carry an eventId (idempotency key) and provenance
// (origin/causedBy/depth) so the workspace automation layer can recognize and
// bound its own cascades. Caller-supplied provenance rides through the write
// spec into the emitted event.
describe('Event provenance', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-prov-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('envelope defaults: eventId set, origin user, causedBy null, depth 0', () => {
        const evt = createEvent('document.inserted', { id: 1 });
        expect(typeof evt.eventId).toBe('string');
        expect(evt.eventId.length).toBeGreaterThan(10);
        expect(evt.origin).toBe('user');
        expect(evt.causedBy).toBeNull();
        expect(evt.depth).toBe(0);
        // distinct emits get distinct ids
        expect(createEvent('document.inserted', { id: 1 }).eventId).not.toBe(evt.eventId);
    });

    test('put() with provenance emits document.inserted carrying it', async () => {
        const events = [];
        db.on('document.inserted', (evt) => events.push(evt));

        await db.put(tab('https://example.com/a'), {
            context: { path: '/inbox' },
            provenance: { origin: 'rule', causedBy: 'evt-parent', depth: 1 },
        });

        expect(events).toHaveLength(1);
        expect(events[0].origin).toBe('rule');
        expect(events[0].causedBy).toBe('evt-parent');
        expect(events[0].depth).toBe(1);
        expect(events[0].eventId).toBeTruthy();
    });

    test('put() without provenance defaults to origin user / depth 0', async () => {
        const events = [];
        db.on('document.inserted', (evt) => events.push(evt));
        await db.put(tab('https://example.com/b'), { context: { path: '/inbox' } });
        expect(events).toHaveLength(1);
        expect(events[0].origin).toBe('user');
        expect(events[0].depth).toBe(0);
    });

    test('malformed provenance is dropped, not spread into the event', async () => {
        const events = [];
        db.on('document.inserted', (evt) => events.push(evt));
        await db.put(tab('https://example.com/c'), {
            context: { path: '/inbox' },
            provenance: { origin: 42, depth: -1, extra: 'nope' },
        });
        expect(events).toHaveLength(1);
        expect(events[0].origin).toBe('user');
        expect(events[0].depth).toBe(0);
        expect(events[0].extra).toBeUndefined();
    });

    test('link emits document.linked with the full document + provenance', async () => {
        const id = await db.put(tab('https://example.com/d'), { context: { path: '/inbox' } });
        const linked = [];
        db.on('document.linked', (evt) => linked.push(evt));

        await db.link(id, {
            context: { path: '/projects/x' },
            provenance: { origin: 'hook', causedBy: 'evt-p', depth: 1 },
        });

        expect(linked).toHaveLength(1);
        expect(linked[0].id).toBe(id);
        expect(linked[0].document?.data?.url).toBe('https://example.com/d');
        expect(linked[0].origin).toBe('hook');
        expect(linked[0].causedBy).toBe('evt-p');
        expect(linked[0].depth).toBe(1);
    });

    test('unlink emits document.unlinked with the still-indexed document', async () => {
        const id = await db.put(tab('https://example.com/e'), { context: { path: '/inbox/sub' } });
        const unlinked = [];
        db.on('document.unlinked', (evt) => unlinked.push(evt));

        await db.unlink(id, { context: { path: '/inbox/sub' } });

        expect(unlinked).toHaveLength(1);
        expect(unlinked[0].id).toBe(id);
        expect(unlinked[0].document?.data?.url).toBe('https://example.com/e');
        // still in the store — unlink only drops memberships
        expect(await db.get(id)).toBeTruthy();
    });
});
