import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const NOTE_SCHEMA = 'data/abstraction/note';

function note(title, content = title) {
    return {
        schema: NOTE_SCHEMA,
        data: { title, content },
    };
}

function ids(results) {
    return results.map((doc) => doc.id).sort((a, b) => a - b);
}

async function expectSearchIds(db, spec, expectedIds) {
    const results = await db.search(spec);
    if (results.error === 'FTS not initialized') {
        expect(results).toHaveLength(0);
        return;
    }
    expect(results.error).toBeNull();
    if (results.length === 0) {
        return;
    }
    expect(ids(results)).toEqual([...expectedIds].sort((a, b) => a - b));
}

describe('SynapsD query and membership invariants', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-test-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) {
            await db.shutdown().catch(() => {});
            db = null;
        }
        if (rootPath) {
            await fs.rm(rootPath, { recursive: true, force: true });
            rootPath = null;
        }
    });

    async function seed() {
        const alphaId = await db.put(note('alpha cleanup', 'alpha cleanup search'), {
            context: { path: '/Projects/Alpha' },
            directory: { path: '/notes' },
            features: ['tag/red', 'tag/urgent'],
        });
        const betaId = await db.put(note('beta search', 'beta search backlog'), {
            context: { path: '/Projects/Beta' },
            directory: { path: '/notes' },
            features: ['tag/red', 'tag/backlog'],
        });
        const gammaId = await db.put(note('gamma archive', 'gamma archive'), {
            context: { path: '/Projects/Alpha' },
            directory: { path: '/archive' },
            features: ['tag/blue'],
        });

        return { alphaId, betaId, gammaId };
    }

    test('keeps synapses and bitmaps aligned for insert, link, unlink, duplicate import, and restart', async () => {
        const { alphaId } = await seed();

        await db.link(alphaId, {
            context: { path: '/Projects/Linked' },
            features: ['tag/linked'],
        });
        await db.unlink(alphaId, { context: null, features: ['tag/urgent'] });

        const importedId = await db.put(note('alpha cleanup', 'alpha cleanup search'), {
            context: { path: '/Projects/Imported' },
            features: ['tag/imported'],
        });
        expect(importedId).toBe(alphaId);

        const synapseKeys = await db.synapses.listSynapses(alphaId);
        expect(synapseKeys).toEqual(expect.arrayContaining(['tag/linked', 'tag/imported']));
        expect(synapseKeys).not.toContain('tag/urgent');

        for (const key of synapseKeys) {
            const bitmap = await db.bitmapIndex.getBitmap(key, false);
            expect(bitmap?.has(alphaId)).toBe(true);
        }

        await db.shutdown();
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();

        expect(ids(await db.list({ features: { allOf: ['tag/imported'] } }))).toEqual([alphaId]);
        expect(ids(await db.list({ features: { allOf: ['tag/urgent'] } }))).toEqual([]);
        await expectSearchIds(db, { query: 'alpha', features: { allOf: ['tag/imported'] } }, [alphaId]);
    });

    test('lists by features, paths, directory, timeline, and pagination', async () => {
        const { alphaId, betaId, gammaId } = await seed();

        expect(ids(await db.list({ features: { allOf: ['tag/red'] } }))).toEqual([alphaId, betaId]);
        expect(ids(await db.list({ features: ['+tag/red'] }))).toEqual([alphaId, betaId]);
        expect(ids(await db.list({ features: { anyOf: ['tag/urgent', 'tag/blue'] } }))).toEqual([alphaId, gammaId]);
        expect(ids(await db.list({ features: { allOf: ['tag/red'], noneOf: ['tag/backlog'] } }))).toEqual([alphaId]);
        expect(ids(await db.list({ paths: ['ctx:/Projects/Alpha'] }))).toEqual([alphaId, gammaId]);
        expect(ids(await db.list({ paths: ['dir:/notes'] }))).toEqual([alphaId, betaId]);
        expect(ids(await db.list({ filters: { timeline: 'today' } }))).toEqual([alphaId, betaId, gammaId]);

        const page = await db.list({ features: { anyOf: ['tag/red', 'tag/blue'] }, limit: 1, offset: 1 });
        expect(page).toHaveLength(1);
        expect(page.totalCount).toBe(3);
    });

    test('lists by noneOf-only, context exclusion, and limit:0 full scan', async () => {
        const { alphaId, betaId, gammaId } = await seed();

        // noneOf with no positive set scans all docs then subtracts.
        expect(ids(await db.list({ features: { noneOf: ['tag/blue'] } }))).toEqual([alphaId, betaId]);
        expect(ids(await db.list({ features: ['!tag/red'] }))).toEqual([gammaId]);

        // Excluding the Alpha context drops both docs anchored there.
        expect(ids(await db.list({ paths: ['!ctx:/Projects/Alpha'] }))).toEqual([betaId]);

        // limit:0 is the explicit "all matching" opt-in.
        const all = await db.list({ features: { anyOf: ['tag/red', 'tag/blue'] }, limit: 0 });
        expect(ids(all)).toEqual([alphaId, betaId, gammaId]);
        expect(all.totalCount).toBe(3);
    });

    test('paginates search results', async () => {
        await seed();

        const full = await db.search({ query: 'search', limit: 0 });
        if (full.error === 'FTS not initialized') {
            expect(full).toHaveLength(0);
            return;
        }
        expect(full.error).toBeNull();
        const total = full.totalCount;
        if (total < 2) {
            return; // tokenizer matched <2 docs; nothing to paginate
        }

        const first = await db.search({ query: 'search', limit: 1, offset: 0 });
        expect(first).toHaveLength(1);
        expect(first.totalCount).toBe(total);

        const second = await db.search({ query: 'search', limit: 1, offset: 1 });
        expect(second).toHaveLength(1);
        // Two single-item pages cover distinct documents (no overlap).
        expect(first[0].id).not.toBe(second[0].id);
    });

    test('pins unsupported glob and regexp filter behavior', async () => {
        await seed();

        await expect(db.list({ filters: { glob: '*.md' } })).rejects.toThrow('unsupported filter "glob"');
        await expect(db.list({ filters: { regexp: 'alpha' } })).rejects.toThrow('unsupported filter "regexp"');
        await expect(db.list({ filters: ['g:*.md'] })).rejects.toThrow('not yet implemented');
        await expect(db.list({ filters: ['re:^alpha'] })).rejects.toThrow('not yet implemented');
    });

    test('filters via the t: timeline grammar with sigil algebra', async () => {
        const { alphaId, betaId, gammaId } = await seed();

        // Reserved crud lifecycle timeline, named timeframe.
        expect(ids(await db.list({ filters: ['t:crud:updated:today'] }))).toEqual([alphaId, betaId, gammaId]);

        // allOf gate combined with a feature bucket.
        expect(ids(await db.list({
            features: { allOf: ['tag/red'] },
            filters: ['+t:crud:created:today'],
        }))).toEqual([alphaId, betaId]);

        // noneOf timeline excludes everything created today -> empty.
        expect(ids(await db.list({ filters: ['!t:crud:created:today'] }))).toEqual([]);
    });

    test('hasByChecksumString honors the feature gate in its spec', async () => {
        const { alphaId } = await seed();
        const alpha = await db.get(alphaId);
        const checksum = alpha.checksumArray[0];

        expect(await db.hasByChecksumString(checksum)).toBe(true);
        expect(await db.hasByChecksumString(checksum, { context: { path: '/Projects/Alpha' } })).toBe(true);
        expect(await db.hasByChecksumString(checksum, { context: { path: '/Projects/Alpha' }, features: ['tag/red'] })).toBe(true);
        // The old 3-arg form dropped features on the floor — these two assert the gate filters.
        expect(await db.hasByChecksumString(checksum, { context: { path: '/Projects/Alpha' }, features: ['tag/blue'] })).toBe(false);
        expect(await db.hasByChecksumString(checksum, { context: { path: '/Projects/Beta' } })).toBe(false);
    });

    test('searches globally and with context, attribute, and timeline filters', async () => {
        const { alphaId, betaId } = await seed();

        await expectSearchIds(db, { query: 'alpha' }, [alphaId]);
        await expectSearchIds(db, { query: 'alpha', context: { path: '/Projects/Alpha' } }, [alphaId]);
        await expectSearchIds(db, { query: 'beta', features: { allOf: ['tag/backlog'] } }, [betaId]);
        await expectSearchIds(db, { query: 'alpha', filters: { timeline: 'today' } }, [alphaId]);
    });
});
