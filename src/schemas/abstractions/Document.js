'use strict';

import BaseDocument, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/document';
const DOCUMENT_SCHEMA_VERSION = '2.0';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object().passthrough(),
    metadata: z.object().optional(),
});

export default class Document extends BaseDocument {
    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        super(options);

        // Customize indexOptions for JSON Document
        this.indexOptions = {
            ...this.indexOptions,
            ftsSearchFields: ['data'],
            vectorEmbeddingFields: ['data'],
            checksumFields: ['data'],
        };
    }

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Document(data);
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
