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
