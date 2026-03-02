'use strict';

import BaseDocument, { documentSchema as baseDocumentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/folder';
const DOCUMENT_SCHEMA_VERSION = '1.0';

const folderDataSchema = BaseDocument.extendDataSchema(
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

export default class Folder extends BaseDocument {

    constructor(options = {}) {
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;
        options.indexOptions = {
            ...defaultIndexOptions,
            ...(options.indexOptions || {}),
        };
        super(options);
    }

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Folder(data);
    }

    static get dataSchema() { return folderDataSchema; }
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
    static validateData(documentData) { return folderDataSchema.parse(documentData); }

    validateData() { return folderDataSchema.parse(this.data); }
}
