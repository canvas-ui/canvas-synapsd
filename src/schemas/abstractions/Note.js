'use strict';

import Document, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/note';
const DOCUMENT_SCHEMA_VERSION = '2.0';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({
        title: z.string().optional(),
        content: z.string(),
    }).passthrough(),
    metadata: z.object().optional()
});

export default class Note extends Document {
    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        super(options);

        // Customize indexOptions for Note
        this.indexOptions = {
            ...this.indexOptions,
            ftsSearchFields: ['data.title', 'data.content'],
            vectorEmbeddingFields: ['data.title', 'data.content'],
            checksumFields: ['data.title', 'data.content']
        };
    }

    /**
     * Create a Note from minimal data
     * @param {Object} data - Note data
     * @returns {Note} New Note instance
     */
    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Note(data);
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