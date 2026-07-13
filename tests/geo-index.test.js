import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

const FILE_SCHEMA = 'data/abstraction/file';

const photo = (name, geo) => ({
    schema: FILE_SCHEMA,
    data: {},
    locations: [{ url: `file://cam/${name}.jpg` }],
    metadata: { contentType: 'image/jpeg', ...(geo ? { geo } : {}) },
    checksumArray: [`sha256/${name}`],
});

// S2 GeoIndex: one point BSI over level-21 cell ids, derived from metadata.geo.
// Region queries (bbox/radius) resolve via S2RegionCoverer → per-cell BETWEEN
// range queries — candidate-set semantics (covering may overshoot slightly).
describe('geo index + geo: filters', () => {
    let rootPath;
    let db;
    let bratislava, vienna, sydney, nowhere;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-geo-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
        bratislava = await db.put(photo('bratislava', { lat: 48.1486, lon: 17.1077 }));
        vienna = await db.put(photo('vienna', { lat: 48.2082, lon: 16.3738 }));
        sydney = await db.put(photo('sydney', { lat: -33.8688, lon: 151.2093 }));   // face 3/4 territory — unsigned ids
        nowhere = await db.put(photo('nogeo'));
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('only geotagged docs enter the index', async () => {
        expect(await db.geo.getCount()).toBe(3);
        expect(await db.geo.has(bratislava)).toBe(true);
        expect(await db.geo.has(nowhere)).toBe(false);
    });

    test('bbox filter (mapbox viewport) matches contained docs only', async () => {
        // Central-Europe box: Bratislava + Vienna in, Sydney + no-geo out.
        const res = await db.list({ filters: ['geo:bbox:47.5,15.5,48.8,17.8'], limit: 0 });
        expect(res.map((d) => d.id).sort()).toEqual([bratislava, vienna].sort());
    });

    test('near filter with km radius', async () => {
        const res = await db.list({ filters: ['geo:near:48.1486,17.1077,5km'], limit: 0 });
        expect(res.map((d) => d.id)).toEqual([bratislava]);
    });

    test('southern-hemisphere ids (unsigned > 2^63) round-trip', async () => {
        const res = await db.list({ filters: ['geo:bbox:-34.5,150.5,-33.0,152.0'], limit: 0 });
        expect(res.map((d) => d.id)).toEqual([sydney]);
    });

    test('geo filter composes with features and sigils', async () => {
        const gated = await db.list({
            features: [FILE_SCHEMA],
            filters: ['+geo:bbox:47.5,15.5,48.8,17.8', '!geo:near:48.2082,16.3738,10km'],
            limit: 0,
        });
        // In the CE box but NOT near Vienna → Bratislava only.
        expect(gated.map((d) => d.id)).toEqual([bratislava]);
    });

    test('removing geo on update drops the doc from the index', async () => {
        await db.put({ id: vienna, metadata: { geo: null } }, { emitEvent: false });
        expect(await db.geo.has(vienna)).toBe(false);
        const res = await db.list({ filters: ['geo:bbox:47.5,15.5,48.8,17.8'], limit: 0 });
        expect(res.map((d) => d.id)).toEqual([bratislava]);
    });

    test('deleting a doc removes it from the index', async () => {
        await db.delete(bratislava);
        expect(await db.geo.has(bratislava)).toBe(false);
        expect(await db.geo.getCount()).toBe(2);
    });
});
