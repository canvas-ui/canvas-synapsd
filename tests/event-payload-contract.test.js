import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import { DOCUMENT_EVENT_REASONS, ENVELOPE_INPUT_KEYS, createEvent } from '../src/utils/events.js';

const note = (title, content) => ({ schema: 'data/schema/note', data: { title, content } });

/**
 * The payload CONTRACT of document events, as opposed to the fact that they
 * fire at all (tests/events.test.js) or that they carry provenance
 * (tests/event-provenance.test.js).
 *
 * This exists because the contract used to live only in consumers' heads: a
 * `document.updated` from a re-link carries no document, one from an edit does,
 * and nothing anywhere said so. Automation that classified the document matched
 * on insert and silently never matched on a re-link. `reason` makes the
 * distinction explicit — and a discriminator nothing asserts is a discriminator
 * that quietly stops being emitted the next time an emit site is edited.
 *
 * Each case states, for one operation: which events it emits, what each one's
 * `reason` is, and whether it carries the document.
 */
describe('document event payload contract', () => {
    let rootPath;
    let db;
    let seen;

    // Every document.* event, in emission order, with the two fields the
    // contract is about.
    const record = () => {
        seen = [];
        db.on('document.**', function (evt) {
            seen.push({
                event: this.event,
                reason: evt.reason,
                hasDocument: Boolean(evt.document),
                payload: evt,
            });
        });
    };
    const only = (eventName) => seen.filter((e) => e.event === eventName);

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-contract-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false, semantic: { enabled: false } });
        await db.start();
        record();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    // ── The invariant that would have caught the original bug ───────────────

    test('EVERY document event carries a reason from the closed set', async () => {
        const id = await db.put(note('Contract', 'v1'), { context: { path: '/inbox' } });
        await db.put({ id, schema: 'data/schema/note', data: { title: 'Contract', content: 'v2' } });
        await db.link(id, { context: { path: '/filed' } });
        await db.unlink(id, { context: { path: '/filed' } });
        await db.delete(id);

        expect(seen.length).toBeGreaterThan(0);
        const offenders = seen.filter((e) => !DOCUMENT_EVENT_REASONS.includes(e.reason));
        expect(offenders.map((e) => `${e.event}:${e.reason}`)).toEqual([]);
    });

    // ── Per-operation contracts ─────────────────────────────────────────────

    test('put() of a new document: reason created, document carried', async () => {
        await db.put(note('New', 'body'), { context: { path: '/inbox' } });

        const inserted = only('document.inserted');
        expect(inserted).toHaveLength(1);
        expect(inserted[0].reason).toBe('created');
        expect(inserted[0].hasDocument).toBe(true);
    });

    test('put() over an existing id: reason content, document carried', async () => {
        const id = await db.put(note('Edit me', 'v1'), { context: { path: '/inbox' } });
        seen = [];

        await db.put({ id, schema: 'data/schema/note', data: { title: 'Edit me', content: 'v2' } });

        const updated = only('document.updated').filter((e) => e.reason === 'content');
        expect(updated.length).toBeGreaterThan(0);
        // The content form is the one that carries the document — that is the
        // whole distinction consumers depend on.
        expect(updated.every((e) => e.hasDocument || e.payload.batch === true)).toBe(true);
    });

    test('link(): membership-only update carries NO document, document.linked does', async () => {
        const id = await db.put(note('Filed', 'body'), { context: { path: '/inbox' } });
        seen = [];

        await db.link(id, { context: { path: '/filed' } });

        const updated = only('document.updated');
        expect(updated).toHaveLength(1);
        expect(updated[0].reason).toBe('membership');
        expect(updated[0].hasDocument).toBe(false);
        // `changed` is the CHANGED placement, not the full one: the doc is in
        // /inbox AND /filed here, but only /filed is reported.
        expect(updated[0].payload.changed).toEqual({ context: ['/filed'], directory: [], features: [] });
        // Deprecated alias, unchanged in shape (raw selector) for one release.
        expect(updated[0].payload.memberships?.context?.path).toBe('/filed');

        const linked = only('document.linked');
        expect(linked).toHaveLength(1);
        expect(linked[0].reason).toBe('membership');
        expect(linked[0].hasDocument).toBe(true);
        expect(linked[0].payload.changed.context).toEqual(['/filed']);
    });

    test('unlink(): membership-only removal carries NO document, document.unlinked does', async () => {
        const id = await db.put(note('Unfile', 'body'), { context: { path: '/inbox' } });
        await db.link(id, { context: { path: '/filed' } });
        seen = [];

        await db.unlink(id, { context: { path: '/filed' } });

        const removed = only('document.removed');
        expect(removed).toHaveLength(1);
        expect(removed[0].reason).toBe('membership');
        expect(removed[0].hasDocument).toBe(false);
        // Both sides of the membership family speak the same delta shape —
        // PATHS, so one consumer branch handles link and unlink alike.
        expect(removed[0].payload.changed).toEqual({ context: ['/filed'], directory: [], features: [] });
        // The deprecated alias used to hold unticked LAYER NAMES ('filed')
        // despite its own name and the removedContextPaths variable behind it
        // both saying paths — a consumer reading it literally matched nothing,
        // silently. It now aliases changed.context.
        expect(removed[0].payload.contextArray).toEqual(['/filed']);

        const unlinked = only('document.unlinked');
        expect(unlinked).toHaveLength(1);
        expect(unlinked[0].reason).toBe('membership');
        // Unlink drops memberships only — the document still exists, so the
        // first-class event can carry it.
        expect(unlinked[0].hasDocument).toBe(true);
    });

    test('delete(): reason deleted', async () => {
        const id = await db.put(note('Doomed', 'body'), { context: { path: '/inbox' } });
        seen = [];

        await db.delete(id);

        const deleted = only('document.deleted');
        expect(deleted).toHaveLength(1);
        expect(deleted[0].reason).toBe('deleted');
    });

    // ── Batch is an ORTHOGONAL axis to reason ───────────────────────────────

    test('putMany() of new documents: batch events carry reason created', async () => {
        await db.putMany([note('A', 'a'), note('B', 'b')], { context: { path: '/bulk' } });

        const batch = only('document.inserted.batch');
        expect(batch).toHaveLength(1);
        expect(batch[0].reason).toBe('created');
        expect(batch[0].payload.ids).toHaveLength(2);

        // The singular compat emission describes the same change: same reason,
        // different shape (ids + batch:true, no document).
        const compat = only('document.inserted').filter((e) => e.payload.batch === true);
        expect(compat).toHaveLength(1);
        expect(compat[0].reason).toBe('created');
        expect(compat[0].hasDocument).toBe(false);
    });

    test('putMany() over existing ids: batch events carry reason content', async () => {
        const ids = await db.putMany([note('C', 'v1'), note('D', 'v1')], { context: { path: '/bulk' } });
        seen = [];

        await db.putMany(ids.map((id) => ({ id, schema: 'data/schema/note', data: { title: 'C', content: 'v2' } })));

        const batch = only('document.updated.batch');
        expect(batch).toHaveLength(1);
        expect(batch[0].reason).toBe('content');
    });

    // ── The membership family covers bulk ops too ───────────────────────────
    //
    // It did not, until 2026-08-18: linkMany/unlinkMany emitted ONLY the
    // deprecated membership-only aliases, so a rule bound to document.linked
    // fired when you filed one document and silently never when you
    // multi-selected. That asymmetry is also what blocked retiring the alias.

    test('linkMany() of one document: singular document.linked WITH the document', async () => {
        const id = await db.put(note('Bulk one', 'body'), { context: { path: '/inbox' } });
        seen = [];

        await db.linkMany([id], { context: { path: '/filed' } });

        const linked = only('document.linked');
        expect(linked).toHaveLength(1);
        expect(linked[0].hasDocument).toBe(true);
        expect(linked[0].reason).toBe('membership');
        expect(linked[0].payload.changed.context).toEqual(['/filed']);
        expect(only('document.linked.batch')).toHaveLength(0);
    });

    test('linkMany() of several: document.linked.batch, ids only', async () => {
        const ids = await db.putMany([note('G', 'g'), note('H', 'h')], { context: { path: '/inbox' } });
        seen = [];

        await db.linkMany(ids, { context: { path: '/filed' } });

        const batch = only('document.linked.batch');
        expect(batch).toHaveLength(1);
        expect(batch[0].reason).toBe('membership');
        expect(batch[0].hasDocument).toBe(false);
        expect(batch[0].payload.ids).toHaveLength(2);
        expect(batch[0].payload.count).toBe(2);
        expect(batch[0].payload.changed.context).toEqual(['/filed']);
    });

    test('unlinkMany(): singular carries the document, batch carries ids', async () => {
        const ids = await db.putMany([note('I', 'i'), note('J', 'j')], { context: { path: '/inbox' } });
        await db.linkMany(ids, { context: { path: '/filed' } });
        seen = [];

        await db.unlinkMany([ids[0]], { context: { path: '/filed' } });
        const single = only('document.unlinked');
        expect(single).toHaveLength(1);
        expect(single[0].hasDocument).toBe(true);
        expect(single[0].payload.changed.context).toEqual(['/filed']);

        seen = [];
        await db.unlinkMany(ids, { context: { path: '/inbox' } });
        const batch = only('document.unlinked.batch');
        expect(batch).toHaveLength(1);
        expect(batch[0].payload.ids).toHaveLength(2);
        expect(batch[0].reason).toBe('membership');
    });

    test('recursive unlink reports every prefix path it dropped', async () => {
        const id = await db.put(note('Deep', 'body'), { context: { path: '/a/b/c' } });
        seen = [];

        // `recursive` rides on the spec — there is no separate options param.
        await db.unlink(id, { context: { path: '/a/b/c' }, recursive: true });

        const removed = only('document.removed');
        expect(removed[0].payload.changed.context).toEqual(['/a', '/a/b', '/a/b/c']);
    });

    test('reason and batch are independent: a batch event is not a reason', async () => {
        await db.putMany([note('E', 'e'), note('F', 'f')], { context: { path: '/bulk' } });
        const batched = seen.filter((e) => e.payload.batch === true || e.event.endsWith('.batch'));

        expect(batched.length).toBeGreaterThan(0);
        // 'batch' must never leak into the reason vocabulary — payload SHAPE and
        // WHAT CHANGED are two axes, and collapsing them is exactly the
        // ambiguity this contract removes.
        expect(batched.every((e) => DOCUMENT_EVENT_REASONS.includes(e.reason))).toBe(true);
        expect(batched.every((e) => e.reason !== 'batch')).toBe(true);
    });
});

/**
 * The envelope's own contract. `createEvent` spreads `...detail` over a fixed
 * set of top-level keys, which is the right default (foreign schemas inherit
 * their fields for free) but makes two collisions invisible: a key the
 * envelope OWNS is dropped, and a malformed envelope INPUT falls back to its
 * default. The second one matters most for `depth` — a cascade guard reading
 * depth 0 forever is a loop that never terminates.
 */
describe('event envelope reserved keys', () => {
    test('detail.event is rejected rather than silently ignored', () => {
        expect(() => createEvent('document.inserted', { event: 'something.else', id: 1 }))
            .toThrow(/owned by the envelope/);
    });

    test('malformed envelope inputs are rejected, not defaulted', () => {
        expect(() => createEvent('document.inserted', { id: 1, depth: '2' })).toThrow(/depth/);
        expect(() => createEvent('document.inserted', { id: 1, depth: -1 })).toThrow(/depth/);
        expect(() => createEvent('document.inserted', { id: 1, origin: 42 })).toThrow(/origin/);
        expect(() => createEvent('document.inserted', { id: 1, causedBy: 7 })).toThrow(/causedBy/);
    });

    test('legitimate envelope inputs still pass through', () => {
        const evt = createEvent('document.inserted', {
            id: 1, origin: 'rule', causedBy: 'abc', depth: 2, source: 'tree',
        });
        expect(evt.origin).toBe('rule');
        expect(evt.causedBy).toBe('abc');
        expect(evt.depth).toBe(2);
        expect(evt.source).toBe('tree');
        expect(evt.event).toBe('document.inserted');
    });

    test('every envelope input key is documented as one', () => {
        const evt = createEvent('document.inserted', { id: 1 });
        for (const key of ENVELOPE_INPUT_KEYS) { expect(key in evt).toBe(true); }
    });
});
