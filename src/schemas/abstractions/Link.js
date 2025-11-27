'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/link';
const DOCUMENT_SCHEMA_VERSION = '1.0';
const URI_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

const linkPayloadSchema = Document.extendDataSchema(
    z.object({
        uri: z.string().min(1).refine((value) => URI_SCHEME_REGEX.test(value.trim()), 'Invalid URI: missing scheme'),
        label: z.string().optional(),
        description: z.string().optional(),
        type: z.string().optional(),
        scheme: z.string().optional(),
        category: z.string().optional(),
        contextPath: z.string().optional(),
        contextUUIDs: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        properties: z.record(z.any()).optional(),
        lastAccessedAt: z.string().datetime().optional(),
        previews: z.array(
            z.object({
                type: z.string(),
                uri: z.string().optional(),
                title: z.string().optional(),
                metadata: z.record(z.any()).optional(),
            }).strict(),
        ).optional(),
    }).passthrough(),
);

const defaultIndexOptions = {
    ftsSearchFields: ['data.label', 'data.description', 'data.uri'],
    vectorEmbeddingFields: ['data.label', 'data.description'],
    checksumFields: ['data.uri'],
};

export default class Link extends Document {

    constructor(options = {}) {
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;
        options.indexOptions = {
            ...defaultIndexOptions,
            ...(options.indexOptions || {}),
        };

        super(options);

        this.#ensureArray('tags');
        this.#applyUriNormalization();
    }

    // ----- Getters / Setters -----

    get uri() {
        return this.data.uri;
    }

    set uri(value) {
        this.#setUri(value);
        this.checksumArray = this.generateChecksumStrings();
        this.updatedAt = new Date().toISOString();
    }

    get scheme() {
        return this.data.scheme;
    }

    // ----- Mutators -----

    touch(timestamp = new Date().toISOString()) {
        this.data.lastAccessedAt = timestamp;
        this.updatedAt = timestamp;
        return this;
    }

    addTag(tag) {
        if (!tag) { return this; }
        const normalized = tag.trim();
        if (!normalized) { return this; }
        if (!this.data.tags.includes(normalized)) {
            this.data.tags.push(normalized);
        }
        return this;
    }

    removeTag(tag) {
        if (!tag) { return this; }
        this.data.tags = this.data.tags.filter((existing) => existing !== tag);
        return this;
    }

    // ----- Static helpers -----

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Link(data);
    }

    static get dataSchema() {
        return linkPayloadSchema;
    }

    static get schema() {
        return baseDocumentSchema;
    }

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                uri: 'string',
                label: 'string',
            },
        };
    }

    static validate(document) {
        return baseDocumentSchema.parse(document);
    }

    static validateData(documentData) {
        return linkPayloadSchema.parse(documentData);
    }

    // ----- Private helpers -----

    #ensureArray(field) {
        if (!Array.isArray(this.data[field])) {
            this.data[field] = [];
        }
    }

    #applyUriNormalization() {
        if (!this.data.uri) {
            throw new Error('Link data requires a uri');
        }
        this.#setUri(this.data.uri);
    }

    #setUri(value) {
        if (!value) {
            throw new Error('Link uri cannot be empty');
        }
        const normalized = value.trim();
        if (!URI_SCHEME_REGEX.test(normalized)) {
            throw new Error('Invalid URI: missing scheme');
        }
        this.data.uri = normalized;
        this.data.scheme = this.#extractScheme(normalized);
    }

    #extractScheme(value) {
        return value.split(':')[0].toLowerCase();
    }
}
