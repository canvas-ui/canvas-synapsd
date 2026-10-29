import { test, expect } from '@jest/globals';
import { createRequire } from 'node:module';
import QueryEngine from '../src/query/QueryEngine.js';
import { parseSpec } from '../src/utils/spec.js';
const { RoaringBitmap32 } = createRequire(import.meta.url)('roaring');

test('countOnly uses cardinality without enumerating IDs or fetching documents', async () => {
    const engine = new QueryEngine({ documents: { getCount: async () => 9 } });
    // Deliberately no iterator, toArray(), or document-fetch implementation.
    const count = await engine.rank({ size: 123 }, null, { countOnly: true });
    expect(count).toHaveLength(0);
    expect(count.totalCount).toBe(123);
    expect((await engine.rank(null, null, { countOnly: true })).totalCount).toBe(9);
    expect(parseSpec({ options: { countOnly: true }, countOnly: false }).options.countOnly).toBe(false);
});

test('compound base and per-line specs remain independent operands, resolved once', async () => {
    const calls = [];
    const engine = new QueryEngine({
        documents: { getMany: () => { throw new Error('count and ids must not hydrate'); } },
        candidates: {
            resolveParsed: async spec => {
                calls.push(spec);
                const ids = spec.ids ?? (spec.features.anyOf.includes('tag/base') ? [1, 2] : [2, 3]);
                return { bitmap: new RoaringBitmap32(ids) };
            },
        },
    });
    const lines = [{ features: ['tag/line'] }, { ids: [] }];
    const options = { baseSpec: { features: ['tag/base'] }, countOnly: true };
    const result = await engine.searchCompound(lines, options);
    expect(result.totalCount).toBe(1);
    expect(result.lines).toEqual([{ count: 1 }, { count: 0 }]);
    expect(calls).toHaveLength(3);
    expect(calls[0].features.anyOf).toEqual(['tag/base']);
    expect(calls[1].features.anyOf).toEqual(['tag/line']);
    expect((await engine.searchCompound(lines, { ...options, op: 'and' })).totalCount).toBe(0);
    const ids = await engine.searchCompound([lines[0]], { baseSpec: options.baseSpec, idsOnly: true });
    expect([...ids]).toEqual([2]);
});

test('ranked reads honor raw, ID-only and count-only materialization options', async () => {
    const raw = { id: 7, schema: 'data/schema/note', data: { title: 'raw', content: 'raw' } };
    let fetched = 0;
    const engine = new QueryEngine({
        documents: { getMany: async () => { fetched++; return [raw]; } },
        getLanceIndex: () => ({ isReady: true, ftsQuery: async () => ({ pageIds: [7], totalCount: 12, error: null }) }),
    });
    expect((await engine.rank(null, 'invoice', { mode: 'fts', parse: false }))[0]).toBe(raw);
    const ids = await engine.rank(null, 'invoice', { mode: 'fts', idsOnly: true });
    expect([...ids]).toEqual([7]);
    const count = await engine.rank(null, 'invoice', { mode: 'fts', countOnly: true });
    expect(count).toHaveLength(0);
    expect(count.totalCount).toBe(12);
    expect(fetched).toBe(1);
});
