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
import { zodToJsonSchema } from 'zod-to-json-schema';
import { generateChecksum } from '../utils/crypto.js';

// Derived JSON Schemas, memoized per class. WeakMap so an unregistered consumer
// class does not pin its conversion for the process lifetime.
const jsonSchemaCache = new WeakMap();

// Document constants
const DOCUMENT_SCHEMA_NAME = 'data/abstraction/document';
const DOCUMENT_SCHEMA_VERSION = '3.0';
const DOCUMENT_DATA_CHECKSUM_ALGORITHMS = ['sha1', 'sha256'];
const DOCUMENT_DATA_CHECKSUM_FIELDS = ['data'];
const DOCUMENT_DATA_FTS_SEARCH_FIELDS = ['data'];
const DOCUMENT_DATA_VECTOR_EMBEDDING_FIELDS = ['data'];
// Structural `data` keys that are NOT content: they describe the document's
// place in the graph, not what it says. Excluded from every WHOLE-`data`
// projection (checksum / FTS / embedding), because those default to the entire
// data object — so without this, asserting an edge would fork the document's
// identity, pollute its search text and trigger a re-embed.
// A document that carries none of these keys projects byte-identically to
// before, so existing checksums are untouched.
const NON_CONTENT_DATA_KEYS = ['relations'];

// Feature namespaces the ENGINE derives on every write from document state
// (schema id, contentType, locations, device presence, orphan status).
// They must never be stored in the asserted array: a stored copy is
// indistinguishable from a derived one while being immune to the derivation's own
// stale-diff — i.e. it could never be unticked. Same reasoning that made
// `device/*` a strip rather than a merge on the write routes.
// ⚠️ This list contains ONLY what the engine actually derives TODAY. Stripping a
// key that has no deriver does not make it derived, it makes it unsettable — so
// each entry is added in the SAME commit that adds its deriver.
//
// `data/backend/` joined the list in Rev A (2026-08-04): v3 made it derived from
// `locations[]` (`#backendFeaturesFromLocations`, including the declared
// `location.metadata.backend` case), so the parent no longer asserts it and an
// asserted copy would be immune to that derivation's stale-diff.
// Deliberately still ABSENT: `data/source/*` (folded into `data/backend/*` by the
// v3 migration, nothing emits it) and `data/no-location` (asserted by the parent's
// orphan lifecycle — it carries intent, not just location count; see TODO.md).
const DERIVED_FEATURE_PREFIXES = [
    'data/abstraction/',    // index.js: pushes parsed.schema
    'data/mime/',           // index.js: mimeBitmapKeys from metadata.contentType
    'data/backend/',        // index.js: #backendFeaturesFromLocations
    'feature/',             // index.js: feature/has-comment
    'device/',              // index.js: #deviceFeaturesFromLocations
];

// A schema's own facet namespaces (`static facetFields = ['data.status']` ->
// `data/status/`) are derived too, but they are per-schema rather than global, so
// they are computed rather than listed. Without this the generalization would
// leak: an asserted `data/status/done` would be ticked from the array AND from
// the facet derivation, and the facet stale-diff could never untick it because
// the array keeps re-asserting it.
function facetPrefixesFor(facetFields) {
    return (Array.isArray(facetFields) ? facetFields : [])
        .map((field) => String(field).split('.').pop())
        .filter(Boolean)
        .map((namespace) => `data/${namespace}/`);
}

// RETIRED namespaces: nothing derives them any more, but the asserted array must
// still refuse them, so a client cannot resurrect a dead axis whose keys look
// exactly like the engine's former output. Kept SEPARATE from the derived list
// above so that list stays literally true — "what the engine derives today".
//
// `data/kind/` was the v3 subtype axis, removed 2026-08-04 when the schema
// hierarchy replaced it (the subtype is a segment of the schema id now). It had
// zero consumers, so the removal was externally free; blocking re-assertion keeps
// it that way.
const RETIRED_FEATURE_PREFIXES = ['data/kind/'];

// Asserted, but stamped by INGEST rather than by the client. Preserved across an
// update that omits them, so a client re-putting its own tag array cannot silently
// drop the provenance of how the document got here.
const PRESERVED_FEATURE_PREFIXES = ['data/dataset/'];

const isPreservedFeature = (key) => PRESERVED_FEATURE_PREFIXES.some((prefix) => key.startsWith(prefix));

/**
 * Normalize an asserted feature array: strip derived keys, de-duplicate, and
 * carry forward any preserved keys the incoming array omitted.
 * @param {Array<string>} input incoming (client-supplied) features
 * @param {Array<string>} previous the document's features before this write
 * @returns {Array<string>}
 */
function normalizeFeatureArray(input, previous = [], facetFields = []) {
    const refusedPrefixes = [
        ...DERIVED_FEATURE_PREFIXES, ...RETIRED_FEATURE_PREFIXES, ...facetPrefixesFor(facetFields),
    ];
    const isDerived = (key) => refusedPrefixes.some((prefix) => key.startsWith(prefix));
    const out = [];
    const seen = new Set();
    const add = (key) => {
        if (typeof key !== 'string' || key === '' || seen.has(key)) { return; }
        seen.add(key);
        out.push(key);
    };

    for (const key of Array.isArray(input) ? input : []) {
        if (typeof key !== 'string' || isDerived(key)) { continue; }
        add(key);
    }
    for (const key of Array.isArray(previous) ? previous : []) {
        if (typeof key === 'string' && isPreservedFeature(key)) { add(key); }
    }

    return out;
}

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

    // NOTE: `indexOptions` is deliberately ABSENT from the row. It is SCHEMA-level
    // configuration, identical for every document of a schema, so persisting it
    // per row was pure overhead — ~461 B of byte-identical JSON on a measured
    // note, ~3.2 GB at 7M rows. It now lives on the schema class as a
    // `static indexOptions` and is resolved at construction time.
    // Legacy rows may still carry the field; it is ignored on read (see the
    // constructor), so a stale stored copy can never resurrect old config.

    // Timestamps
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    // Orphan lifecycle: set when the document lost its last resolvable location
    // (data/no-location feature). null = not orphaned. Cleared on re-bind, read
    // by the retention GC. A state marker, not a deletion.
    orphanedAt: z.string().datetime().nullable().optional(),

    // Document data/payload
    data: z.record(z.any()),

    // Optional, user-authored free-text note ("sofa from the cozmo bar in Košice").
    // Top-level (not under data) so it survives every per-schema migration/re-index
    // unconditionally, stays out of checksumFields (no dedup/re-embed churn on edit),
    // and is the one text class that can never be regenerated — user-editable only.
    comment: z.string().optional(),

    // NOTE: there is no `kind` field. The v3 subtype axis was removed 2026-08-04:
    // the schema hierarchy carries the subtype in the id itself, so a second axis
    // (and a row field mirroring it) was one representation too many. Legacy rows
    // may still carry `kind`; it is ignored on read and dropped the next time the
    // document is written, exactly like the retired `indexOptions` field.

    // ASSERTED feature membership — tags a human or client put on this document
    // (`tag/*`, `custom/*`, `client/*`), plus ingest provenance (`data/dataset/*`).
    // Top-level for the same reasons as `comment`: outside checksumFields so a tag
    // edit never forks dedup or triggers a re-embed, and updated by its own branch
    // outside the data path.
    //
    // Deliberately separate from `metadata`, which holds EXTRACTED facts written by
    // derivers. Sharing one container meant an EXIF enrichment patch and a user tag
    // edit took the same shallow-merge code path at wildly different write
    // frequencies and trust levels.
    //
    // DERIVED keys never live here — they are recomputed on every write and would
    // otherwise be un-untickable. See DERIVED_FEATURE_PREFIXES.
    features: z.array(z.string()).optional(),

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
        features: z.array(z.string()).optional(),
    }).catchall(z.any()).optional(), // Allow additional metadata fields

    // Checksums
    checksumArray: z.array(z.string()).optional(),
});

/**
 * Document — the base class every schema extends, AND the class registered for
 * `data/abstraction/document` itself.
 *
 * Renamed from `BaseDocument` 2026-08-04 (Rev A). There used to be a separate
 * `abstractions/Document.js` subclass sitting on top of this one; it added a
 * constructor that pinned the schema id/version this class already defaults to,
 * an `indexOptions` static identical to the defaults below, and validate/
 * validateData overrides that forwarded to `super`. It carried no behaviour, so
 * the two collapsed into this file rather than the base keeping a name that
 * existed only to avoid the collision.
 */

class Document {

    /**
     * Constructor
     * @param {Object} options - Document options
     * @param {string} options.id - Document ID
     * @param {string} options.schema - Document schema
     * @param {string} options.schemaVersion - Document schema version
     * @param {Object} options.data - Document data
     * @param {Object} options.metadata - Document metadata
     */
    constructor(options = {}) {
        // Base
        this.id = normalizeDocumentId(options.id);
        this.schema = options.schema ?? DOCUMENT_SCHEMA_NAME;
        this.schemaVersion = options.schemaVersion ?? DOCUMENT_SCHEMA_VERSION;

        // Internal index configuration — resolved from the SCHEMA, never from the
        // caller or the row. Resolution order is core defaults -> the subclass's
        // `static indexOptions`, and that is the whole order: a per-document
        // override is deliberately impossible now that the field is not persisted,
        // because it would apply on write and vanish on read.
        //
        // This also settles the merge-order inconsistency v3 inherited: half the
        // schemas spread caller options last (caller wins) and half spread them
        // first then hard-override the field lists (caller silently discarded).
        // With no caller input there is one convention and nothing to get wrong.
        const schemaIndexOptions = this.constructor.indexOptions || {};
        this.indexOptions = {
            checksumAlgorithms: schemaIndexOptions.checksumAlgorithms || DOCUMENT_DATA_CHECKSUM_ALGORITHMS,
            checksumFields: schemaIndexOptions.checksumFields || DOCUMENT_DATA_CHECKSUM_FIELDS,
            ftsSearchFields: schemaIndexOptions.ftsSearchFields || DOCUMENT_DATA_FTS_SEARCH_FIELDS,
            vectorEmbeddingFields: schemaIndexOptions.vectorEmbeddingFields || DOCUMENT_DATA_VECTOR_EMBEDDING_FIELDS,
            ...schemaIndexOptions,
            embeddingOptions: {
                ...(schemaIndexOptions.embeddingOptions || {}),
                // Local in-process ONNX (fastembed) is the MVP default; the
                // server computes vectors for readable JSON docs (notes). Apps
                // may override per-document for blob/media (app-provided vectors).
                embeddingModel: schemaIndexOptions.embeddingOptions?.embeddingModel || 'bge-small-en-v1.5',
                embeddingDimensions: schemaIndexOptions.embeddingOptions?.embeddingDimensions || 384,
                embeddingProvider: schemaIndexOptions.embeddingOptions?.embeddingProvider || 'local',
                embeddingProviderOptions: schemaIndexOptions.embeddingOptions?.embeddingProviderOptions || {},
                chunking: schemaIndexOptions.embeddingOptions?.chunking || {
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

        // `features` no longer lives under metadata (v3). Strip it from the spread
        // so a legacy row cannot leave a second, stale copy behind.
        const { features: legacyMetadataFeatures, ...meta } = options.metadata || {};
        this.metadata = {
            contentType: meta.contentType || DEFAULT_DOCUMENT_DATA_TYPE,
            contentEncoding: meta.contentEncoding || DEFAULT_DOCUMENT_DATA_ENCODING,
            ...meta,
        };

        // Asserted features (see documentSchema).
        //
        // The schema id is NOT injected here any more. It used to be unshifted onto
        // every construct, which was triple-redundant (clients send it, #putOne
        // re-adds it) and put a DERIVED key inside an asserted-only array.
        //
        // `metadata.features` is accepted as INPUT and promoted here. Originally a
        // migration read path — but it outlived that: the v3 migration rewrites
        // stored rows (and a stale DB refuses to open at all), while clients still
        // legitimately send `metadata: { features: [...] }`. So this is a client
        // input path now, not a row-compat shim, and it stays. The promotion also
        // guarantees there is never a second, stale copy under metadata.
        this.features = normalizeFeatureArray(
            Array.isArray(options.features) ? options.features : legacyMetadataFeatures,
            [],
            this.constructor.facetFields,
        );

        // Checksums/embeddings
        this.checksumArray = options.checksumArray || this.generateChecksumStrings();
        // Timestamps
        this.createdAt = options.createdAt ?? new Date().toISOString();
        this.updatedAt = options.updatedAt ?? new Date().toISOString();
        // Orphan lifecycle marker (null = has locations / never orphaned)
        this.orphanedAt = options.orphanedAt ?? null;
    }

    /**
     * Create a Document from minimal data.
     * The schema id is defaulted before validation (the merged
     * `abstractions/Document.js` did this), so `fromData({ data })` works the
     * same way it does on every subclass.
     * @param {Object} data - Document data
     * @returns {Document} New Document instance
     */
    static fromData(data) {
        const documentData = { ...data, schema: data?.schema ?? DOCUMENT_SCHEMA_NAME };
        if (!Document.validateData(documentData)) {
            throw new Error('Invalid document data');
        };

        return new Document(documentData);
    }

    static get dataSchema() {
        return documentDataSchema;
    }

    static get schema() {
        return documentSchema;
    }

    /**
     * JSON Schema (draft-07) for this schema's DATA envelope, DERIVED from the
     * class's zod `dataSchema`.
     *
     * Until 2026-08-04 every class hand-wrote this as an example object
     * (`{ schema, data: { title: 'string' } }`). It carried no enum, no
     * required/optional, no range and no nesting — so a consumer could not learn
     * the four task statuses or the 1–9 priority range from it and had to
     * duplicate them by hand (the web ui's `useTodoFields.ts` still says
     * "Mirrors synapsd Todo.js STATUS"). Deriving removes the copy AND the drift:
     * there is one source of truth, and it is the one validation already uses.
     *
     * Inherited by every subclass — `this` is the class it was accessed on, so
     * `Email.jsonSchema` converts Email's own `dataSchema`. A subclass overriding
     * this is almost certainly reintroducing a hand-written stub.
     *
     * `$refStrategy: 'none'` inlines everything: consumers of this endpoint are
     * form builders and other languages' validators, and a self-contained
     * document is worth more to them than de-duplicated `$ref`s.
     *
     * @returns {object} JSON Schema draft-07
     */
    static get jsonSchema() {
        const cached = jsonSchemaCache.get(this);
        if (cached) { return cached; }

        // Conversion walks the whole zod tree, so it is memoized per CLASS (not
        // per instance): schemas are immutable statics and this is served on a
        // public route.
        const derived = zodToJsonSchema(this.dataSchema, { $refStrategy: 'none' });
        jsonSchemaCache.set(this, derived);
        return derived;
    }

    /**
     * Update the document with new data
     * @param {Object} data - New data to update the document with
     * @returns {Document} Updated document instance
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

        // Update asserted features if provided. Deliberately outside the
        // dataUpdated path — exactly like `comment` — so a tag edit never
        // regenerates checksums (no dedup fork, no content re-embed).
        // Preserved prefixes are carried forward from the CURRENT value, which is
        // still the pre-write state at this point.
        const incomingFeatures = Array.isArray(data.features)
            ? data.features
            : (Array.isArray(data.metadata?.features) ? data.metadata.features : null);
        if (incomingFeatures) {
            this.features = normalizeFeatureArray(incomingFeatures, this.features, this.constructor.facetFields);
        }

        // Update metadata if provided. `features` is stripped: it has its own
        // top-level home and its own branch above, so letting it through here
        // would recreate the second container this move exists to remove.
        if (data.metadata) {
            const { features: _ignoredMetadataFeatures, ...metadataPatch } = data.metadata;
            this.metadata = { ...this.metadata, ...metadataPatch };
        }

        // Update checksums and embeddings if explicitly provided
        if (data.checksumArray) {
            this.checksumArray = data.checksumArray;
        } else if (dataUpdated) {
            // Regenerate checksums if data was updated
            this.checksumArray = this.generateChecksumStrings();
        }

        // Orphan marker: explicit undefined-check — null is a meaningful value
        // (clears the marker on re-bind).
        if (data.orphanedAt !== undefined) {
            this.orphanedAt = data.orphanedAt;
        }

        // Re-derive locations for schemas that own them.
        //
        // MUST run after both the `data` and the `locations` assignments above:
        // for a deriving schema, `data` is the source of truth and a caller-supplied
        // locations array is stale by definition. Before this hook existed, Dotfile
        // and Application rebuilt locations in their CONSTRUCTOR only, so a generic
        // update({data}) left locations — and therefore the device/id/* presence
        // bitmaps derived from them — pointing at the previous device set.
        const derived = this.deriveLocations();
        if (derived) { this.locations = derived; }

        // Always update the updatedAt timestamp
        this.updatedAt = data.updatedAt ?? new Date().toISOString();

        return this;
    }

    /**
     * Hook for schemas whose `locations` are DERIVED from `data` rather than
     * supplied by the caller (Dotfile.data.links, Application.data.installs).
     *
     * Return an array to take ownership of `locations`, or null (the default) to
     * leave them caller-owned. Overriding this is the ONLY correct way to derive
     * locations — deriving in a constructor alone silently drifts on update.
     *
     * @returns {Array<{url:string, metadata?:object}>|null}
     */
    deriveLocations() { return null; }

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
        return Document.schema.parse(document);
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
        return Document.dataSchema.parse(data);
    }

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
     * `data` with structural (non-content) keys removed — the view every
     * whole-`data` projection must use. Returns the SAME object reference when
     * there is nothing to strip, so documents without relations keep byte-identical
     * checksums.
     * @returns {Object} content-only view of data
     */
    contentData() {
        if (!this.data || typeof this.data !== 'object') { return this.data; }
        if (!NON_CONTENT_DATA_KEYS.some((key) => key in this.data)) { return this.data; }

        const content = { ...this.data };
        for (const key of NON_CONTENT_DATA_KEYS) { delete content[key]; }
        return content;
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
                const content = this.contentData();
                return content ? JSON.stringify(content) : '';
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
                    const value = field === 'data' ? this.contentData() : this.getNestedValue(this, field);
                    if (value === null || value === undefined || value === '') { return null; }

                    // Objects and arrays must be serialized, not String()'d: the
                    // default ftsSearchFields is ['data'] (whole object) and several
                    // schemas index array fields (Identity identifiers/channels/links,
                    // Email from/to), all of which previously indexed the literal
                    // text "[object Object]" — i.e. no searchable content at all.
                    // ⚠️ Changes FTS content for those documents: existing rows need
                    // reindexSearchIndex() to pick it up.
                    if (typeof value === 'object') {
                        const serialized = JSON.stringify(value);
                        return (serialized && serialized !== '{}' && serialized !== '[]') ? serialized : null;
                    }
                    return String(value).trim() || null;
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
                    const value = field === 'data' ? this.contentData() : this.getNestedValue(this, field);
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
            features: this.features,
            locations: this.locations,
            timelines: this.timelines,
            metadata: this.metadata,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            orphanedAt: this.orphanedAt,
            checksumArray: this.checksumArray,
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

}

// Export document class and schemas
export default Document;
export { documentDataSchema, documentSchema, locationSchema, timelineEntrySchema };
export { DERIVED_FEATURE_PREFIXES, RETIRED_FEATURE_PREFIXES, PRESERVED_FEATURE_PREFIXES, normalizeFeatureArray };
