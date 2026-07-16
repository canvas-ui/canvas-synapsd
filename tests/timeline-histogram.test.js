import { describe, expect, test } from '@jest/globals';
import { createRequire } from 'module';

import BitmapIndex from '../src/indexes/bitmaps/index.js';
import TimelineIndex from '../src/indexes/inverted/Timeline.js';

const require = createRequire(import.meta.url);
const { RoaringBitmap32 } = require('roaring');

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

function newTimeline() {
    return new TimelineIndex(new BitmapIndex(new MemoryStore()));
}

describe('TimelineIndex histogram', () => {
    test('counts documents per bucket, order preserved', async () => {
        const t = newTimeline();
        await t.insert('wikipedia', 1, { start: '1912', end: '1912' });
        await t.insert('wikipedia', 2, { start: '1914', end: '1918' });
        await t.insert('wikipedia', 3, { start: '1915', end: '1915' });

        const buckets = await t.histogram('wikipedia', [
            { start: '1900', end: '1909' },
            { start: '1910', end: '1919' },
            { start: '1920', end: '1929' },
        ]);

        expect(buckets).toHaveLength(3);
        expect(buckets[0].total).toBe(0);
        expect(buckets[1].counts).toEqual({ wikipedia: 3 });
        expect(buckets[1].total).toBe(3);
        expect(buckets[2].total).toBe(0);
    });

    test('an interval spanning buckets counts in every overlapped bucket', async () => {
        const t = newTimeline();
        await t.insert('era', 1, { start: '1895', end: '1905' });

        const buckets = await t.histogram('era', [
            { start: '1890', end: '1899' },
            { start: '1900', end: '1909' },
            { start: '1910', end: '1919' },
        ]);

        expect(buckets[0].counts).toEqual({ era: 1 });
        expect(buckets[1].counts).toEqual({ era: 1 });
        expect(buckets[2].total).toBe(0);
    });

    test('multiple timelines report independent counts per bucket', async () => {
        const t = newTimeline();
        await t.insert('wikipedia', 1, { start: '1969', end: '1969' });
        await t.insert('wikipedia', 2, { start: '1969', end: '1969' });
        await t.insert('crud:created', 3, new Date('1969-07-20T00:00:00Z'));

        const buckets = await t.histogram(['wikipedia', 'crud:created'], [
            { start: '1969-01-01', end: '1969-12-31' },
        ]);

        expect(buckets[0].counts).toEqual({ wikipedia: 2, 'crud:created': 1 });
        expect(buckets[0].total).toBe(3);
    });

    test('filter bitmap intersects each bucket count', async () => {
        const t = newTimeline();
        await t.insert('notes', 1, { start: '2020-01-05', end: '2020-01-05' });
        await t.insert('notes', 2, { start: '2020-01-06', end: '2020-01-06' });
        await t.insert('notes', 3, { start: '2020-02-01', end: '2020-02-01' });

        const candidates = new RoaringBitmap32([1, 3]);
        const buckets = await t.histogram('notes', [
            { start: '2020-01-01', end: '2020-01-31' },
            { start: '2020-02-01', end: '2020-02-29' },
        ], candidates);

        expect(buckets[0].counts).toEqual({ notes: 1 });
        expect(buckets[1].counts).toEqual({ notes: 1 });
    });

    test('unknown timeline and malformed buckets yield empty counts, not errors', async () => {
        const t = newTimeline();
        await t.insert('known', 1, { start: '2020', end: '2020' });

        const buckets = await t.histogram(['known', 'ghost'], [
            { start: '2020', end: '2020' },
            { start: 'not-a-date', end: 'also-bad' },
        ]);

        expect(buckets[0].counts).toEqual({ known: 1 });
        expect(buckets[1].counts).toEqual({});
        expect(buckets[1].total).toBe(0);
    });
});
