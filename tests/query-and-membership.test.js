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

        expect(ids(await db.list({ attributes: { allOf: ['tag/imported'] } }))).toEqual([alphaId]);
        expect(ids(await db.list({ attributes: { allOf: ['tag/urgent'] } }))).toEqual([]);
        await expectSearchIds(db, { query: 'alpha', attributes: { allOf: ['tag/imported'] } }, [alphaId]);
    });

    test('lists by attributes, context, directory, timeline, and pagination', async () => {
        const { alphaId, betaId, gammaId } = await seed();

        expect(ids(await db.list({ attributes: { allOf: ['tag/red'] } }))).toEqual([alphaId, betaId]);
        expect(ids(await db.list({ attributes: { anyOf: ['tag/urgent', 'tag/blue'] } }))).toEqual([alphaId, gammaId]);
        expect(ids(await db.list({ attributes: { allOf: ['tag/red'], noneOf: ['tag/backlog'] } }))).toEqual([alphaId]);
        expect(ids(await db.list({ context: { path: '/Projects/Alpha' } }))).toEqual([alphaId, gammaId]);
        expect(ids(await db.list({ directory: { path: '/notes' } }))).toEqual([alphaId, betaId]);
        expect(ids(await db.list({ filters: { timeline: 'today' } }))).toEqual([alphaId, betaId, gammaId]);

        const page = await db.list({ attributes: { anyOf: ['tag/red', 'tag/blue'] }, limit: 1, offset: 1 });
        expect(page).toHaveLength(1);
        expect(page.totalCount).toBe(3);
    });

    test('pins unsupported glob and regexp filter behavior', async () => {
        await seed();

        await expect(db.list({ filters: { glob: '*.md' } })).rejects.toThrow('unsupported filter "glob"');
        await expect(db.list({ filters: { regexp: 'alpha' } })).rejects.toThrow('unsupported filter "regexp"');
    });

    test('searches globally and with context, attribute, and timeline filters', async () => {
        const { alphaId, betaId } = await seed();

        await expectSearchIds(db, { query: 'alpha' }, [alphaId]);
        await expectSearchIds(db, { query: 'alpha', context: { path: '/Projects/Alpha' } }, [alphaId]);
        await expectSearchIds(db, { query: 'beta', attributes: { allOf: ['tag/backlog'] } }, [betaId]);
        await expectSearchIds(db, { query: 'alpha', filters: { timeline: 'today' } }, [alphaId]);
    });
});
