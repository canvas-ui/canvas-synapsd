import { describe, expect, test } from '@jest/globals';

import BitmapIndex from '../src/indexes/bitmaps/index.js';
import TimelineIndex from '../src/indexes/inverted/Timeline.js';

// Minimal in-memory dataset (mirrors canvas-tree-semantics.test.js).
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

function newIndex(options = {}) {
    const store = new MemoryStore();
    const bitmapIndex = new BitmapIndex(store);
    return { bitmapIndex, timeline: new TimelineIndex(bitmapIndex, options) };
}

// crud stamps are wall-clock instants; use second-scale Dates.
const at = (iso) => new Date(iso);

describe('TimelineIndex point-event (instant) timelines', () => {
    test('crud:* is point-mode: single ts BSI, no start/end tier', async () => {
        const { bitmapIndex, timeline } = newIndex();
        await timeline.insert('crud:created', 1, at('2026-06-01T10:00:00Z'));

        // Point tier writes internal/ts/crud_x3a_created/second/ts/* — never start/end.
        const keys = await bitmapIndex.listBitmaps('internal/ts');
        expect(keys.some(k => k.includes('/ts/'))).toBe(true);
        expect(keys.some(k => k.includes('/start/') || k.includes('/end/'))).toBe(false);
    });

    test('range query matches instants inside [start, end] and excludes outside', async () => {
        const { timeline } = newIndex();
        await timeline.insert('crud:created', 10, at('2026-06-10T00:00:00Z'));
        await timeline.insert('crud:created', 20, at('2026-06-20T00:00:00Z'));
        await timeline.insert('crud:created', 30, at('2026-07-05T00:00:00Z'));

        // June only.
        const june = await timeline.queryInterval('crud:created',
            { start: at('2026-06-01T00:00:00Z'), end: at('2026-06-30T23:59:59Z') });
        expect(june.sort((a, b) => a - b)).toEqual([10, 20]);

        // A single-day window around the 20th.
        const day = await timeline.queryInterval('crud:created',
            { start: at('2026-06-20T00:00:00Z'), end: at('2026-06-20T23:59:59Z') });
        expect(day).toEqual([20]);
    });

    test('getCount and remove work on point timelines', async () => {
        const { timeline } = newIndex();
        await timeline.insert('crud:updated', 1, at('2026-06-01T00:00:00Z'));
        await timeline.insert('crud:updated', 2, at('2026-06-02T00:00:00Z'));
        expect(await timeline.getCount('crud:updated')).toBe(2);

        await timeline.remove('crud:updated', 1);
        expect(await timeline.getCount('crud:updated')).toBe(1);

        const hit = await timeline.queryInterval('crud:updated',
            { start: at('2026-06-01T00:00:00Z'), end: at('2026-06-30T00:00:00Z') });
        expect(hit).toEqual([2]);
    });

    test('explicitly registered names are point-mode too', async () => {
        const { bitmapIndex, timeline } = newIndex({ pointTimelines: ['visited'] });
        await timeline.insert('visited', 7, at('2026-06-15T12:00:00Z'));
        const keys = await bitmapIndex.listBitmaps('internal/ts');
        expect(keys.some(k => k.includes('/ts/'))).toBe(true);
        expect(keys.some(k => k.includes('/start/'))).toBe(false);
    });

    test('interval timelines remain dual-BSI and overlap-query correctly', async () => {
        const { bitmapIndex, timeline } = newIndex();
        // A real interval (era spanning years).
        await timeline.insert('era', 1, { start: '2000', end: '2010' });
        await timeline.insert('era', 2, { start: '2015', end: '2020' });

        const keys = await bitmapIndex.listBitmaps('internal/ts');
        expect(keys.some(k => k.includes('/start/'))).toBe(true);
        expect(keys.some(k => k.includes('/end/'))).toBe(true);

        // Overlaps 2005–2017 → both eras.
        const overlap = await timeline.queryInterval('era', { start: '2005', end: '2017' });
        expect(overlap.sort((a, b) => a - b)).toEqual([1, 2]);

        // Overlaps only the first era.
        const first = await timeline.queryInterval('era', { start: '2001', end: '2003' });
        expect(first).toEqual([1]);
    });
});
