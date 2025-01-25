'use strict';

// Utils
import { z } from 'zod';
import {
    parseISO,
    isToday,
    isYesterday,
    isThisWeek,
    isThisISOWeek,
    isThisMonth,
    isThisQuarter,
    isThisYear,
} from 'date-fns';

import SchemaRegistry from './SchemaRegistry.js';

const DOCUMENT_SCHEMA = 'data/abstraction/document';
const DOCUMENT_SCHEMA_VERSION = '2.0';
const DEFAULT_DOCUMENT_DATA_CHECKSUM_ALGO = 'sha1';
const DEFAULT_DOCUMENT_DATA_TYPE = 'application/json';
const DEFAULT_DOCUMENT_DATA_ENCODING = 'utf8';

// Base document schema definition
const documentSchema = z.object({
    // Base
    id: z.string().nullable(),
    schema: z.string(),
    schemaVersion: z.string(),

    // Timestamps
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),

    // Internal index configuration
    index: z.object({
        checksumAlgorithms: z.array(z.string()),
        primaryChecksumAlgorithm: z.string(),
        checksumFields: z.array(z.string()),
        searchFields: z.array(z.string()),
        embeddingFields: z.array(z.string())
    }),

    // Metadata section
    metadata: z.object({
        dataContentType: z.string(),
        dataContentEncoding: z.string()
    }).and(z.record(z.any())), // Allow additional metadata fields

    checksums: z.instanceof(Map),
    embeddings: z.array(z.any()),
    features: z.instanceof(Map),
    paths: z.array(z.string()),

    // Document data/payload
    data: z.record(z.any()),

    // Versioning
    parent_id: z.string().nullable(),
    versions: z.array(z.any()),
    version_number: z.number().int().positive(),
    latest_version: z.number().int().positive()
});

export default class Document {

    constructor(options = {}) {
        // Base
        this.id = options.id ?? null;
        this.schema = options.schema ?? DOCUMENT_SCHEMA;
        this.schemaVersion = options.schemaVersion ?? DOCUMENT_SCHEMA_VERSION;

        // Timestamps
        this.created_at = options.created_at ?? new Date().toISOString();
        this.updated_at = options.updated_at ?? this.created_at;

        // Internal index configuration
        this.index = {
            checksumAlgorithms: [
                DEFAULT_DOCUMENT_DATA_CHECKSUM_ALGO,
                'sha256',
            ],
            primaryChecksumAlgorithm: DEFAULT_DOCUMENT_DATA_CHECKSUM_ALGO,
            checksumFields: ['data.title','data.content'],
            searchFields: ['data.title', 'data.content'],
            embeddingFields: ['data.title', 'data.content'],
            ...options.index,
        };

        /**
         * Metadata section
         */

        this.metadata = {
            dataContentType: options.meta?.dataContentType ?? DEFAULT_DOCUMENT_DATA_TYPE,
            dataContentEncoding: options.meta?.dataContentEncoding ?? DEFAULT_DOCUMENT_DATA_ENCODING,
            ...options.meta,
        };

        this.checksums = options.checksums ?? new Map(); // Checksums for the document data
        this.embeddings = options.embeddings ?? []; // Extracted embeddings
        this.features = options.features ?? new Map(); // Extracted features
        this.paths = options.paths ?? []; // Storage path reference URLs

        /**
         * Document data/payload, omitted for blobs
         */

        this.data = options.data ?? {};

        /**
         * Versioning
         */

        this.parent_id = options.parent_id ?? null; // Stored in the child document
        this.versions = options.versions ?? []; // Stored in the parent document
        this.version_number = options.version_number ?? 1;
        this.latest_version = options.latest_version ?? 1; // Stored in the parent document

        // Validate the constructed document
        this.validate();
    }

    update(document) {
        Object.assign(this, document);
        this.updated_at = new Date().toISOString();
    }

    /**
     * Data helpers
     */

    generateChecksumData() {
        // Default to the whole data object if no specific fields are set
        if (this.index.checksumFields.length === 0 ||
            this.index.checksumFields.includes('data')) {
            return JSON.stringify(this.data);
        }

        // Extract and concatenate specified fields
        let fieldValues = this.index.checksumFields.map((field) => {
            const value = this.getNestedValue(this, field); // Originally this.data
            return value !== undefined ? JSON.stringify(value) : '';
        });

        // Concatenate the field values into a single string
        return fieldValues.join('');
    }

    generateFtsData() {
        // Default to the whole data object if no specific fields are set
        if (this.index.searchFields.length === 0) { return null; }

        // Extract specified fields
        let fieldValues = this.index.searchFields.map((field) => {
            const value = this.getNestedValue(this, field);
            if (value !== undefined && value !== '') {
                return value.trim();  //JSON.stringify(value);
            }
        });

        // Return the field array
        return fieldValues;
    }

    generateEmbeddingData() {
        // Default to the whole data object if no specific fields are set
        if (this.index.embeddingFields.length === 0) { return null; }

        // Extract specified fields
        let fieldValues = this.index.embeddingFields.map((field) => {
            const value = this.getNestedValue(this, field);
            if (value !== undefined && value !== '') {
                return value;  //JSON.stringify(value);
            }
        });

        // Return the field array
        return fieldValues;
    }

    

    /**
     * Versioning helpers
    */

    addVersion(version) {
        this.versions.push(version);
    }

    removeVersion(version) {
        this.versions = this.versions.filter((v) => v !== version);
    }

    /**
     * Utils
     */

    static isWithinTimeframe(dateString, timeframe) {
        const date = parseISO(dateString);
        const timeframeChecks = {
            today: isToday,
            yesterday: isYesterday,
            thisWeek: isThisWeek,
            thisISOWeek: isThisISOWeek,
            thisMonth: isThisMonth,
            thisQuarter: isThisQuarter,
            thisYear: isThisYear,
        };

        return timeframeChecks[timeframe]?.(date) ?? false;
    }

    toJSON() {
        return {
            // Base
            id: this.id,
            schema: this.schema,
            schemaVersion: this.schemaVersion,

            // Timestamps
            created_at: this.created_at,
            updated_at: this.updated_at,

            // Internal index configuration
            index: this.index,

            // Metadata section
            metadata: this.metadata,
            checksums: Array.from(this.checksums),
            embeddings: this.embeddings,
            features: Array.from(this.features),
            paths: this.paths,

            // Document data/payload, omitted for blobs
            data: this.data,

            // Versioning
            parent_id: this.parent_id,
            versions: this.versions,
            version_number: this.version_number,
            latest_version: this.latest_version,
        };
    }

    static fromJSON(json) {
        const doc = new Document({
            ...json,
            checksums: new Map(Object.entries(json.checksums)),
            features: new Map(Object.entries(json.features)),
        });
        return doc;
    }

    validate() {
        return SchemaRegistry.validateDocument(this);
    }

    static validate(document) {
        if (!document) { throw new Error('Document is not defined'); }
        return SchemaRegistry.validateDocument(document);
    }

    validateData() {
        if (this.isJsonDocument()) {
            return this.data && typeof this.data === 'object' && Object.keys(this.data).length > 0;
        }
        return this.isBlob();
    }

    static get schemaDefinition() {
        return documentSchema;
    }

    get schemaDefinition() {
        return Document.schemaDefinition;
    }

    isJsonDocument() {
        return this.metadata.dataContentType === 'application/json';
    }

    // TODO: Fixme, this assumes everything other than a blob is stored as JSON which may not be the case
    isBlob() {
        return this.metadata.dataContentType !== 'application/json';
    }

    getNestedValue(obj, path) {
        return path.split('.').reduce((acc, part) => acc && acc[part], obj);
    }


    async updateData(newData) {
        this.data = { ...this.data, ...newData };
        this.updated_at = new Date().toISOString();
    }


}
