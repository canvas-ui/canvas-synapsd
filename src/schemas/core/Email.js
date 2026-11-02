'use strict';

import Document, { documentSchema as baseDocumentSchema, withDerivedContentTimeline } from '../Document.js';
import { generateChecksum } from '../../utils/crypto.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/schema/message/email';
const DOCUMENT_SCHEMA_VERSION = '3.2';
// Boolean mailbox flags, NOT subtypes — under `feature/` (a derived prefix), never
// under the schema id: since the hierarchy ticks ancestor segments (Rev B), a key
// like `data/schema/message/email/sent` would be indistinguishable from a subtype
// of email. Moved out of the identity axis 2026-08-05.
const EMAIL_FEATURE_BITMAPS = {
    sent: 'feature/email/sent',
    received: 'feature/email/received',
    attachment: 'feature/email/attachment',
    flagged: 'feature/email/flagged',
};
const DEFAULT_EMAIL_SUBJECT = '(no subject)';

// Addresses as they arrive from the wild: a strict RFC check rejected whole
// IMAP batches over one header like `undisclosed-recipients:;` or a bare local
// part, and a message with an odd sender is still a message worth keeping.
const emailAddressString = z.string().trim().min(1);
const emailAddressSchema = z.object({
    address: emailAddressString,
    name: z.string().optional(),
});

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({
        // Core email fields
        subject: z.string(),
        // Blob-backed messages keep only a preview here; legacy/API-created
        // messages may still carry inline content until it has been persisted.
        body: z.string().optional(),
        bodyHtml: z.string().optional(),
        bodyPreview: z.string().optional(),

        // Sender and recipients
        from: z.union([
            emailAddressString,
            emailAddressSchema,
        ]),
        to: z.array(z.union([
            emailAddressString,
            emailAddressSchema,
        ])),
        cc: z.array(z.union([
            emailAddressString,
            emailAddressSchema,
        ])).optional(),
        bcc: z.array(z.union([
            emailAddressString,
            emailAddressSchema,
        ])).optional(),
        replyTo: z.array(z.union([
            emailAddressString,
            emailAddressSchema,
        ])).optional(),

        // Timestamps
        date: z.string().datetime().optional(),
        receivedAt: z.string().datetime().optional(),
        sentAt: z.string().datetime().optional(),

        // Message identifiers
        messageId: z.string(),
        inReplyTo: z.string().optional(),
        references: z.array(z.string()).optional(),

        // Thread information
        threadId: z.string().optional(),
        conversationId: z.string().optional(),

        // Flags and status
        isRead: z.boolean().optional(),
        isFlagged: z.boolean().optional(),
        isDraft: z.boolean().optional(),
        importance: z.enum(['low', 'normal', 'high']).optional(),

        // Attachments
        attachments: z.array(z.object({
            filename: z.string(),
            contentType: z.string().optional(),
            size: z.number().optional(),
            contentId: z.string().optional(),
            isInline: z.boolean().optional(),
            // Canonical fetchable location (stored://<backend>/<key>) + content hash.
            // Replaces the former ad-hoc `storageRef` blob.
            url: z.string().optional(),
            checksum: z.string().optional(),
        })).optional(),

        // Headers
        headers: z.record(z.string()).optional(),

        // Categories/Labels
        categories: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),

        // Platform information
        platform: z.enum(['imap', 'graph', 'o365', 'gmail', 'exchange', 'other']).optional(),

        // Folder/Mailbox information
        folder: z.object({
            id: z.string().optional(),
            name: z.string().optional(),
            path: z.string().optional(),
        }).optional(),

        // Platform-specific metadata
        platformMetadata: z.object({
            // IMAP specific
            uid: z.number().optional(),
            seqno: z.number().optional(),
            flags: z.array(z.string()).optional(),

            // Graph/O365 specific
            graphId: z.string().optional(),
            webLink: z.string().optional(),
            changeKey: z.string().optional(),

            // Provider specific
            provider: z.string().optional(),
            accountId: z.string().optional(),
        }).passthrough().optional(),

    }).passthrough(),
    metadata: z.object({
        source: z.string().optional(),
        workspaceId: z.string().optional(),
        imported: z.boolean().optional(),
        synced: z.boolean().optional(),
    }).passthrough().optional(),
});

function firstDate(...values) {
    for (const value of values) {
        if (!(value instanceof Date) && (typeof value !== 'string' || !value.trim())) { continue; }
        const date = new Date(value);
        if (Number.isFinite(date.getTime())) { return date.toISOString(); }
    }
    return undefined;
}

function headerDate(headers) {
    const entries = headers instanceof Map ? [...headers] : Object.entries(headers || {});
    return firstDate(...entries.filter(([key]) => key.toLowerCase() === 'date').flatMap(([, value]) => value));
}

function contentDate(data = {}) {
    // Prefer source evidence over the legacy importer fallback in data.date.
    // Receipt is a fallback for mail without a usable sent date; CRUD dates
    // describe the index row and must never become a message's content time.
    return firstDate(data.sentAt, headerDate(data.headers), data.date,
        data.platformMetadata?.internalDate, data.receivedAt);
}

function normalizeEmailAddress(address) {
    // Whatever the header carried, trimmed — a bare local part or a group
    // like `undisclosed-recipients:;` is kept as-is (the schema no longer
    // insists on RFC form); only an empty address is dropped.
    const value = String(address?.address ?? '').trim();
    if (!value) {
        return undefined;
    }

    return {
        address: value,
        ...(address.name ? { name: String(address.name) } : {}),
    };
}

function normalizeEmailAddressList(list) {
    return list?.value?.map(normalizeEmailAddress).filter(Boolean);
}

function normalizeReferences(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry || '').trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        const matches = value.match(/<[^>]+>/g);
        const refs = matches?.length ? matches : value.split(/\s+/);
        return refs.map((entry) => entry.trim()).filter(Boolean);
    }
    return undefined;
}

function formatEmailAddress(address) {
    const email = String(address?.address || '').trim();
    const name = String(address?.name || '').trim();

    if (!email) {
        return name || undefined;
    }

    return name && name !== email ? `${name} <${email}>` : email;
}

function normalizeHeaderParams(params) {
    const entries = params instanceof Map
        ? Array.from(params.entries())
        : Object.entries(params || {});
    const parts = [];

    for (const [key, value] of entries) {
        const normalized = normalizeHeaderValue(value);
        if (normalized) {
            parts.push(`${key}=${normalized}`);
        }
    }

    return parts.length ? parts.join('; ') : undefined;
}

function normalizeHeaderValue(value) {
    if (value == null) {
        return undefined;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }

    if (value instanceof Date) { return firstDate(value); }

    if (Buffer.isBuffer(value)) {
        return value.toString('utf8');
    }

    if (Array.isArray(value)) {
        const items = value.map(normalizeHeaderValue).filter(Boolean);
        return items.length ? items.join(', ') : undefined;
    }

    if (value instanceof Map) {
        const items = Array.from(value.entries())
            .map(([key, entryValue]) => {
                const normalized = normalizeHeaderValue(entryValue);
                return normalized ? `${key}=${normalized}` : null;
            })
            .filter(Boolean);
        return items.length ? items.join('; ') : undefined;
    }

    if (typeof value === 'object') {
        if (typeof value.text === 'string' && value.text.trim()) {
            return value.text.trim();
        }

        if (value.address || value.name) {
            return formatEmailAddress(value);
        }

        if (Array.isArray(value.value)) {
            const items = value.value.map(normalizeHeaderValue).filter(Boolean);
            if (items.length) {
                return items.join(', ');
            }
        }

        if (typeof value.value === 'string' && value.value.trim()) {
            const params = normalizeHeaderParams(value.params);
            return params ? `${value.value}; ${params}` : value.value;
        }

        const params = normalizeHeaderParams(value.params || value);
        if (params) {
            return params;
        }
    }

    return undefined;
}

export default class Email extends Document {

    // Index configuration is SCHEMA-level, resolved by Document from this
    // static. Never stored on the row (see documentSchema).
    static indexOptions = {
        // Attachment names and types are indexed so "invoice", "pdf" or an
        // invoice number in a filename finds the mail. Not the url/checksum:
        // hex and stored:// keys are ngram noise. Existing rows pick this up on
        // the next search-index rebuild (Maintenance → rebuild search index).
        ftsSearchFields: ['data.subject', 'data.bodyPreview', 'data.body', 'data.from.address', 'data.from', 'data.to', 'data.attachments.filename', 'data.attachments.contentType'],
        vectorEmbeddingFields: ['data.subject', 'data.bodyPreview', 'data.body'],
        checksumFields: ['data.messageId', 'data.from.address', 'data.subject'],
    };

    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;
        // Content time = when the message was sent (receipt as fallback), on the
        // built-in 'content' timeline — "all mail from this year" filters on it.
        options.timelines = withDerivedContentTimeline(options.timelines, contentDate(options.data));

        super(options);
    }

    /**
     * Create an Email from minimal data
     * @param {Object} data - Email data
     * @returns {Email} New Email instance
     */
    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Email(data);
    }

    /**
     * Create an Email from IMAP data
     * @param {Object} parsed - Parsed email from mailparser
     * @param {Object} imapMetadata - IMAP metadata (uid, seqno, flags, internalDate).
     *   Pass `checksumArray` (e.g. ['sha1/<hash-of-raw-.eml>']) to content-address
     *   on the raw blob; omit it to fall back to the parsed-data hash.
     * @returns {Email} New Email instance
     */
    static fromIMAP(parsed, imapMetadata = {}) {
        const headers = parsed.headers
            ? Object.fromEntries(
                Array.from(parsed.headers.entries())
                    .map(([key, value]) => [key, normalizeHeaderValue(value)])
                    .filter(([, value]) => Boolean(value)),
            )
            : undefined;
        const subject = String(parsed.subject || '').trim() || DEFAULT_EMAIL_SUBJECT;
        const bodyPreview = String(parsed.text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200);
        const sentAt = firstDate(parsed.date, headerDate(parsed.headers));
        const receivedAt = firstDate(imapMetadata.internalDate, imapMetadata.receivedAt);

        // Deterministic identity: the RFC Message-ID when present, else a stable
        // synthetic derived from the mailbox uid or content. NEVER Date.now() —
        // a volatile id would poison the checksum and fork dupes on re-ingest.
        const fromAddress = parsed.from?.value?.[0]?.address || 'unknown@localhost';
        const messageId = parsed.messageId
            || (imapMetadata.uid != null
                ? `imap-uid-${imapMetadata.uid}`
                : `imap-synthetic-${generateChecksum(`${fromAddress}|${subject}|${sentAt || ''}`)}`);

        return new Email({
            schema: DOCUMENT_SCHEMA_NAME,
            // Honour a raw-blob checksum from the ingest layer when provided.
            checksumArray: imapMetadata.checksumArray,
            data: {
                title: subject,
                name: subject,
                subject,
                body: parsed.text || '',
                bodyHtml: parsed.html || undefined,
                bodyPreview: bodyPreview || undefined,
                from: normalizeEmailAddress(parsed.from?.value?.[0]) || 'unknown@localhost',
                to: normalizeEmailAddressList(parsed.to) || [],
                cc: normalizeEmailAddressList(parsed.cc) || undefined,
                bcc: normalizeEmailAddressList(parsed.bcc) || undefined,
                replyTo: normalizeEmailAddressList(parsed.replyTo) || undefined,
                date: sentAt || receivedAt,
                sentAt,
                receivedAt,
                messageId,
                inReplyTo: parsed.inReplyTo,
                references: normalizeReferences(parsed.references),
                attachments: parsed.attachments?.map(att => ({
                    filename: att.filename,
                    contentType: att.contentType,
                    size: att.size,
                    contentId: att.contentId,
                    isInline: att.contentDisposition === 'inline',
                    checksum: att.checksum,
                })),
                headers,
                platform: 'imap',
                platformMetadata: {
                    internalDate: receivedAt,
                    uid: imapMetadata.uid,
                    seqno: imapMetadata.seqno,
                    flags: imapMetadata.flags,
                    provider: imapMetadata.provider,
                    accountId: imapMetadata.accountId,
                },
            },
        });
    }

    /**
     * Create an Email from Microsoft Graph data
     * @param {Object} graphMessage - Message from Graph API
     * @returns {Email} New Email instance
     */
    static fromGraph(graphMessage) {
        return new Email({
            schema: DOCUMENT_SCHEMA_NAME,
            // Honour a raw-blob checksum from the ingest layer when provided;
            // Graph typically has no MIME source, so this usually falls back to
            // the parsed-data hash.
            checksumArray: graphMessage.checksumArray,
            data: {
                subject: graphMessage.subject || '(no subject)',
                body: graphMessage.bodyPreview || graphMessage.body?.content || '',
                bodyHtml: graphMessage.body?.contentType === 'html' ? graphMessage.body.content : undefined,
                bodyPreview: graphMessage.bodyPreview,
                from: {
                    address: graphMessage.from?.emailAddress?.address || '',
                    name: graphMessage.from?.emailAddress?.name,
                },
                to: graphMessage.toRecipients?.map(r => ({
                    address: r.emailAddress.address,
                    name: r.emailAddress.name,
                })) || [],
                cc: graphMessage.ccRecipients?.map(r => ({
                    address: r.emailAddress.address,
                    name: r.emailAddress.name,
                })) || undefined,
                bcc: graphMessage.bccRecipients?.map(r => ({
                    address: r.emailAddress.address,
                    name: r.emailAddress.name,
                })) || undefined,
                replyTo: graphMessage.replyTo?.map(r => ({
                    address: r.emailAddress.address,
                    name: r.emailAddress.name,
                })) || undefined,
                date: firstDate(graphMessage.sentDateTime, graphMessage.receivedDateTime),
                receivedAt: firstDate(graphMessage.receivedDateTime),
                sentAt: firstDate(graphMessage.sentDateTime),
                messageId: graphMessage.internetMessageId || graphMessage.id,
                conversationId: graphMessage.conversationId,
                isRead: graphMessage.isRead,
                isFlagged: graphMessage.flag?.flagStatus === 'flagged',
                isDraft: graphMessage.isDraft,
                importance: graphMessage.importance,
                attachments: graphMessage.attachments?.map(att => ({
                    filename: att.name,
                    contentType: att.contentType,
                    size: att.size,
                    isInline: att.isInline,
                })),
                categories: graphMessage.categories,
                platform: 'graph',
                folder: {
                    id: graphMessage.parentFolderId,
                },
                platformMetadata: {
                    graphId: graphMessage.id,
                    webLink: graphMessage.webLink,
                    changeKey: graphMessage.changeKey,
                },
            },
        });
    }

    static get dataSchema() {
        return documentDataSchema;
    }

    static get schema() {
        return baseDocumentSchema;
    }

    static validate(document) {
        return baseDocumentSchema.parse(document);
    }

    static validateData(documentData) {
        return documentDataSchema.parse(documentData);
    }

    static getFeatureBitmapArray(emailDocument, options = {}) {
        const data = emailDocument?.data || emailDocument || {};
        const folderPath = String(options.mailboxPath || data.folder?.path || data.folder?.name || '').toLowerCase();
        const flags = Array.isArray(data.platformMetadata?.flags) ? data.platformMetadata.flags : [];
        const features = [];

        const isSentMailbox = /(^|[^a-z])sent([^a-z]|$)/i.test(folderPath);
        features.push(isSentMailbox ? EMAIL_FEATURE_BITMAPS.sent : EMAIL_FEATURE_BITMAPS.received);

        if (Array.isArray(data.attachments) && data.attachments.length > 0) {
            features.push(EMAIL_FEATURE_BITMAPS.attachment);
        }

        if (
            data.isFlagged === true ||
            flags.some((flag) => String(flag).toLowerCase().includes('flagged'))
        ) {
            features.push(EMAIL_FEATURE_BITMAPS.flagged);
        }

        return Array.from(new Set(features));
    }
}
