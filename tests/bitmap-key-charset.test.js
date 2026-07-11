import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import { normalizeBitmapKey } from '../src/indexes/bitmaps/lib/keys.js';

const NOTE_SCHEMA = 'data/abstraction/note';
const note = (title) => ({ schema: NOTE_SCHEMA, data: { title, content: title } });

async function open(rootPath) {
    const db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
    await db.start();
    return db;
}

describe('bitmap key charset (@ and : allowed) + legacy key migration', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-keys-'));
        db = await open(rootPath);
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('normalizeBitmapKey keeps @ : and + (backend addresses + MIME subtypes stay readable)', () => {
        expect(normalizeBitmapKey('data/backend/imap/user@domain.tld')).toBe('data/backend/imap/user@domain.tld');
        expect(normalizeBitmapKey('data/backend/workspace:home')).toBe('data/backend/workspace:home');
        // '+' survives mid-key so MIME subtypes round-trip (svg+xml, ld+json) — it's
        // only a query sigil in leading position (splitSigil slices the first char).
        expect(normalizeBitmapKey('data/mime/image/svg+xml')).toBe('data/mime/image/svg+xml');
        expect(normalizeBitmapKey('data/mime/application/ld+json')).toBe('data/mime/application/ld+json');
        // everything else outside the charset still squashes to '_'
        expect(normalizeBitmapKey('tag/hello world!')).toBe('tag/hello_world_');
        expect(normalizeBitmapKey('data/Backend/IMAP/User@Domain.TLD')).toBe('data/backend/imap/user@domain.tld');
        // '!' prefix still means negation
        expect(normalizeBitmapKey('!tag/foo')).toBe('!tag/foo');
    });

    test('feature bitmaps tick and query under the @-key', async () => {
        const id = await db.put(note('mail'), { features: ['data/backend/imap/user@domain.tld'] });
        const result = await db.list({ features: { allOf: ['data/backend/imap/user@domain.tld'] } });
        expect(result.map((d) => d.id)).toContain(id);
    });

    test('migrateBitmapKey merges a legacy squashed key into the canonical one', async () => {
        const legacy = 'data/backend/imap/user_domain.tld';
        const canonical = 'data/backend/imap/user@domain.tld';

        // one doc ticked under the legacy key (pre-charset-widening state),
        // one under the canonical key (post-upgrade insert)
        const oldDoc = await db.put(note('old'), { features: [legacy] });
        const newDoc = await db.put(note('new'), { features: [canonical] });

        const migrated = await db.migrateBitmapKey(legacy, canonical);
        expect(migrated).toBe(true);

        const result = await db.list({ features: { allOf: [canonical] } });
        const ids = result.map((d) => d.id);
        expect(ids).toContain(oldDoc);
        expect(ids).toContain(newDoc);
        expect(db.bitmapIndex.hasBitmap(legacy)).toBe(false);

        // idempotent: second run is a no-op
        expect(await db.migrateBitmapKey(legacy, canonical)).toBe(false);
    });
});
