'use strict';

import Document, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/file';
const DOCUMENT_SCHEMA_VERSION = '2.0';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    // Draft/placeholder implementation
    data: z.object({
        name: z.string(),
        path: z.string(),
        mimeType: z.string(),
        size: z.number(),
        lastModified: z.string().datetime().optional(),
    }).passthrough(),
    metadata: z.object().optional(),
});

export default class File extends Document {
    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        super(options);

        // Customize indexOptions for File
        this.indexOptions = {
            ...this.indexOptions,
            ftsSearchFields: ['data.name', 'data.path'],
            vectorEmbeddingFields: ['data.name', 'data.path', 'data.mimeType'],
            checksumFields: ['data.name', 'data.path', 'data.size', 'data.lastModified', 'data.deviceId'],
        };
    }

    /**
     * Create a File from minimal data
     * @param {Object} data - File data
     * @returns {File} New File instance
     */
    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new File(data);
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