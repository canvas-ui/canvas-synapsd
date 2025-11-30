'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/email';
const DOCUMENT_SCHEMA_VERSION = '3.0';

const emailAddressSchema = z.object({
    address: z.string().email(),
    name: z.string().optional(),
});

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({
        // Core email fields
        subject: z.string(),
        body: z.string(),
        bodyHtml: z.string().optional(),
        bodyPreview: z.string().optional(),

        // Sender and recipients
        from: z.union([
            z.string().email(),
            emailAddressSchema,
        ]),
        to: z.array(z.union([
            z.string().email(),
            emailAddressSchema,
        ])),
        cc: z.array(z.union([
            z.string().email(),
            emailAddressSchema,
        ])).optional(),
        bcc: z.array(z.union([
            z.string().email(),
            emailAddressSchema,
        ])).optional(),
        replyTo: z.array(z.union([
            z.string().email(),
            emailAddressSchema,
        ])).optional(),

        // Timestamps
        date: z.string().datetime(),
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

export default class Email extends Document {
    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        // Inject Email-specific index options BEFORE super() so checksum uses correct fields
        options.indexOptions = {
            ...(options.indexOptions || {}),
            ftsSearchFields: ['data.subject', 'data.body', 'data.from.address', 'data.from', 'data.to'],
            vectorEmbeddingFields: ['data.subject', 'data.body'],
            checksumFields: ['data.messageId', 'data.from', 'data.subject', 'data.date'],
        };

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
     * @param {Object} imapMetadata - IMAP-specific metadata (uid, seqno, flags)
     * @returns {Email} New Email instance
     */
    static fromIMAP(parsed, imapMetadata = {}) {
        return new Email({
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                subject: parsed.subject || '(no subject)',
                body: parsed.text || '',
                bodyHtml: parsed.html || undefined,
                bodyPreview: parsed.textAsHtml ? undefined : (parsed.text?.substring(0, 200) || ''),
                from: parsed.from?.text || parsed.from?.value?.[0]?.address || '',
                to: parsed.to?.value?.map(addr => ({ address: addr.address, name: addr.name })) || [],
                cc: parsed.cc?.value?.map(addr => ({ address: addr.address, name: addr.name })) || undefined,
                bcc: parsed.bcc?.value?.map(addr => ({ address: addr.address, name: addr.name })) || undefined,
                replyTo: parsed.replyTo?.value?.map(addr => ({ address: addr.address, name: addr.name })) || undefined,
                date: parsed.date?.toISOString() || new Date().toISOString(),
                receivedAt: new Date().toISOString(),
                messageId: parsed.messageId || `imap-${imapMetadata.uid || Date.now()}`,
                inReplyTo: parsed.inReplyTo,
                references: parsed.references,
                attachments: parsed.attachments?.map(att => ({
                    filename: att.filename,
                    contentType: att.contentType,
                    size: att.size,
                    contentId: att.contentId,
                    isInline: att.contentDisposition === 'inline',
                    checksum: att.checksum,
                })),
                headers: parsed.headers ? Object.fromEntries(parsed.headers) : undefined,
                platform: 'imap',
                platformMetadata: {
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
                date: graphMessage.receivedDateTime || new Date().toISOString(),
                receivedAt: graphMessage.receivedDateTime,
                sentAt: graphMessage.sentDateTime,
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

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {},
        };
    }

    static validate(document) {
        return baseDocumentSchema.parse(document);
    }

    static validateData(documentData) {
        return documentDataSchema.parse(documentData);
    }
}
