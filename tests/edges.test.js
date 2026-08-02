import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';

/**
 * EdgeIndex — the dupsort storage primitive, exercised directly on node ids.
 * These tests deliberately do NOT create documents: the graph layer is
 * document-unaware and must work on bare uint32 ids.
 */
describe('EdgeIndex', () => {
    let rootPath;
    let db;
    let edges;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-edges-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
        edges = db.edges;
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('link is idempotent — dupsort dedups the pair', () => {
        edges.link(1, 'includes', 2);
        edges.link(1, 'includes', 2);
        edges.link(1, 'includes', 2);

        expect([...edges.outgoing(1, 'includes')]).toEqual([2]);
        expect(edges.degree(1, 'includes')).toBe(1);
    });

    test('outgoing / incoming iterate in sorted id order', () => {
        for (const to of [30, 10, 20]) { edges.link(1, 'references', to); }
        expect([...edges.outgoing(1, 'references')]).toEqual([10, 20, 30]);

        for (const from of [7, 3, 5]) { edges.link(from, 'mentions', 99); }
        expect([...edges.incoming(99, 'mentions')]).toEqual([3, 5, 7]);
    });

    test('degree is per direction', () => {
        edges.link(1, 'includes', 2);
        edges.link(1, 'includes', 3);
        edges.link(4, 'includes', 2);

        expect(edges.degree(1, 'includes', 'out')).toBe(2);
        expect(edges.degree(1, 'includes', 'in')).toBe(0);
        expect(edges.degree(2, 'includes', 'in')).toBe(2);
    });

    test('pagination via {start} and {limit}', () => {
        for (const to of [10, 20, 30, 40]) { edges.link(1, 'references', to); }

        expect([...edges.outgoing(1, 'references', { limit: 2 })]).toEqual([10, 20]);
        // start seeks into the dup set
        expect([...edges.outgoing(1, 'references', { start: 30 })]).toEqual([30, 40]);
        expect([...edges.outgoing(1, 'references', { start: 20, limit: 2 })]).toEqual([20, 30]);
    });

    test('unlink removes both mirrors and the meta row', () => {
        edges.link(1, 'derived-from', 2, { src: 'extractor:thumbnailer' });
        expect(edges.exists(1, 'derived-from', 2)).toBe(true);
        expect(edges.edge(1, 'derived-from', 2).meta.src).toBe('extractor:thumbnailer');

        edges.unlink(1, 'derived-from', 2);

        expect(edges.exists(1, 'derived-from', 2)).toBe(false);
        expect([...edges.incoming(2, 'derived-from')]).toEqual([]);
        expect(edges.edge(1, 'derived-from', 2)).toBeNull();
    });

    test('linkMany / unlinkMany, including in-batch duplicates', () => {
        const batch = [
            { from: 1, p: 'includes', to: 2 },
            { from: 1, p: 'includes', to: 3 },
            { from: 1, p: 'includes', to: 2 }, // duplicate — free dedup
        ];
        expect(edges.linkMany(batch)).toBe(3);
        expect([...edges.outgoing(1, 'includes')]).toEqual([2, 3]);

        edges.unlinkMany([{ from: 1, p: 'includes', to: 2 }]);
        expect([...edges.outgoing(1, 'includes')]).toEqual([3]);
    });

    test('edge() synthesizes src:doc for asserted edges', () => {
        edges.link(1, 'includes', 2); // asserted — no meta row written

        const edge = edges.edge(1, 'includes', 2);
        expect(edge).toEqual({ from: 1, p: 'includes', to: 2, meta: { src: 'doc' } });
    });

    test('link rejects an explicit src:doc — the convention is absence, not a value', () => {
        expect(() => edges.link(1, 'includes', 2, { src: 'doc' })).toThrow(/implicit/);
    });

    test('deleteNode leaves zero keys mentioning the id in any DBI', () => {
        edges.link(1, 'includes', 2, { src: 'extractor:x' });
        edges.link(1, 'references', 3);
        edges.link(4, 'includes', 1, { src: 'extractor:x' });
        edges.link(5, 'mentions', 1);
        // an unrelated edge that must survive
        edges.link(6, 'includes', 7);

        edges.deleteNode(1);

        expect([...edges.outgoing(1, 'includes')]).toEqual([]);
        expect([...edges.outgoing(1, 'references')]).toEqual([]);
        expect([...edges.incoming(1, 'includes')]).toEqual([]);
        expect([...edges.incoming(1, 'mentions')]).toEqual([]);
        // partners no longer point at it
        expect([...edges.incoming(2, 'includes')]).toEqual([]);
        expect([...edges.outgoing(4, 'includes')]).toEqual([]);
        expect([...edges.outgoing(5, 'mentions')]).toEqual([]);
        // meta rows are gone too
        expect(edges.edge(1, 'includes', 2)).toBeNull();
        expect(edges.edge(4, 'includes', 1)).toBeNull();
        // the unrelated edge survived
        expect([...edges.outgoing(6, 'includes')]).toEqual([7]);
    });

    test('edgesOf reports both directions across predicates', () => {
        edges.link(1, 'includes', 2);
        edges.link(1, 'references', 3);
        edges.link(4, 'mentions', 1);

        const { outgoing, incoming } = edges.edgesOf(1);
        expect(outgoing).toEqual(expect.arrayContaining([
            { p: 'includes', to: 2 },
            { p: 'references', to: 3 },
        ]));
        expect(outgoing).toHaveLength(2);
        expect(incoming).toEqual([{ p: 'mentions', from: 4 }]);
    });

    test('removeEdges removes derived edges and cannot touch asserted ones', () => {
        edges.link(1, 'mentions', 2, { src: 'extractor:ner' });
        edges.link(1, 'mentions', 3, { src: 'extractor:ner' });
        edges.link(1, 'mentions', 4); // asserted — no meta row
        edges.link(5, 'includes', 6, { src: 'extractor:other' });

        const removed = edges.removeEdges({ src: 'extractor:ner' });

        expect(removed).toBe(2);
        expect([...edges.outgoing(1, 'mentions')]).toEqual([4]); // asserted survived
        expect([...edges.outgoing(5, 'includes')]).toEqual([6]); // other src survived
        expect([...edges.incoming(2, 'mentions')]).toEqual([]);  // mirror cleaned
    });

    test('removeEdges can narrow by predicate', () => {
        edges.link(1, 'mentions', 2, { src: 'extractor:ner' });
        edges.link(1, 'references', 3, { src: 'extractor:ner' });

        expect(edges.removeEdges({ src: 'extractor:ner', p: 'mentions' })).toBe(1);
        expect([...edges.outgoing(1, 'references')]).toEqual([3]);
    });

    test('removeEdges refuses src:doc and an empty selector', () => {
        expect(() => edges.removeEdges({ src: 'doc' })).toThrow(/cannot target src:"doc"/);
        expect(() => edges.removeEdges({})).toThrow(/requires at least one selector/);
    });

    test('clear drops the whole edge plane', () => {
        edges.link(1, 'includes', 2, { src: 'extractor:x' });
        edges.link(3, 'mentions', 4);

        edges.clear();

        expect([...edges.outgoing(1, 'includes')]).toEqual([]);
        expect([...edges.incoming(4, 'mentions')]).toEqual([]);
        expect(edges.edge(1, 'includes', 2)).toBeNull();
    });

    test('unknown predicates are rejected', () => {
        expect(() => edges.link(1, 'attachment-of', 2)).toThrow(/Unknown predicate/);
        expect(() => edges.link(1, '', 2)).toThrow(/non-empty string/);
    });

    test('inverse-style names throw rather than resolving to the forward predicate', () => {
        // The whole point: resolving these would erase direction at the callsite
        // and produce a silently-wrong forward scan.
        for (const name of ['mentioned-by', 'included-by', 'referenced-by', 'derives']) {
            expect(() => edges.link(1, name, 2)).toThrow(/Direction is an axis/);
        }
    });

    test('invalid node ids are rejected', () => {
        expect(() => edges.link(0, 'includes', 2)).toThrow(/Invalid document id/);
        expect(() => edges.link(1, 'includes', -3)).toThrow(/Invalid document id/);
        expect(() => edges.link(1.5, 'includes', 2)).toThrow(/Invalid document id/);
    });
});
