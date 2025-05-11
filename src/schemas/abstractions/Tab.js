'use strict';

import Document, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/tab';
const DOCUMENT_SCHEMA_VERSION = '2.0';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({
        url: z.string().url(),
        title: z.string().optional(),
    }).passthrough(),
    metadata: z.object().optional(),
});

export default class Tab extends Document {
    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        super(options);

        // Customize indexOptions for Tab
        this.indexOptions = {
            ...this.indexOptions,
            ftsSearchFields: ['data.title', 'data.url'],
            vectorEmbeddingFields: ['data.title', 'data.url'],
            checksumFields: ['data.url'],
        };
    }

    /**
     * Create a Tab from minimal data
     * @param {Object} data - Tab data
     * @returns {Tab} New Tab instance
     */
    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Tab(data);
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
                url: 'string',
                title: 'string',
            }
        }
    }

    validate() {
        super.validate();
    }

    static validate(document) {
        return documentSchema.parse(document);
    }

    validateData() {
        super.validateData();
    }

    static validateData(documentData) {
        return documentDataSchema.parse(documentData);
    }
}
