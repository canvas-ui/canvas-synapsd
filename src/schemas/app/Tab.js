'use strict';

import Document, { documentSchema } from '../Document.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/schema/tab';
const DOCUMENT_SCHEMA_VERSION = '3.0';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({
        url: z.string().url(),
        title: z.string().optional(),
    }).passthrough(),
    metadata: z.object({}).passthrough().optional(),
});

export default class Tab extends Document {

    // Index configuration is SCHEMA-level, resolved by Document from this
    // static. Never stored on the row (see documentSchema).
    static indexOptions = {
        ftsSearchFields: ['data.title', 'data.url'],
        vectorEmbeddingFields: ['data.title', 'data.url'],
        checksumFields: ['data.url'],
    };

    constructor(options = {}) {
        // Set schema defaults before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;

        super(options);
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
