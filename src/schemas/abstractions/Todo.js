'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/todo';
const DOCUMENT_SCHEMA_VERSION = '2.0';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({
        title: z.string(),
        description: z.string().optional(),
        completed: z.boolean().optional(),
        dueDate: z.string().datetime().optional(),
    }).passthrough(),
    metadata: z.object().optional(),
});

export default class Todo extends Document {
    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        super(options);

        // Customize indexOptions for Todo
        this.indexOptions = {
            ...this.indexOptions,
            ftsSearchFields: ['data.title', 'data.description'],
            vectorEmbeddingFields: ['data.title', 'data.description'],
            checksumFields: ['data.title', 'data.description'],
        };
    }

    /**
     * Create a Todo from minimal data
     * @param {Object} data - Todo data
     * @returns {Todo} New Todo instance
     */
    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Todo(data);
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
            data: {
                title: 'string',
            },
        }
    }

    static validate(document) {
        return baseDocumentSchema.parse(document);
    }

    static validateData(documentData) {
        return documentDataSchema.parse(documentData);
    }
}
