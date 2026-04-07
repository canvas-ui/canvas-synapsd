'use strict';

import Document, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/device';
const DOCUMENT_SCHEMA_VERSION = '1.1';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({
        deviceId: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        platform: z.string().optional(),
        arch: z.string().optional(),
        type: z.string().optional(),
        // Identity fields for human-friendly URL addressing
        username: z.string().optional(),
        hostname: z.string().optional(),
        fqdn: z.string().optional(),      // fully-qualified domain name when available
        alias: z.string().optional(),     // user@hostname — authority component for file:// URLs
        createdAt: z.string().optional(),
        lastSeen: z.string().optional(),
    }).passthrough(),
    metadata: z.object().optional(),
});

export default class Device extends Document {
    constructor(options = {}) {
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        options.indexOptions = {
            ...(options.indexOptions || {}),
            ftsSearchFields: ['data.name', 'data.deviceId', 'data.alias', 'data.hostname', 'data.description'],
            vectorEmbeddingFields: ['data.name', 'data.alias'],
            checksumFields: ['data.deviceId'],
        };

        super(options);
    }

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Device(data);
    }

    static get dataSchema() {
        return documentDataSchema;
    }

    static get schema() {
        return documentSchema;
    }

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                deviceId: 'string',
                name: 'string',
                description: 'string',
                platform: 'string',
                arch: 'string',
                type: 'string',
                username: 'string',
                hostname: 'string',
                fqdn: 'string',
                alias: 'string',
                createdAt: 'string',
                lastSeen: 'string',
            },
        };
    }

    static validate(document) {
        return documentSchema.parse(document);
    }

    static validateData(documentData) {
        return documentDataSchema.parse(documentData);
    }
}

