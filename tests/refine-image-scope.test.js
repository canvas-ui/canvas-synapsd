import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import SynapsD from '../src/index.js';

/**
 * Refinement over PHOTOS: "winter" then "window" must return winter photos that
 * show a window — not every window photo in the library.
 *
 * The failure this pins: the intermediate fold asked the image kNN for
 * FOLD_LIMIT (1e6) nearest photos. `limit` means "every match" to FTS, but a kNN
 * has no such notion — it always returns its top-K — so stage one folded the
 * ENTIRE library into the scope, the AND stopped constraining, and the refine
 * collapsed to whatever the last query matched. Observed in the UI as "winter"
 * (250 snow photos) → refine "window" (21 summer construction photos).
 *
 * Exercised with a small-dim fake image space and an injected query embedder —
 * no model, no worker (same approach as search-by-vector.test.js).
 */

const DIM = 8;
const IMG_SPACE = {
    image: {
        table: 'vec_image_test', model: 'test-img', dim: DIM, annIndex: false,
        bitmapKey: 'internal/embed/vectors/image/test-img',
        seenKey: 'internal/embed/seen/image/test-img',
    },
};

const vec = (values) => {
    const v = new Array(DIM).fill(0);
    values.forEach((x, i) => { v[i] = x; });
    return v;
};

const WINTER = vec([1]);            // query axis 1
const WINDOW = vec([0, 1]);         // query axis 2 (orthogonal to winter)
const BOTH = vec([0.7071, 0.7071]); // a winter photo that shows a window

// The injected embedder: the two query words map to the two axes. Anything else
// is orthogonal to both, so it can never be a near neighbour by accident.
const embedQuery = async (text) => {
    const t = String(text).toLowerCase();
    if (t.includes('winter')) { return WINTER; }
    if (t.includes('window')) { return WINDOW; }
    return vec([0, 0, 1]);
};

const photo = (title) => ({ schema: 'data/schema/note', data: { title, content: title } });

describe('refinement over an image-backed corpus', () => {
    let dbPath;
    let db;

    const addPhoto = async (title, vector) => {
        const id = await db.put(photo(title));
        await db.storeDocumentEmbeddings(id, 'data/schema/note', new Date().toISOString(),
            [{ chunkId: 0, text: '', vector }], { space: 'image' });
        return id;
    };

    beforeEach(async () => {
        dbPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-refine-img-'));
        db = new SynapsD({
            path: dbPath,
            backupOnOpen: false,
            backupOnClose: false,
            // imageMaxDistance 0 = NO relevance floor. That is the configuration
            // the bug was observed under (the result count equalled the kNN depth
            // exactly, i.e. nothing was being cut by distance), and it is the
            // case where bounding the fold depth is the only thing standing
            // between a refine and the whole library.
            semantic: { enabled: true, spaces: IMG_SPACE, embedQuery, imageMaxDistance: 0 },
        });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (dbPath) { await fs.rm(dbPath, { recursive: true, force: true }); dbPath = null; }
    });

    /**
     * The invariant a user actually relies on: REFINING NARROWS WHAT YOU JUST
     * SAW. So the result of ["winter", "window"] must be a subset of the result
     * of "winter" alone. That is the property the unbounded fold destroyed —
     * stage one silently widened to the entire library, so the refine could (and
     * did) return photos that plain "winter" never showed.
     *
     * The corpus is built so ranking is TOTAL and deterministic: the summer
     * photos carry a increasing winter component, so ordering by "nearest to
     * winter" is exactly the reverse of ordering by "nearest to window". The
     * refine therefore lands on a disjoint slice depending on whether stage one
     * was bounded — which is what makes this test discriminate rather than
     * merely pass.
     */
    test('a refine returns a SUBSET of the search it refines', async () => {
        // Titles deliberately share NO trigram with either query: the FTS index
        // is ngram-tokenized (min length 3), so "winter" and "window" match each
        // other lexically through the shared "win" gram. That is real behaviour
        // worth knowing about, but it would mask what this test is about — the
        // kNN side of the fold — so the text side is neutralised here.
        for (let i = 0; i < 20; i++) { await addPhoto(`alpha ${i}`, WINTER); }
        await addPhoto('beta', BOTH);
        // summer_i = [i*0.005, 1]: rising winter component. Higher i → closer to
        // "winter", farther from "window". Lower i → a perfect "window" match.
        const summerIds = [];
        for (let i = 0; i < 140; i++) { summerIds.push(await addPhoto(`gamma ${i}`, vec([i * 0.005, 1]))); }

        const refined = [...await db.searchRefined(['winter', 'window'], null, { limit: 10, mode: 'hybrid', idsOnly: true })];
        expect(refined.length).toBeGreaterThan(0);

        // Stage one is bounded to the 100 photos nearest "winter" — i.e. the
        // high-i end. So the refine can only ever land there. Unbounded, stage
        // one saw all 161 and the refine settled on the PERFECT window matches
        // (i≈0), which a plain "winter" search never surfaces: summer windows
        // returned by a winter refine, exactly the reported symptom.
        const pureWindow = summerIds.slice(0, 20);   // i = 0..19, farthest from winter
        const strays = refined.filter((id) => pureWindow.includes(id));
        expect(strays).toEqual([]);
    }, 120_000);

    test('with the relevance floor on, the refine narrows to the true intersection', async () => {
        // The floor is the mechanism that is SUPPOSED to do this work; the depth
        // bound above is the backstop for when it is off or badly calibrated.
        await db.setSearchTuning?.({ imageMaxDistance: 0.5 });

        const winterWindow = await addPhoto('winter window', BOTH);
        const snowOnly = await addPhoto('snow field', WINTER);
        const summerWindow = await addPhoto('summer window', WINDOW);

        const ids = [...await db.searchRefined(['winter', 'window'], null, { limit: 50, mode: 'hybrid', idsOnly: true })];
        expect(ids).toContain(winterWindow);
        expect(ids).not.toContain(summerWindow);
        expect(ids).not.toContain(snowOnly);
    });
});
