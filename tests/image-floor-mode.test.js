import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import SynapsD from '../src/index.js';

/**
 * The image relevance floor: relative window vs absolute cutoff.
 *
 * Why relative is the default. Text→image distances are NOT comparable across
 * queries or models — the modality gap shifts and compresses the whole
 * distribution (CLIP ViT-B/32 puts true matches around 0.73 where SigLIP puts
 * them around 0.92). A single global cutoff therefore either keeps everything
 * or nothing, and every re-embed with a new model silently invalidates it.
 * Anchoring the window on the query's OWN best hit removes that dependence.
 *
 * The catch a relative window has to answer for: on its own it can never say
 * "nothing matches" — it always keeps the nearest photo. imageMaxDistance stays
 * on as a CEILING for exactly that case.
 *
 * Modelled with a fake image space: the query embeds to a fixed axis and each
 * photo sits at a chosen cosine distance from it, so "which photos are near"
 * is exact rather than model-dependent.
 */

const DIM = 8;
const IMG_SPACE = {
    image: {
        table: 'vec_image_test', model: 'test-img', dim: DIM, annIndex: false,
        bitmapKey: 'internal/embed/vectors/image/test-img',
        seenKey: 'internal/embed/seen/image/test-img',
    },
};

const QUERY = (() => { const v = new Array(DIM).fill(0); v[0] = 1; return v; })();

// A unit vector at cosine distance `d` from QUERY (distance = 1 − cos).
const atDistance = (d) => {
    const cos = 1 - d;
    const v = new Array(DIM).fill(0);
    v[0] = cos;
    v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
    return v;
};

describe('image floor mode', () => {
    let dbPath;
    let db;

    const open = async (semantic) => {
        dbPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-floor-'));
        db = new SynapsD({
            path: dbPath,
            backupOnOpen: false,
            backupOnClose: false,
            // Only the image space embeds. Returning a vector for 'text' too
            // would hand an 8-dim query to the 384-dim text table — harmless
            // (the leg degrades to empty by design) but it buries the run in
            // warnings that look like failures.
            semantic: { enabled: true, spaces: IMG_SPACE, embedQuery: async (_text, space) => (space === 'image' ? QUERY : null), ...semantic },
        });
        await db.start();
    };

    const addPhotoAt = async (label, distance) => {
        const id = await db.put({ schema: 'data/schema/note', data: { title: label, content: label } });
        await db.storeDocumentEmbeddings(id, 'data/schema/note', new Date().toISOString(),
            [{ chunkId: 0, text: '', vector: atDistance(distance) }], { space: 'image' });
        return id;
    };

    // A cluster of matches plus a well-separated tail, placed at whatever
    // absolute scale the "model" happens to use.
    const seedAtScale = async (base) => {
        const near = [];
        for (let i = 0; i < 3; i++) { near.push(await addPhotoAt(`near ${i}`, base + i * 0.005)); }
        const far = [];
        for (let i = 0; i < 3; i++) { far.push(await addPhotoAt(`far ${i}`, base + 0.2 + i * 0.005)); }
        return { near, far };
    };

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (dbPath) { await fs.rm(dbPath, { recursive: true, force: true }); dbPath = null; }
    });

    test('the relative window finds the same cluster at any absolute scale', async () => {
        // Scale A: a "SigLIP-like" corpus whose matches sit near 0.92.
        await open({ imageFloorMode: 'relative', imageMaxDistance: 0 });
        const a = await seedAtScale(0.92);
        const hitsA = [...await db.search({ query: 'q', mode: 'vector', limit: 50, idsOnly: true })];
        expect(new Set(hitsA)).toEqual(new Set(a.near));
        expect(hitsA.some((id) => a.far.includes(id))).toBe(false);

        await db.shutdown(); db = null;
        await fs.rm(dbPath, { recursive: true, force: true }); dbPath = null;

        // Scale B: a "CLIP-like" corpus whose identical structure sits near 0.73.
        // Same setting, same answer — that is the property an absolute cutoff
        // cannot have.
        await open({ imageFloorMode: 'relative', imageMaxDistance: 0 });
        const b = await seedAtScale(0.73);
        const hitsB = [...await db.search({ query: 'q', mode: 'vector', limit: 50, idsOnly: true })];
        expect(new Set(hitsB)).toEqual(new Set(b.near));
        expect(hitsB.some((id) => b.far.includes(id))).toBe(false);
    });

    test('an absolute cutoff calibrated for one scale collapses on the other', async () => {
        // 0.945 is the shipped SigLIP-era default. On a CLIP-scale corpus it sits
        // above EVERYTHING, so it stops filtering — the "count equals the kNN
        // depth" symptom that started this whole thread.
        await open({ imageFloorMode: 'absolute', imageMaxDistance: 0.945 });
        const { near, far } = await seedAtScale(0.73);
        const hits = [...await db.search({ query: 'q', mode: 'vector', limit: 50, idsOnly: true })];
        expect(new Set(hits)).toEqual(new Set([...near, ...far]));
    });

    test('the ceiling still lets a relative window reject an irrelevant query', async () => {
        // The honest weakness of a relative window: it always keeps its best hit.
        // A ceiling is what allows "nothing here matches" to remain expressible.
        await open({ imageFloorMode: 'relative', imageMaxDistance: 0.5 });
        await seedAtScale(0.73);   // everything sits well beyond the ceiling
        const hits = [...await db.search({ query: 'q', mode: 'vector', limit: 50, idsOnly: true })];
        expect(hits).toEqual([]);
    });

    /**
     * The cost of a relative window, pinned so it stays visible.
     *
     * A photo matching TWO concepts is necessarily further from each one than a
     * pure example of it: "a snowy window" is further from "winter" than an
     * open snowfield. A window anchored on the best hit therefore cuts exactly
     * the multi-concept photos that a refinement chain is looking for — the
     * margin is what buys them back, and it has to be wide enough to span the
     * gap between "pure" and "mixed", not just the jitter between near matches.
     */
    test('the margin governs whether multi-concept photos survive', async () => {
        await open({ imageFloorMode: 'relative', imageMaxDistance: 0, imageRelativeMargin: 0.035 });
        const pure = await addPhotoAt('pure concept', 0.10);
        const mixed = await addPhotoAt('two concepts', 0.30);

        const tight = [...await db.search({ query: 'q', mode: 'vector', limit: 50, idsOnly: true })];
        expect(tight).toEqual([pure]);           // mixed is 0.20 past the best hit

        db.setSearchTuning({ imageRelativeMargin: 0.25 });
        const wide = [...await db.search({ query: 'q', mode: 'vector', limit: 50, idsOnly: true })];
        expect(new Set(wide)).toEqual(new Set([pure, mixed]));
    });

    test('setSearchTuning switches modes live and reports the effective values', async () => {
        await open({});
        const asRelative = db.setSearchTuning({ imageFloorMode: 'relative', imageRelativeMargin: 0.05 });
        expect(asRelative.imageFloorMode).toBe('relative');
        expect(asRelative.imageRelativeMargin).toBe(0.05);

        const asAbsolute = db.setSearchTuning({ imageFloorMode: 'absolute' });
        expect(asAbsolute.imageFloorMode).toBe('absolute');
        // Junk is ignored rather than clobbering a working setting.
        expect(db.setSearchTuning({ imageFloorMode: 'sideways' }).imageFloorMode).toBe('absolute');
        expect(db.setSearchTuning({ imageRelativeMargin: -1 }).imageRelativeMargin).toBe(0.05);
    });
});
