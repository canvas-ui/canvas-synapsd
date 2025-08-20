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
    metadata: z.object().optional(),
});

export default class Note extends Document {
    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        // Inject Note-specific index options BEFORE super()
        options.indexOptions = {
            ...options.indexOptions,
            ftsSearchFields: ['data.title', 'data.content'],
            vectorEmbeddingFields: ['data.title', 'data.content'],
            checksumFields: ['data.title', 'data.content'],
        };

        super(options);

        if (!this.data.title) {
            // If Note has no title, we'll use YYYYMMDD, subject to change
            const now = new Date();
            const year = now.getFullYear();
            const month = (now.getMonth() + 1).toString().padStart(2, '0');
            const day = now.getDate().toString().padStart(2, '0');
            this.data.title = `${year}${month}${day}`;
        }
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

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                title: 'string',
                content: 'string',
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
