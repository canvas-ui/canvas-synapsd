'use strict';

import BaseDocument, { documentSchema as baseDocumentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/file';
const DOCUMENT_SCHEMA_VERSION = '3.0';

// A File is a pure blob: its identity is the checksum, its bytes live in
// `stored` (referenced via `locations`), and its facts (size/mime) are
// doc-level invariants in `metadata`. Inline `data` is reserved for JSON
// docs, so a File carries none — the same bytes may be named differently at
// each location, and names are searched via `locationUrls`, not treated as
// identity.
const fileDataSchema = z.object({}).passthrough();

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
        // schemaVersion is a class invariant, not persisted state — always
        // stamp the current version so re-parsed/updated docs self-heal.
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;

        // Inject File-specific index options BEFORE super()
        options.indexOptions = {
            ...(options.indexOptions || {}),
            // Checksums are computed upstream by `stored` (content-addressed blob);
            // declare the real algorithms so the doc doesn't report Base's sha1 default.
            checksumAlgorithms: ['sha256', 'md5'],
            primaryChecksumAlgorithm: 'sha256',
            // Names live in the location URLs (one blob, many aliases) — index those.
            ftsSearchFields: ['locationUrls'],
            vectorEmbeddingFields: ['locationUrls'],
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
            data: {},
            locations: [{ url: 'string', metadata: {} }],
            metadata: { contentType: 'string', size: 'number' },
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
