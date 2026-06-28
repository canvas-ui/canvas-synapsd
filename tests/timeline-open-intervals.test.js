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

function newTimeline() {
    return new TimelineIndex(new BitmapIndex(new MemoryStore()));
}

describe('TimelineIndex open intervals', () => {
    test('ongoing interval (born 1912, still alive) matches any later range', async () => {
        const t = newTimeline();
        await t.insert('life', 1, { start: '1912-12-12', end: Infinity });

        // Alive in 2026 and 1950, but not 1900 (before birth).
        expect(await t.queryInterval('life', { start: '2026', end: '2026' })).toEqual([1]);
        expect(await t.queryInterval('life', { start: '1950', end: '1950' })).toEqual([1]);
        expect(await t.queryInterval('life', { start: '1900', end: '1900' })).toEqual([]);
    });

    test('accepts string open markers (ongoing / present / inf / ∞)', async () => {
        for (const marker of ['ongoing', 'present', 'inf', '+inf', '∞']) {
            const t = newTimeline();
            await t.insert('svc', 1, { start: '2020', end: marker });
            expect(await t.queryInterval('svc', { start: '2030', end: '2030' })).toEqual([1]);
        }
    });

    test('open-start interval (-∞, end] matches any earlier range', async () => {
        const t = newTimeline();
        await t.insert('until', 1, { start: -Infinity, end: '2000' });
        expect(await t.queryInterval('until', { start: '1500', end: '1500' })).toEqual([1]);
        expect(await t.queryInterval('until', { start: '2001', end: '2001' })).toEqual([]);
    });

    test('bounded intervals are unaffected', async () => {
        const t = newTimeline();
        await t.insert('reign', 1, { start: '1990', end: '2000' });
        expect(await t.queryInterval('reign', { start: '1995', end: '1995' })).toEqual([1]);
        expect(await t.queryInterval('reign', { start: '2005', end: '2005' })).toEqual([]);
    });

    test('null/omitted query bounds are open: (start) → from start, (null, end) → until end', async () => {
        const t = newTimeline();
        await t.insert('era', 1, { start: '1990', end: '1995' });
        await t.insert('era', 2, { start: '2005', end: '2010' });
        await t.insert('era', 3, { start: '2020', end: '2025' });

        // (timeline, start) → [start, +∞): eras ending at/after 2005.
        expect((await t.queryInterval('era', '2000')).sort((a, b) => a - b)).toEqual([2, 3]);
        // (timeline, null, end) → (-∞, end]: eras starting at/before 2007.
        expect((await t.queryInterval('era', null, '2007')).sort((a, b) => a - b)).toEqual([1, 2]);
        // explicit point still bounded: only the era covering 2008.
        expect(await t.queryInterval('era', '2008', '2008')).toEqual([2]);
    });

    test('insert omitted-end stays an instant (crud not turned into open interval)', async () => {
        const t = newTimeline();
        await t.insert('crud:created', 1, new Date('2026-06-01T00:00:00Z')); // omitted end
        // Instant in June, not an open [June, ∞): a January window must NOT match.
        expect(await t.queryInterval('crud:created',
            { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-31T00:00:00Z') })).toEqual([]);
        expect(await t.queryInterval('crud:created',
            { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-06-30T00:00:00Z') })).toEqual([1]);
    });

    test('two ongoing lives, query "alive in 2026" returns both', async () => {
        const t = newTimeline();
        await t.insert('life', 1, { start: '1912-12-12', end: Infinity });
        await t.insert('life', 2, { start: '1990-01-01', end: Infinity });
        await t.insert('life', 3, { start: '1800-01-01', end: '1850-01-01' }); // died long ago
        expect((await t.queryInterval('life', { start: '2026', end: '2026' })).sort((a, b) => a - b)).toEqual([1, 2]);
    });
});
