'use strict';

import BaseDocument, { documentSchema as baseDocumentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/bucket';
const DOCUMENT_SCHEMA_VERSION = '1.0';

const bucketDataSchema = BaseDocument.extendDataSchema(
    z.object({
        name: z.string().min(1),
        path: z.string().optional(),
        backend: z.string().optional(),
        description: z.string().optional(),
    }).passthrough(),
);

const defaultIndexOptions = {
    ftsSearchFields: ['data.name', 'data.description', 'data.path'],
    vectorEmbeddingFields: ['data.name', 'data.description'],
    checksumFields: ['data.name', 'data.path'],
};

export default class Bucket extends BaseDocument {

    constructor(options = {}) {
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;
        options.indexOptions = {
            ...defaultIndexOptions,
            ...(options.indexOptions || {}),
        };
        super(options);
    }

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Bucket(data);
    }

    static get dataSchema() { return bucketDataSchema; }
    static get schema() { return baseDocumentSchema; }

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                name: 'string',
                path: 'string',
                backend: 'string',
                description: 'string',
            },
        };
    }

    static validate(document) { return baseDocumentSchema.parse(document); }
    static validateData(documentData) { return bucketDataSchema.parse(documentData); }

    validateData() { return bucketDataSchema.parse(this.data); }
}
