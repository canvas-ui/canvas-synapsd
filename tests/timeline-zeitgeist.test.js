import { describe, expect, test } from '@jest/globals';

import BitmapIndex from '../src/indexes/bitmaps/index.js';
import TimelineIndex from '../src/indexes/inverted/Timeline.js';

class MemoryStore {
    #data = new Map();
    get(key) { return this.#data.get(key); }
    doesExist(key) { return this.#data.has(key); }
    async put(key, value) { this.#data.set(key, value); }
    putSync(key, value) { this.#data.set(key, value); }
    async remove(key) { this.#data.delete(key); }
    async *getKeys({ start = '', end = '￿' } = {}) {
        for (const key of [...this.#data.keys()].sort()) {
            if (key >= start && key <= end) { yield key; }
        }
    }
}

const sorted = (a) => [...a].sort((x, y) => x - y);

describe('TimelineIndex grouped mode (zeitgeist)', () => {
    test('year 600 across multiple timelines and scales → ids per timeline', async () => {
        const t = new TimelineIndex(new BitmapIndex(new MemoryStore()));

        // Historical periods (year scale).
        await t.insert('wikipedia', 1, { start: '500', end: '800' });   // Early Middle Ages — covers 600
        await t.insert('wikipedia', 2, { start: '1500', end: '1600' }); // Renaissance — not 600

        // Rulers/authors who lived in 600 (year scale, some open-ended).
        await t.insert('historian-foo', 10, { start: '590', end: '610' }); // king reigning in 600
        await t.insert('historian-foo', 11, { start: '600', end: Infinity }); // dynasty founded 600, ongoing
        await t.insert('historian-foo', 12, { start: '700', end: '750' }); // later — excluded

        // Geological / climatic eras (deep-time scale, ongoing into the present).
        await t.insert('geology', 100, { start: '2 Myr', end: Infinity }); // Quaternary — still ongoing
        await t.insert('geology', 101, { start: '541 Myr', end: '252 Myr' }); // Paleozoic — long over

        const zeitgeist = await t.queryInterval(
            ['wikipedia', 'historian-foo', 'geology'],
            { start: '600', end: '600' },
            { mode: 'grouped' },
        );

        expect(sorted(zeitgeist.wikipedia)).toEqual([1]);
        expect(sorted(zeitgeist['historian-foo'])).toEqual([10, 11]);
        expect(sorted(zeitgeist.geology)).toEqual([100]); // Quaternary, not Paleozoic
    });

    test('every requested timeline appears, empty as []', async () => {
        const t = new TimelineIndex(new BitmapIndex(new MemoryStore()));
        await t.insert('wikipedia', 1, { start: '500', end: '800' });

        const g = await t.queryInterval(['wikipedia', 'climate'], { start: '600', end: '600' }, { mode: 'grouped' });
        expect(g.wikipedia).toEqual([1]);
        expect(g.climate).toEqual([]);
    });

    test('grouped is the per-timeline union of layers across scales', async () => {
        const t = new TimelineIndex(new BitmapIndex(new MemoryStore()));
        await t.insert('era', 1, { start: '590', end: '610' });       // year scale
        await t.insert('era', 2, { start: '2 Myr', end: Infinity }); // Myr scale, overlaps 600

        const grouped = await t.queryInterval('era', { start: '600', end: '600' }, { mode: 'grouped' });
        expect(sorted(grouped.era)).toEqual([1, 2]); // unions the year + Myr tiers
    });
});
