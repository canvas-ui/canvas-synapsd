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
import { generateChecksum } from '../utils/crypto.js';

// Document constants
const DOCUMENT_SCHEMA_NAME = 'data/abstraction/document';
const DOCUMENT_SCHEMA_VERSION = '2.2';
const DOCUMENT_DATA_CHECKSUM_ALGORITHMS = ['sha1', 'sha256'];
const DOCUMENT_DATA_CHECKSUM_ALGORITHM_DEFAULT = DOCUMENT_DATA_CHECKSUM_ALGORITHMS[0];
const DOCUMENT_DATA_CHECKSUM_FIELDS = ['data'];
const DOCUMENT_DATA_FTS_SEARCH_FIELDS = ['data'];
const DOCUMENT_DATA_VECTOR_EMBEDDING_FIELDS = ['data'];
const DEFAULT_DOCUMENT_DATA_TYPE = 'application/json';
const DEFAULT_DOCUMENT_DATA_ENCODING = 'utf8';

// Minimal schema definition (for API/frontend data input)
const documentDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.record(z.any()),
});

// Location entry: a URL pointing to a copy of the data, with optional
// protocol-specific metadata. The URL is the single source of truth for "where":
//   file://<deviceId>/<path>   – device-local copy; deviceId is the URL authority,
//                                clients compare it against their own id to prefer
//                                a local copy. (No separate deviceId field — flat.)
//   stored://<backend>/<key>, s3://<bucket>/…, http(s)://…, imap://… – remote copies.
// metadata carries protocol-specific hints (auth refs for SMB, region for S3, status).
const locationSchema = z.object({
    url: z.string(),
    metadata: z.record(z.any()).optional(),
});

const timelineEntrySchema = z.object({
    name: z.string().optional(),
    timeline: z.string().optional(),
    scale: z.string().optional(),
    start: z.any(),
    end: z.any().optional(),
}).passthrough().refine(entry => entry.name || entry.timeline, {
    message: 'Timeline entry requires name or timeline',
});

// Document ids are integers. A caller may hand us a numeric string; coerce it
// back so it never forks the storage key or trips the numeric-id schema.
// Non-numeric input is passed through to surface as a validation error rather
// than being silently swallowed.
function normalizeDocumentId(id) {
    if (id === undefined || id === null) { return null; }
    if (typeof id === 'string' && /^\d+$/.test(id.trim())) { return parseInt(id, 10); }
    return id;
}

// Full document schema definition (for internal storage)
const documentSchema = z.object({
    // Base
    // Document id is an integer assigned by the DB (generateDocumentIDs). It is
    // the stable key every bitmap/timeline/checksum reference hangs off, so it
    // MUST be numeric — a string id (e.g. from a transport coercing the field)
    // would fork the storage key. null/undefined = not yet assigned (new doc).
    id: z.number().int().positive().nullable().optional(),
    schema: z.string(),
    schemaVersion: z.string(),

    // Internal index configuration
    indexOptions: z.object({
        checksumAlgorithms: z.array(z.string()),
        checksumFields: z.array(z.string()),
        ftsSearchFields: z.array(z.string()),
        vectorEmbeddingFields: z.array(z.string()),
        embeddingOptions: z.object({
            embeddingModel: z.string(),
            embeddingDimensions: z.number(),
            embeddingProvider: z.string(),
            embeddingProviderOptions: z.record(z.any()).optional(),
            chunking: z.object({
                type: z.enum(['sentence', 'paragraph', 'chunk']),
                chunkSize: z.number(),
                chunkOverlap: z.number(),
            }).optional(),
        }).optional(),
    }).optional(),

    // Timestamps
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),

    // Document data/payload
    data: z.record(z.any()),

    // Optional, user-authored free-text note ("sofa from the cozmo bar in Košice").
    // Top-level (not under data) so it survives every per-schema migration/re-index
    // unconditionally, stays out of checksumFields (no dedup/re-embed churn on edit),
    // and is the one text class that can never be regenerated — user-editable only.
    comment: z.string().optional(),

    // Locations: addressable copies of the data content. Each entry is
    // { url, metadata? }; the URL authority encodes the device (file://<deviceId>/…)
    // for device-local detection/preference.
    locations: z.array(locationSchema).optional(),

    // Optional content-derived timeline intervals. The DB indexes these as-is;
    // extraction belongs to the app/ingestion layer.
    timelines: z.array(timelineEntrySchema).optional(),

    // Metadata section – unified shape (v2.2)
    metadata: z.object({
        contentType: z.string().optional(),
        contentEncoding: z.string().optional(),
        contextUUIDs: z.array(z.string()).optional(),
        contextPath: z.array(z.string()).optional(),
        features: z.array(z.string()).optional(),
    }).catchall(z.any()).optional(), // Allow additional metadata fields

    // Checksums
    checksumArray: z.array(z.string()).optional(),
    embeddingsArray: z.array(z.string()).optional(),

    // Versioning — parentId/versions reference document ids, which are numeric
    parentId: z.number().int().positive().nullable().optional(),
    versions: z.array(z.number().int().positive()).optional(),
    versionNumber: z.number().int().positive().optional(),
    latestVersion: z.number().int().positive().optional(),
});

/**
 * Base Document class
 */

class BaseDocument {

    /**
     * Constructor
     * @param {Object} options - Document options
     * @param {string} options.id - Document ID
     * @param {string} options.schema - Document schema
     * @param {string} options.schemaVersion - Document schema version
     * @param {Object} options.data - Document data
     * @param {Object} options.metadata - Document metadata
     * @param {Object} options.indexOptions - Document index options
     */
    constructor(options = {}) {
        // Base
        this.id = normalizeDocumentId(options.id);
        this.schema = options.schema ?? DOCUMENT_SCHEMA_NAME;
        this.schemaVersion = options.schemaVersion ?? DOCUMENT_SCHEMA_VERSION;

        // Internal index configuration
        this.indexOptions = {
            checksumAlgorithms: options.indexOptions?.checksumAlgorithms || DOCUMENT_DATA_CHECKSUM_ALGORITHMS,
            // Maybe we should just take the first one in the array?
            primaryChecksumAlgorithm: options.indexOptions?.primaryChecksumAlgorithm || DOCUMENT_DATA_CHECKSUM_ALGORITHM_DEFAULT,
            checksumFields: options.indexOptions?.checksumFields || DOCUMENT_DATA_CHECKSUM_FIELDS,
            ftsSearchFields: options.indexOptions?.ftsSearchFields || DOCUMENT_DATA_FTS_SEARCH_FIELDS,
            vectorEmbeddingFields: options.indexOptions?.vectorEmbeddingFields || DOCUMENT_DATA_VECTOR_EMBEDDING_FIELDS,
            ...(options.indexOptions || {}),
            embeddingOptions: {
                ...(options.indexOptions?.embeddingOptions || {}),
                // Local in-process ONNX (fastembed) is the MVP default; the
                // server computes vectors for readable JSON docs (notes). Apps
                // may override per-document for blob/media (app-provided vectors).
                embeddingModel: options.indexOptions?.embeddingOptions?.embeddingModel || 'bge-small-en-v1.5',
                embeddingDimensions: options.indexOptions?.embeddingOptions?.embeddingDimensions || 384,
                embeddingProvider: options.indexOptions?.embeddingOptions?.embeddingProvider || 'local',
                embeddingProviderOptions: options.indexOptions?.embeddingOptions?.embeddingProviderOptions || {},
                chunking: options.indexOptions?.embeddingOptions?.chunking || {
                    type: 'sentence',
                    chunkSize: 1000,
                    chunkOverlap: 200,
                },
            },
        };

        // Document data/payload
        this.data = options.data ?? {};

        // User-authored free-text comment (see documentSchema). Empty string = none.
        this.comment = typeof options.comment === 'string' ? options.comment : '';

        // Locations: canonical source-of-truth for where the data lives ({ url, metadata? }).
        this.locations = Array.isArray(options.locations) ? options.locations : [];

        this.timelines = Array.isArray(options.timelines) ? options.timelines : [];

        const meta = options.metadata || {};
        this.metadata = {
            contentType: meta.contentType || DEFAULT_DOCUMENT_DATA_TYPE,
            contentEncoding: meta.contentEncoding || DEFAULT_DOCUMENT_DATA_ENCODING,
            contextUUIDs: meta.contextUUIDs || [],
            contextPath: meta.contextPath || [],
            features: meta.features || [],
            ...meta,
        };

        // Ensure the document's schema id is always present as a feature (deduplicated)
        if (!Array.isArray(this.metadata.features)) {
            this.metadata.features = [];
        }
        if (!this.metadata.features.includes(this.schema)) {
            this.metadata.features.unshift(this.schema);
        }
        // Deduplicate features array
        this.metadata.features = Array.from(new Set(this.metadata.features));

        // Checksums/embeddings
        this.checksumArray = options.checksumArray || this.generateChecksumStrings();
        this.embeddingsArray = options.embeddingsArray || [];

        // Timestamps
        this.createdAt = options.createdAt ?? new Date().toISOString();
        this.updatedAt = options.updatedAt ?? new Date().toISOString();

        // Versioning
        this.parentId = normalizeDocumentId(options.parentId);
        this.versions = options.versions || [];
        this.versionNumber = options.versionNumber || 1;
        this.latestVersion = options.latestVersion || 1;
    }

    /**
     * Create a BaseDocument from minimal data
     * @param {Object} data - Note data
     * @returns {Note} New Note instance
     */
    static fromData(data) {
        if (!BaseDocument.validateData(data)) {
            throw new Error('Invalid document data');
        };

        const document = new BaseDocument(data);
        return document;
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

    /**
     * Update the document with new data
     * @param {Object} data - New data to update the document with
     * @returns {BaseDocument} Updated document instance
     */
    update(data) {
        if (!data) {return this;}

        // Track if data was updated to know if we need to regenerate checksums
        let dataUpdated = false;

        // Update ID if provided (coerce numeric strings; ids are integers)
        if (data.id !== undefined && data.id !== null) { this.id = normalizeDocumentId(data.id); }

        // Update data if provided
        if (data.data) {
            this.data = data.data;
            dataUpdated = true;
        }

        // Update the user-authored comment if provided. Deliberately outside the
        // dataUpdated path — a comment edit must not regenerate checksums (no dedup
        // churn / no content re-embed). Empty string clears it.
        if (data.comment !== undefined) {
            this.comment = typeof data.comment === 'string' ? data.comment : '';
        }

        // Update locations if provided
        if (Array.isArray(data.locations)) {
            this.locations = data.locations;
        }

        if (Array.isArray(data.timelines)) {
            this.timelines = data.timelines;
        }

        // Update metadata if provided
        if (data.metadata) {
            this.metadata = { ...this.metadata, ...data.metadata };
        }

        // Update checksums and embeddings if explicitly provided
        if (data.checksumArray) {
            this.checksumArray = data.checksumArray;
        } else if (dataUpdated) {
            // Regenerate checksums if data was updated
            this.checksumArray = this.generateChecksumStrings();
        }

        if (data.embeddingsArray) {
            this.embeddingsArray = data.embeddingsArray;
        }

        // Always update the updatedAt timestamp
        this.updatedAt = data.updatedAt ?? new Date().toISOString();

        // Update versioning information if provided
        if (data.parentId) { this.parentId = normalizeDocumentId(data.parentId); }
        if (data.versions) { this.versions = data.versions; }
        if (data.versionNumber) { this.versionNumber = data.versionNumber; }
        if (data.latestVersion) { this.latestVersion = data.latestVersion; }

        return this;
    }

    /**
     * Validates the document structure and data
     * @throws {Error} If validation fails
     * @returns {boolean} True if validation passes
     */
    validate() {
        try {
            // Validate using Zod schema
            this.constructor.schema.parse(this);

            if (!this.data) {
                throw new Error('Document data is required');
            }

            // A document is valid if it already carries a content checksum
            // (e.g. a raw-blob hash set by the ingest layer) OR declares fields
            // to derive one from. Content-addressable abstractions (file, email)
            // set checksumArray directly and need no checksumFields.
            if (!this.checksumArray?.length && !this.indexOptions?.checksumFields?.length) {
                throw new Error('A checksum is required: set checksumArray or declare checksumFields');
            }

            return true;
        } catch (error) {
            throw new Error(`Document validation failed: ${error.message}`);
        }
    }

    /**
     * Validate a document against the schema
     * @param {Object} document - Document to validate
     * @returns {Object} Validated document
     * @static
     */
    static validate(document) {
        return BaseDocument.schema.parse(document);
    }

    validateData() {
        return this.constructor.dataSchema.parse({
            schema: this.schema,
            schemaVersion: this.schemaVersion,
            data: this.data,
        });
    }

    /**
     * Validate document data against the schema
     * @param {Object} data - Document data to validate
     * @returns {Object} Validated document data
     * @static
     */
    static validateData(data) {
        return BaseDocument.dataSchema.parse(data);
    }


    /**
     * Versioning
     */

    addVersion(data = {}) { /* TODO: Implement */ }

    listVersions() {}

    getVersion(version) { /* TODO: Implement */ }

    removeVersion(version) { /* TODO: Implement */ }

    getLatestVersion() { /* TODO: Implement */ }

    getPreviousVersion() { /* TODO: Implement */ }

    getNextVersion() { /* TODO: Implement */ }


    /**
     * Utils
     */

    /**
     * Get the primary checksum for the document
     * @returns {string} Primary checksum
     * TODO: Implement with DEFAULT_DOCUMENT_DATA_CHECKSUM_ALGORITHM?
     */
    getPrimaryChecksum() {
        return this.checksumArray[0];
    }

    /**
     * Generate checksum strings for the document
     * @returns {Array<string>} Array of checksum strings
     */
    generateChecksumStrings() {
        const checksumData = this.generateChecksumData();
        return this.indexOptions.checksumAlgorithms.map((algorithm) => {
            return `${algorithm}/${generateChecksum(checksumData, algorithm)}`;
        });
    }

    /**
     * Generate checksum data for the document
     * @returns {string} Checksum data
     */
    generateChecksumData() {
        try {
            // Default to the whole data object if no specific fields are set
            if (!this.indexOptions?.checksumFields?.length ||
                this.indexOptions.checksumFields.includes('data')) {
                return this.data ? JSON.stringify(this.data) : '';
            }

            // Extract and concatenate specified fields
            const fieldValues = this.indexOptions.checksumFields
                .map((field) => {
                    const value = this.getNestedValue(this, field);
                    return value !== undefined ? JSON.stringify(value) : '';
                })
                .filter(Boolean);  // Remove empty strings

            return fieldValues.join('');
        } catch (error) {
            console.error('Error generating checksum data:', error);
            return '';
        }
    }

    /**
     * Generate full-text search data for the document
     * @returns {Array<string>|null} FTS data
     */
    generateFtsData() {
        try {
            // Extract specified fields (ftsSearchFields may be empty for blob docs)
            const fieldValues = (this.indexOptions?.ftsSearchFields || [])
                .map((field) => {
                    const value = this.getNestedValue(this, field);
                    return value ? String(value).trim() : null;
                })
                .filter(Boolean);  // Remove null/empty values

            // Always FTS the user-authored comment — even when a doc declares no
            // ftsSearchFields (photos/files), so its comment alone makes it searchable.
            if (this.hasComment) { fieldValues.push(this.comment.trim()); }

            return fieldValues.length > 0 ? fieldValues : null;
        } catch (error) {
            console.error('Error generating FTS data:', error);
            return null;
        }
    }

    /**
     * Generate embeddings data for the document
     * @returns {Array<string>|null} Embeddings data
     */
    generateEmbeddingsData() {
        try {
            if (!this.indexOptions?.vectorEmbeddingFields?.length) {return null;}

            // Extract specified fields
            const fieldValues = this.indexOptions.vectorEmbeddingFields
                .map((field) => {
                    const value = this.getNestedValue(this, field);
                    return value || null;
                })
                .filter(Boolean);  // Remove null values

            return fieldValues.length > 0 ? fieldValues : null;
        } catch (error) {
            console.error('Error generating embeddings data:', error);
            return null;
        }
    }

    /**
     * Get a nested value from an object
     * @param {Object} obj - The object to get the nested value from
     * @param {string} path - The path to the nested value
     * @returns {any} The nested value
     */
    getNestedValue(obj, path) {
        if (!obj || !path) {return undefined;}

        try {
            return path.split('.').reduce((current, key) => {
                if (current === null || current === undefined) {return undefined;}
                return current[key];
            }, obj);
        } catch (error) {
            return undefined;
        }
    }

    /**
     * Checks if a date string is within a specific time frame
     * @param {string} dateString - The date string to check
     * @param {string} timeFrameIdentifier - The time frame identifier, one of:
     *   - 'today'
     *   - 'yesterday'
     *   - 'thisWeek'
     *   - 'thisISOWeek'
     *   - 'thisMonth'
     *   - 'thisQuarter'
     *   - 'thisYear'
     * @returns {boolean} True if the date is within the time frame, false otherwise
     */
    static isWithinTimeFrame(dateString, timeFrameIdentifier) {
        const date = parseISO(dateString);
        const timeFrameChecks = {
            today: isToday,
            yesterday: isYesterday,
            thisWeek: isThisWeek,
            thisISOWeek: isThisISOWeek,
            thisMonth: isThisMonth,
            thisQuarter: isThisQuarter,
            thisYear: isThisYear,
        };

        return timeFrameChecks[timeFrameIdentifier]?.(date) ?? false;
    }

    /**
     * Convert the document to JSON
     * @returns {string} JSON representation of the document
     */
    /**
     * Flat string of all location URLs — used by FTS/vector index field paths in subclasses.
     * @returns {string}
     */
    get locationUrls() {
        return this.locations.map((l) => l.url).join(' ');
    }

    /** True when the doc carries a non-empty user-authored comment. */
    get hasComment() {
        return typeof this.comment === 'string' && this.comment.trim().length > 0;
    }

    toJSON() {
        return {
            id: this.id,
            schema: this.schema,
            schemaVersion: this.schemaVersion,
            data: this.data,
            comment: this.comment,
            locations: this.locations,
            timelines: this.timelines,
            metadata: this.metadata,
            indexOptions: this.indexOptions,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            checksumArray: this.checksumArray,
            embeddingsArray: this.embeddingsArray,
            parentId: this.parentId,
            versions: this.versions,
            versionNumber: this.versionNumber,
            latestVersion: this.latestVersion,
        };
    }

    /**
     * Convert the document to an object
     * @returns {Object} Object representation of the document
     */
    toObject() {
        return JSON.parse(JSON.stringify(this.toJSON()));
    }

    /**
     * Sub-classes can call this helper to extend the base data-schema with their
     * own fields while inheriting the common wrapper (schema, schemaVersion, …)
     *
     * @param {object|z.ZodRawShape} extraShape – additional fields describing `data`
     * @returns {z.ZodObject}
     */
    static extendDataSchema(extraShape = {}) {
        // Accept both plain object and Zod raw shape
        const shape = (extraShape instanceof z.ZodType) ? extraShape : z.object(extraShape);

        return z.object({
            schema: z.string(),
            schemaVersion: z.string().optional(),
            data: shape.passthrough(),
            metadata: z.any().optional(),
        });
    }

    /**
     * -------- Context management helpers --------
     */

    addContext(uuid, pathArray = undefined) {
        if (!uuid) { return; }
        if (!Array.isArray(this.metadata.contextUUIDs)) {
            this.metadata.contextUUIDs = [];
        }
        if (!this.metadata.contextUUIDs.includes(uuid)) {
            this.metadata.contextUUIDs.push(uuid);
        }
        if (pathArray && Array.isArray(pathArray)) {
            this.metadata.contextPath = pathArray;
        }
    }

    removeContext(uuid) {
        if (!uuid || !Array.isArray(this.metadata.contextUUIDs)) { return; }
        this.metadata.contextUUIDs = this.metadata.contextUUIDs.filter(id => id !== uuid);
    }

    /**
     * -------- Feature helpers --------
     */

    addFeature(feature) {
        if (!feature) { return; }
        if (!Array.isArray(this.metadata.features)) {
            this.metadata.features = [];
        }
        if (!this.metadata.features.includes(feature)) {
            this.metadata.features.push(feature);
        }
    }

    removeFeature(feature) {
        if (!feature || !Array.isArray(this.metadata.features)) { return; }
        this.metadata.features = this.metadata.features.filter(f => f !== feature);
    }

    hasFeature(feature) {
        if (!feature || !Array.isArray(this.metadata.features)) { return false; }
        return this.metadata.features.includes(feature);
    }

    getFeaturesByPrefix(prefix) {
        if (!prefix || !Array.isArray(this.metadata.features)) { return []; }
        return this.metadata.features.filter(f => f.startsWith(prefix));
    }

}

// Export document class and schemas
export default BaseDocument;
export { documentDataSchema, documentSchema, locationSchema, timelineEntrySchema };
