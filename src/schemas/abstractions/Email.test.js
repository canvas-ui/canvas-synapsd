import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Email from './Email.js';

describe('Email', () => {
    test('normalizes IMAP references string to array', () => {
        const email = Email.fromIMAP({
            subject: 'Hello',
            text: 'Body',
            from: { value: [{ address: 'from@example.com' }] },
            to: { value: [{ address: 'to@example.com' }] },
            date: new Date('2026-05-07T10:00:00.000Z'),
            messageId: '<message@example.com>',
            references: '<one@example.com> <two@example.com>',
        }, { uid: 1 });

        assert.deepEqual(email.data.references, ['<one@example.com>', '<two@example.com>']);
        assert.doesNotThrow(() => email.validateData());
    });
});
