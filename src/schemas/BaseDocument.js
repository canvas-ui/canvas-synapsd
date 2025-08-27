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
const DOCUMENT_SCHEMA_VERSION = '2.1';
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

// Full document schema definition (for internal storage)
const documentSchema = z.object({
    // Base
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

    // Metadata section – unified shape (v2.1)
    metadata: z.object({
        contentType: z.string().optional(),
        contentEncoding: z.string().optional(),
        dataPaths: z.array(
            z.union([
                z.string(),
                z.object({
                    uri: z.string(),
                    protocol: z.string(),
                    checksum: z.string().optional(),
                    priority: z.number().int().optional(),
                    metadata: z.record(z.any()).optional(),
                }).strict(),
            ]),
        ).optional(),
        contextUUIDs: z.array(z.string()).optional(),
        contextPath: z.array(z.string()).optional(),
        features: z.array(z.string()).optional(),
    }).catchall(z.any()).optional(), // Allow additional metadata fields

    // Checksums
    checksumArray: z.array(z.string()).optional(),
    embeddingsArray: z.array(z.string()).optional(),

    // Versioning
    parentId: z.string().nullable().optional(),
    versions: z.array(z.string()).optional(),
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
        this.id = options.id ?? null;
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
                embeddingModel: options.indexOptions?.embeddingOptions?.embeddingModel || 'text-embedding-3-small',
                embeddingDimensions: options.indexOptions?.embeddingOptions?.embeddingDimensions || 1536,
                embeddingProvider: options.indexOptions?.embeddingOptions?.embeddingProvider || 'openai',
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
        // Build metadata with defaults & new redundancy fields
        this.metadata = {
            contentType: options.metadata?.contentType || DEFAULT_DOCUMENT_DATA_TYPE,
            contentEncoding: options.metadata?.contentEncoding || DEFAULT_DOCUMENT_DATA_ENCODING,
            dataPaths: options.metadata?.dataPaths || [],
            contextUUIDs: options.metadata?.contextUUIDs || [],
            contextPath: options.metadata?.contextPath || [],
            features: options.metadata?.features || [],
            ...(options.metadata || {}),
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
        this.parentId = options.parentId || null;
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

        // Update ID if provided
        if (data.id) { this.id = data.id; }

        // Update data if provided
        if (data.data) {
            this.data = data.data;
            dataUpdated = true;
        }

        // Update metadata if provided
        if (data.metadata) {
            this.metadata = {
                ...this.metadata,
                ...data.metadata,
            };
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
        if (data.parentId) { this.parentId = data.parentId; }
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

            if (!this.indexOptions?.checksumFields?.length) {
                throw new Error('At least one checksum field must be specified');
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
            if (!this.indexOptions?.ftsSearchFields?.length) {return null;}

            // Extract specified fields
            const fieldValues = this.indexOptions.ftsSearchFields
                .map((field) => {
                    const value = this.getNestedValue(this, field);
                    return value ? String(value).trim() : null;
                })
                .filter(Boolean);  // Remove null/empty values

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
    toJSON() {
        return {
            id: this.id,
            schema: this.schema,
            schemaVersion: this.schemaVersion,
            data: this.data,
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
        return JSON.parse(this.toJSON());
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
export { documentDataSchema, documentSchema };
