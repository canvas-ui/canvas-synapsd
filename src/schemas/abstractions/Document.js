'use strict';

import BaseDocument, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/document';
const DOCUMENT_SCHEMA_VERSION = '3.0';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({}).passthrough(),
    metadata: z.object({}).passthrough().optional(),
});

export default class Document extends BaseDocument {

    // Index configuration is SCHEMA-level, resolved by BaseDocument from this
    // static. Never stored on the row (see documentSchema).
    static indexOptions = {
        ftsSearchFields: ['data'],
        vectorEmbeddingFields: ['data'],
        checksumFields: ['data'],
    };

    constructor(options = {}) {
        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;

        super(options);
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

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {},
        };
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
