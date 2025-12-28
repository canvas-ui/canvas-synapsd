'use strict';

import Document, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/device';
const DOCUMENT_SCHEMA_VERSION = '1.0';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({
        id: z.string().min(1), // deviceId (UUID)
        name: z.string().min(1),
        platform: z.string().optional(),
        arch: z.string().optional(),
        type: z.string().optional(),
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
            ftsSearchFields: ['data.name', 'data.id'],
            vectorEmbeddingFields: ['data.name'],
            checksumFields: ['data.id'],
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
                id: 'string',
                name: 'string',
                platform: 'string',
                arch: 'string',
                type: 'string',
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

