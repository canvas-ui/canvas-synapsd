'use strict';

import Document, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';
const DOCUMENT_SCHEMA_NAME = 'data/abstraction/directory'; // Dir/BUcket
const DOCUMENT_SCHEMA_VERSION = '2.0';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    // Draft/placeholder implementation
    data: z.object({
        name: z.string(),
        path: z.string(),
        content: z.array(z.any()),
    }).passthrough(),
    metadata: z.object().optional()
});

export default class Directory extends Document {
    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        super(options);

        // Customize indexOptions for Directory
        this.indexOptions = {
            ...this.indexOptions,
            ftsSearchFields: ['data.name', 'data.path'],
            vectorEmbeddingFields: ['data.name', 'data.path'],
            checksumFields: ['data.name', 'data.path', 'data.deviceId']
        };
    }

    /**
     * Create a Directory from minimal data
     * @param {Object} data - Directory data
     * @returns {Directory} New Directory instance
     */
    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Directory(data);
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