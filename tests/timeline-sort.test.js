import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const FILE_SCHEMA = 'data/abstraction/file';

const photo = (i, capturedAt) => ({
    schema: FILE_SCHEMA,
    data: {},
    locations: [{ url: `file://cam/IMG_${i}.jpg` }],
    metadata: { contentType: 'image/jpeg', ...(capturedAt ? { exif: { capturedAt } } : {}) },
    checksumArray: [`sha256/photo${i}`],
    ...(capturedAt ? { timelines: [{ timeline: 'content', start: capturedAt }] } : {}),
});

// Server-side timeline sort: list({ sortBy: 'content' }) orders by the
// timeline's BSI values BEFORE pagination, so page 1 of a large gallery is
// already in capture order. Docs with no value on the timeline always trail.
describe('list() sortBy timeline', () => {
    let rootPath;
    let db;
    let ids;        // insertion order
    let byCapture;  // chronological order
    let noExifId;

    // Capture dates deliberately shuffled vs insertion order.
    const captures = [
        '2023-05-10T09:00:00.000Z',
        '2021-03-01T12:00:00.000Z',
        '2024-11-20T15:30:00.000Z',
        '2022-07-04T18:45:00.000Z',
    ];

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-tl-sort-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
        ids = [];
        for (let i = 0; i < captures.length; i++) { ids.push(await db.put(photo(i, captures[i]))); }
        noExifId = await db.put(photo(99));
        byCapture = ids
            .map((id, i) => ({ id, at: captures[i] }))
            .sort((a, b) => a.at.localeCompare(b.at))
            .map((e) => e.id);
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('asc sorts by capture date, unsortable docs trail', async () => {
        const res = await db.list({ options: { sortBy: 'content', order: 'asc', limit: 0 } });
        expect(res.map((d) => d.id)).toEqual([...byCapture, noExifId]);
    });

    test('desc reverses the keyed order, unsortable docs still trail', async () => {
        const res = await db.list({ options: { sortBy: 'content', order: 'desc', limit: 0 } });
        expect(res.map((d) => d.id)).toEqual([...[...byCapture].reverse(), noExifId]);
    });

    test('pagination slices the sorted sequence and keeps totalCount', async () => {
        const res = await db.list({ options: { sortBy: 'content', order: 'asc', limit: 2, offset: 2 } });
        expect(res.map((d) => d.id)).toEqual(byCapture.slice(2, 4));
        expect(res.totalCount).toBe(5);
    });

    test('composes with a t:content range filter', async () => {
        const res = await db.list({
            filters: ['t:content:2022-01-01..2023-12-31'],
            options: { sortBy: 'content', order: 'asc', limit: 0 },
        });
        expect(res.map((d) => d.id)).toEqual([byCapture[1], byCapture[2]]);
    });

    test('sortBy accepts the t: prefix and top-level spec placement', async () => {
        const res = await db.list({ sortBy: 't:content', order: 'asc', limit: 3 });
        expect(res.map((d) => d.id)).toEqual(byCapture.slice(0, 3));
    });

    test('sortBy on crud:created matches insertion order', async () => {
        const res = await db.list({ options: { sortBy: 'crud:created', order: 'asc', limit: 0 } });
        expect(res.map((d) => d.id)).toEqual([...ids, noExifId]);
    });
});
