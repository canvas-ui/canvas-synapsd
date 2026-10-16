import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import Email from '../src/schemas/core/Email.js';
import Message from '../src/schemas/core/Message.js';
import { predicateId } from '../src/indexes/edges/predicates.js';

const EMAIL = 'data/schema/message/email';

function parsed({ messageId, date }) {
    return {
        headers: new Map([['subject', 'hello']]),
        subject: 'hello',
        text: 'body',
        from: { value: [{ address: 'alice@example.com', name: 'Alice' }] },
        to: { value: [{ address: 'bob@example.com' }] },
        date,
        messageId,
        attachments: [],
    };
}

// "All mail sent this year" is a filter on the built-in 'content' timeline:
// a message's content time is its Date header, not when it was indexed.
describe('email/message content timeline + contact edges', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-content-tl-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('an email lands on the content timeline at its Date header', async () => {
        const email = Email.fromIMAP(parsed({ messageId: '<c1@example.com>', date: new Date('2024-03-10T09:00:00Z') }), { uid: 1 });
        expect(email.timelines).toEqual([{ timeline: 'content', start: '2024-03-10T09:00:00.000Z' }]);
        const [id] = await db.putMany([email]);

        const in2024 = await db.list({ features: [EMAIL], filters: ['t:content:2024-01-01..2024-12-31'], limit: 0 });
        const in2025 = await db.list({ features: [EMAIL], filters: ['t:content:2025-01-01..2025-12-31'], limit: 0 });
        expect(in2024.map((d) => d.id)).toEqual([id]);
        expect(in2025.map((d) => d.id)).toEqual([]);
    });

    test('the derived entry replaces a stale content entry and keeps other timelines', () => {
        const email = new Email({
            data: { subject: 's', body: 'b', from: 'a@example.com', to: [], date: '2023-05-01T00:00:00.000Z' },
            timelines: [{ timeline: 'content', start: '1999-01-01' }, { timeline: 'project', start: '2023-01-01' }],
        });
        expect(email.timelines).toEqual([
            { timeline: 'project', start: '2023-01-01' },
            { timeline: 'content', start: '2023-05-01T00:00:00.000Z' },
        ]);
    });

    test('chat messages derive content time from their timestamp', () => {
        const message = new Message({
            data: { text: 'hi', sender: { id: 'U1' }, timestamp: '2026-02-03T04:05:06.000Z' },
        });
        expect(message.timelines).toEqual([{ timeline: 'content', start: '2026-02-03T04:05:06.000Z' }]);
    });

    test.each([
        [{ headers: { Date: 'Sun, 10 Mar 2024 10:00:00 +0100' }, date: '2026-10-16T00:00:00Z' }, '2024-03-10T09:00:00.000Z'],
        [{ headers: { date: 'invalid' }, date: 'invalid', receivedAt: '2023-04-01T12:00:00Z' }, '2023-04-01T12:00:00.000Z'],
        [{ sentAt: '2022-04-01T12:00:00Z', receivedAt: '2023-04-01T12:00:00Z' }, '2022-04-01T12:00:00.000Z'],
        [{ date: '2021-04-01T12:00:00Z' }, '2021-04-01T12:00:00.000Z'],
    ])('content time uses source dates from legacy index objects: %j', (data, start) => {
        const email = new Email({ data, createdAt: '2026-10-16T12:00:00Z' });
        expect(email.timelines).toEqual([{ timeline: 'content', start }]);
    });

    test('IMAP receipt uses INTERNALDATE and never the time of import', () => {
        const input = parsed({ date: new Date('2020-01-01T00:00:00Z') });
        const email = Email.fromIMAP(input, { uid: 1, internalDate: new Date('2020-01-02T00:00:00Z') });
        expect(email.data.receivedAt).toBe('2020-01-02T00:00:00.000Z');
        expect(email.data.sentAt).toBe('2020-01-01T00:00:00.000Z');
        expect(email.timelines[0].start).toBe(email.data.sentAt);

        input.date = new Date('invalid');
        const receiptOnly = Email.fromIMAP(input, { uid: 1, internalDate: '2020-01-02T00:00:00Z' });
        expect(receiptOnly.timelines[0].start).toBe('2020-01-02T00:00:00.000Z');
        expect(receiptOnly.data.date).toBe(receiptOnly.data.receivedAt);
        const unknown = Email.fromIMAP(input, { uid: 1 });
        expect(unknown.timelines).toEqual([]);
        expect(unknown.data.date).toBeUndefined();
        expect(unknown.data.receivedAt).toBeUndefined();
        expect(Email.fromIMAP(input, { uid: 1 }).getPrimaryChecksum()).toBe(unknown.getPrimaryChecksum());
    });

    test('Graph content time is sent time, with receipt as a fallback', () => {
        const email = Email.fromGraph({ id: 'g1', sentDateTime: '2020-01-01T00:00:00Z', receivedDateTime: '2020-01-02T00:00:00Z' });
        expect(email.timelines[0].start).toBe('2020-01-01T00:00:00.000Z');
        expect(email.data.receivedAt).toBe('2020-01-02T00:00:00.000Z');
        expect(Email.fromGraph({ id: 'g2' }).timelines).toEqual([]);
    });

    test('repair replaces indexed import dates, sorts before pagination and leaves CRUD unchanged', async () => {
        const ids = [];
        for (const [i, data] of [
            { headers: { date: 'Tue, 01 Jul 2025 00:00:00 +0000' } },
            { receivedAt: '2023-01-01T00:00:00Z' },
            { sentAt: '2024-01-01T00:00:00Z' },
        ].entries()) {
            const email = Email.fromIMAP(parsed({ messageId: `<repair-${i}@example.com>`, date: new Date('2026-10-16T00:00:00Z') }));
            const id = await db.put(email);
            const row = await db.documents.get(id);
            // Simulate legacy rows with a wrong, already-indexed content date.
            await db.documents.put(id, { ...row, data: { ...row.data, date: undefined, sentAt: undefined, ...data } });
            ids.push(id);
        }
        const before = await db.documents.getMany(ids);
        const result = await db.rederiveSchemaTimelines({ schemas: [EMAIL], batchSize: 2 });
        expect(result).toMatchObject({ matched: 3, updated: 3 });
        expect((await db.list({ features: [EMAIL], sortBy: 'content', order: 'asc', limit: 2 })).map(d => d.id)).toEqual([ids[1], ids[2]]);
        expect((await db.list({ features: [EMAIL], sortBy: 'content', order: 'desc', limit: 2, offset: 1 })).map(d => d.id)).toEqual([ids[2], ids[1]]);
        expect(await db.list({ features: [EMAIL], filters: ['t:content:2026-01-01..2026-12-31'], limit: 0 })).toHaveLength(0);
        for (const row of before) {
            const repaired = await db.documents.get(row.id);
            expect(repaired.createdAt).toBe(row.createdAt);
            expect(repaired.updatedAt).toBe(row.updatedAt);
            expect(repaired.checksumArray).toEqual(row.checksumArray);
        }
        expect(await db.rederiveSchemaTimelines({ schemas: [EMAIL] })).toMatchObject({ updated: 0 });
    });

    test('rederiveSchemaTimelines backfills rows stored before the derivation, once', async () => {
        const email = Email.fromIMAP(parsed({ messageId: '<c2@example.com>', date: new Date('2022-07-01T00:00:00Z') }), { uid: 2 });
        const [id] = await db.putMany([email]);
        // A row as written by an older version: no timelines on it.
        const stored = await db.documents.get(id);
        await db.documents.put(id, { ...stored, timelines: [] });

        const first = await db.rederiveSchemaTimelines({ schemas: ['data/schema/message'] });
        expect(first).toMatchObject({ matched: 1, updated: 1 });
        const row = await db.documents.get(id);
        expect(row.timelines).toEqual([{ timeline: 'content', start: '2022-07-01T00:00:00.000Z' }]);
        expect(row.version).toBe(stored.version + 1);
        const in2022 = await db.list({ features: [EMAIL], filters: ['t:content:2022-01-01..2022-12-31'], limit: 0 });
        expect(in2022.map((d) => d.id)).toEqual([id]);

        const second = await db.rederiveSchemaTimelines({ schemas: ['data/schema/message'] });
        expect(second).toMatchObject({ matched: 1, updated: 0 });
        await expect(db.rederiveSchemaTimelines({})).rejects.toThrow(/schema prefixes/);
    });

    test('relateMany writes derived addressed-to / authored-by edges in one call', async () => {
        expect(predicateId('addressed-to')).toBe(9);
        expect(() => predicateId('addressed-by')).toThrow(/Inverse/);
        const email = Email.fromIMAP(parsed({ messageId: '<c3@example.com>', date: new Date('2026-01-01T00:00:00Z') }), { uid: 3 });
        const [mail, alice, bob] = await db.putMany([
            email,
            { schema: 'data/schema/identity', data: { displayName: 'Alice' } },
            { schema: 'data/schema/identity', data: { displayName: 'Bob' } },
        ]);
        const written = await db.relateMany([
            { from: mail, p: 'authored-by', to: alice },
            { from: mail, p: 'addressed-to', to: bob },
        ], { meta: { src: 'extractor:email-contacts' } });
        expect(written).toBe(2);
        expect([...db.edges.incoming(alice, 'authored-by')]).toEqual([mail]);
        expect([...db.edges.incoming(bob, 'addressed-to')]).toEqual([mail]);
        await expect(db.relateMany([{ from: mail, p: 'references', to: bob }])).rejects.toThrow(/meta.src/);
    });
});

describe('identity email alias keys', () => {
    test('every email address on an identity is resolvable by its alias key', async () => {
        const { default: Identity } = await import('../src/schemas/core/Identity.js');
        const identity = new Identity({
            schema: 'data/schema/identity/person',
            data: {
                displayName: 'Alice',
                primaryEmail: 'Alice@Example.com',
                channels: [{ kind: 'email', value: 'alice@work.example' }, { kind: 'phone', value: '+1' }],
            },
        });
        const keys = identity.checksumArray;
        expect(keys[0]).not.toMatch(/^identity-email\//);
        expect(keys).toContain(Identity.emailAliasKey('alice@example.com'));
        expect(keys).toContain(Identity.emailAliasKey(' ALICE@WORK.EXAMPLE '));
        expect(keys.filter((k) => k.startsWith('identity-email/'))).toHaveLength(2);
        expect(Identity.emailAliasKey('undisclosed-recipients:;')).toBeNull();
    });
});
