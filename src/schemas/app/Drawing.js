'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../Document.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/schema/drawing';
const DOCUMENT_SCHEMA_VERSION = '1.0';

// A Drawing is a vector sketch: the editable scene (Excalidraw scene JSON —
// elements, appState subset, embedded files) is the source of truth and lives
// in `data.scene`; a rendered PNG preview lives in `stored` (referenced via
// `locations`), so every blob consumer (thumbnails, cards, WebDAV/FUSE,
// offline warming) treats it exactly like a File. Identity is the checksum of
// the canonical serialized scene, computed by the editing client — the same
// sketch content is the same document, and every scene edit moves the
// checksum (which is also what invalidates cached previews via ETag).
const drawingDataSchema = z.object({
    schema: z.string(),
    schemaVersion: z.string().optional(),
    data: z.object({
        title: z.string().optional(),
        scene: z.union([z.object({}).passthrough(), z.string()]),
    }).passthrough(),
    metadata: z.object({}).passthrough().optional(),
});

const drawingDocumentSchema = baseDocumentSchema.extend({
    checksumArray: z.array(z.string()).nonempty({ message: 'checksumArray cannot be empty and must be provided for Drawing documents' }),
});

export default class Drawing extends Document {

    // Index configuration is SCHEMA-level, resolved by Document from this
    // static. Never stored on the row (see documentSchema).
    static indexOptions = {
        // Scene checksum is computed by the editing client over the canonical
        // serialized scene — declare the algorithm so the doc doesn't report
        // Base's sha1 default.
        checksumAlgorithms: ['sha256'],
        // The scene JSON is geometry, not prose — only the title is
        // meaningfully searchable. Text elements inside the scene are a
        // future extractor's job (same pattern as File's metadata.text.content).
        ftsSearchFields: ['data.title'],
        vectorEmbeddingFields: ['data.title'],
        // Identity comes from the external checksumArray; no checksumFields.
    };

    constructor(options = {}) {
        // Drawing implies the editing client already serialized the scene and
        // computed its checksum — same contract as File.
        if (!options.checksumArray || !Array.isArray(options.checksumArray) || options.checksumArray.length === 0) {
            throw new Error('Drawing documents require a non-empty, pre-computed checksumArray in the options object.');
        }

        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;

        super(options);

        // DB-level invariant only: guarantee a title exists (same rationale
        // as Note — smarter derivation is client policy).
        if (!this.data.title) {
            const now = new Date();
            const year = now.getFullYear();
            const month = (now.getMonth() + 1).toString().padStart(2, '0');
            const day = now.getDate().toString().padStart(2, '0');
            this.data.title = `Sketch ${year}${month}${day}`;
        }
    }

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Drawing(data);
    }

    static get dataSchema() {
        return drawingDataSchema;
    }

    static get schema() {
        return drawingDocumentSchema;
    }

    static validate(document) {
        return drawingDocumentSchema.parse(document);
    }

    static validateData(documentData) {
        return drawingDataSchema.parse(documentData);
    }
}
