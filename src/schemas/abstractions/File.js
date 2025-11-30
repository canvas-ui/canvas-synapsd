'use strict';

import BaseDocument, { documentSchema as baseDocumentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/file';
const DOCUMENT_SCHEMA_VERSION = '2.3';

// File-specific data schema
const fileDataSchema = z.object({
    filename: z.string(),
    size: z.number().int().nonnegative().optional(),
    mime: z.string().optional(),
}).passthrough();

// Schema for the full File document, making checksumArray mandatory
const fileDocumentSchema = baseDocumentSchema.extend({
    checksumArray: z.array(z.string()).nonempty({ message: 'checksumArray cannot be empty and must be provided for File documents' }),
    data: fileDataSchema,
});

export default class File extends BaseDocument {
    constructor(options = {}) {
        // Ensure checksumArray is provided and non-empty before calling super
        // File abstraction implies we already have the file content/checksum analyzed
        if (!options.checksumArray || !Array.isArray(options.checksumArray) || options.checksumArray.length === 0) {
            throw new Error('File documents require a non-empty, pre-computed checksumArray in the options object.');
        }

        // Set schema before calling super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        // Inject File-specific index options BEFORE super()
        options.indexOptions = {
            ...(options.indexOptions || {}),
            // Index filename and all dataPaths (which contain URIs)
            ftsSearchFields: ['data.filename', 'metadata.dataPaths'],
            vectorEmbeddingFields: ['data.filename', 'metadata.dataPaths'],
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
        return fileDataSchema;
    }

    static get schema() {
        return fileDocumentSchema;
    }

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                filename: 'string',
                size: 'number',
                mime: 'string',
            },
            metadata: {
                dataPaths: ['string'],
            },
            checksumArray: ['string'],
        };
    }

    /**
     * Validate the full document
     */
    static validate(document) {
        return fileDocumentSchema.parse(document);
    }

    /**
     * Validate the data portion (instance method)
     */
    validateData() {
        return fileDataSchema.parse(this.data);
    }

    /**
     * Validate just the data portion (static)
     */
    static validateData(documentData) {
        return fileDataSchema.parse(documentData);
    }

    /**
     * Resolve a URI with variable expansion
     * @param {string} uri - The URI to resolve (e.g. "file://{WORKSPACE_ROOT}/data/foo.pdf")
     * @param {Object} variables - Dictionary of variables to replace (e.g. { WORKSPACE_ROOT: '/tmp' })
     * @returns {string} Resolved URI
     */
    static resolveUri(uri, variables = {}) {
        if (!uri || typeof uri !== 'string') return uri;

        return uri.replace(/\{([A-Z0-9_]+)\}/g, (match, variable) => {
            return variables[variable] !== undefined ? variables[variable] : match;
        });
    }
}
