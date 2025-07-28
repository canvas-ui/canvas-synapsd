'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/file';
const DOCUMENT_SCHEMA_VERSION = '2.1';

const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    // Draft/placeholder implementation
    data: z.object({
        name: z.string(),
        path: z.string(),
        mimeType: z.string().optional(),
        size: z.number().optional(),
        lastModified: z.string().datetime().optional(),
    }).passthrough(),
    metadata: z.object().optional(),
    checksumArray: z.array(z.string()),
});

// Schema for the full File document, making checksumArray mandatory
const fileDocumentSchema = baseDocumentSchema.extend({
    checksumArray: z.array(z.string()).nonempty({ message: "checksumArray cannot be empty and must be provided for File documents" }),
});

export default class File extends Document {
    constructor(options = {}) {
        // Ensure checksumArray is provided and non-empty before calling super
        if (!options.checksumArray || !Array.isArray(options.checksumArray) || options.checksumArray.length === 0) {
            throw new Error('File documents require a non-empty, pre-computed checksumArray in the options object.');
        }

        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        // Inject File-specific index options BEFORE super()
        options.indexOptions = {
            ...options.indexOptions,
            ftsSearchFields: ['data.name', 'data.path'],
            vectorEmbeddingFields: ['data.name', 'data.path'],
            // File relies on external checksumArray, so we don't modify checksumFields here
        };

        super(options);
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
        return fileDocumentSchema;
    }

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                name: 'string',
                path: 'string',
            },
            metadata: {},
            checksumArray: [],
        }
    }

    static validate(document) {
        return fileDocumentSchema.parse(document);
    }

    static validateData(documentData) {
        return documentDataSchema.parse(documentData);
    }
}
