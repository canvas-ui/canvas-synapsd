'use strict';

import Document, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/email';
const DOCUMENT_SCHEMA_VERSION = '2.0';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    // Draft/placeholder implementation
    data: z.object({
        subject: z.string(),
        from: z.string().email(),
        to: z.array(z.string().email()),
        cc: z.array(z.string().email()).optional(),
        bcc: z.array(z.string().email()).optional(),
        body: z.string(),
        htmlBody: z.string().optional(),
        attachments: z.array(z.any()).optional(),
        receivedAt: z.string().datetime(),
        deviceId: z.string(),
    }).passthrough(),
    metadata: z.object().optional()
});

export default class Email extends Document {
    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        super(options);

        // Customize indexOptions for Email
        this.indexOptions = {
            ...this.indexOptions,
            ftsSearchFields: ['data.subject', 'data.body', 'data.from', 'data.to'],
            vectorEmbeddingFields: ['data.subject', 'data.body'],
            checksumFields: ['data.subject', 'data.from', 'data.to', 'data.receivedAt']
        };
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

    static get dataSchema() {
        return documentDataSchema;
    }

    static get schema() {
        return documentSchema;
    }

    static validate(document) {
        return documentSchema.parse(document);
    }

    static validateData(documentData) {
        return documentDataSchema.parse(documentData);
    }
}