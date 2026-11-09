'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../Document.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/schema/link';
const DOCUMENT_SCHEMA_VERSION = '3.0';
const URI_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const uriSchema = z.string().min(1).refine((value) => URI_SCHEME_REGEX.test(value.trim()), 'Invalid URI: missing scheme');

const linkPayloadSchema = Document.extendDataSchema(
    z.object({
        uri: uriSchema,
        label: z.string().optional(),
        description: z.string().optional(),
        // What the link points at, e.g. 'webapp' for a launchable web application.
        // Optional; an untyped link is a plain bookmark.
        type: z.string().optional(),
        scheme: z.string().optional(),
        // Free-form grouping, e.g. 'games', 'productivity'. Optional.
        category: z.string().optional(),
        tags: z.array(z.string()).optional(),
        properties: z.record(z.any()).optional(),
        lastAccessedAt: z.string().datetime().optional(),
    }).passthrough(),
);

const defaultIndexOptions = {
    ftsSearchFields: ['data.label', 'data.description', 'data.uri'],
    vectorEmbeddingFields: ['data.label', 'data.description'],
    checksumFields: ['data.uri'],
};

export default class Link extends Document {

    static exampleData = { uri: 'https://example.com/music', label: 'Music', tags: ['music'] };
    static inputNotes = 'uri is required and includes a scheme. scheme is derived from uri; tags default to an empty array. type (e.g. "webapp") and category (e.g. "games") are optional facets. Browser tabs use a different schema (url/title).';

    /**
     * `data/type/<type>` and `data/category/<category>`, one key each when set.
     *
     * A web application is a link with `type: 'webapp'`, not an Application
     * document: it has a URL rather than per-device installs. "Games linked into
     * this context" is then `data/schema/link AND data/type/webapp AND
     * data/category/games` intersected with the context, with no per-row scan.
     * Both fields are optional; an unset or blank value ticks nothing.
     */
    static facetFields = ['data.type', 'data.category'];

    // Index configuration is SCHEMA-level, resolved by Document from this
    // static. Never stored on the row (see documentSchema).
    static indexOptions = defaultIndexOptions;

    constructor(options = {}) {
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;

        super(options);

        this.#ensureArray('tags');
        this.#setUri(this.data.uri);
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

    #setUri(value) {
        const normalized = z.object({ data: z.object({ uri: uriSchema }) }).parse({ data: { uri: value } }).data.uri.trim();
        this.data.uri = normalized;
        this.data.scheme = this.#extractScheme(normalized);
    }

    #extractScheme(value) {
        return value.split(':')[0].toLowerCase();
    }
}
