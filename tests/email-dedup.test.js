import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Db from '../src/index.js';
import Email from '../src/schemas/abstractions/Email.js';

// A minimal mailparser-shaped object.
function parsed({ messageId, subject = 'Quarterly report', from = 'alice@example.com', text = 'see attached', date = new Date('2024-01-01T00:00:00Z') }) {
    return {
        headers: new Map([['subject', subject]]),
        subject,
        text,
        html: undefined,
        from: { value: [{ address: from, name: 'Alice' }] },
        to: { value: [{ address: 'bob@example.com' }] },
        date,
        messageId,
        attachments: [],
    };
}

// Email dedup must collapse the same message regardless of volatile per-fetch
// state (uid, flags, receivedAt) — checksum keys on stable identity, not the
// whole data object.
describe('Email ingestion dedup', () => {
    let rootPath;
    let db;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsd-email-'));
        db = new Db({ path: rootPath, backupOnOpen: false, backupOnClose: false });
        await db.start();
    });

    afterEach(async () => {
        if (db) { await db.shutdown().catch(() => {}); db = null; }
        if (rootPath) { await fs.rm(rootPath, { recursive: true, force: true }); rootPath = null; }
    });

    test('same Message-ID re-ingested with different uid/flags/receivedAt dedups to one doc', async () => {
        const e1 = Email.fromIMAP(parsed({ messageId: '<m1@example.com>' }), { uid: 1, flags: ['\\Seen'] });
        const e2 = Email.fromIMAP(parsed({ messageId: '<m1@example.com>' }), { uid: 99, flags: [] });

        expect(e1.getPrimaryChecksum()).toBe(e2.getPrimaryChecksum());
        // receivedAt differs (volatile) but must NOT affect the checksum
        expect(e1.data.receivedAt).not.toBe(undefined);

        const [id1] = await db.putMany([e1]);
        const [id2] = await db.putMany([e2]);
        expect(id2).toBe(id1);

        const all = await db.list({ features: { allOf: ['data/abstraction/email'] }, limit: 0 });
        expect(all.length).toBe(1);
    });

    test('different Message-IDs stay distinct', async () => {
        const e1 = Email.fromIMAP(parsed({ messageId: '<m1@example.com>' }), { uid: 1 });
        const e2 = Email.fromIMAP(parsed({ messageId: '<m2@example.com>' }), { uid: 2 });
        const [id1] = await db.putMany([e1]);
        const [id2] = await db.putMany([e2]);
        expect(id2).not.toBe(id1);
    });

    test('cross-protocol: Graph internetMessageId dedups against the IMAP copy', async () => {
        const imap = Email.fromIMAP(parsed({ messageId: '<m1@example.com>' }), { uid: 1 });
        const [id1] = await db.putMany([imap]);

        const graph = Email.fromGraph({
            subject: 'Quarterly report',
            from: { emailAddress: { address: 'alice@example.com', name: 'Alice A.' } }, // name differs
            toRecipients: [{ emailAddress: { address: 'bob@example.com' } }],
            receivedDateTime: '2024-02-02T00:00:00Z', // different fetch time
            internetMessageId: '<m1@example.com>',
            body: { contentType: 'html', content: '<p>see attached</p>' }, // different body encoding
        });

        expect(graph.getPrimaryChecksum()).toBe(imap.getPrimaryChecksum());
        const [idg] = await db.putMany([graph]);
        expect(idg).toBe(id1);
    });

    test('missing Message-ID falls back to a deterministic synthetic id (no Date.now)', async () => {
        const a1 = Email.fromIMAP(parsed({ messageId: undefined }), {});
        const a2 = Email.fromIMAP(parsed({ messageId: undefined }), {});
        expect(a1.data.messageId).toBe(a2.data.messageId);
        expect(a1.data.messageId.startsWith('imap-synthetic-')).toBe(true);

        const [id1] = await db.putMany([a1]);
        const [id2] = await db.putMany([a2]);
        expect(id2).toBe(id1);
    });
});
