'use strict';

/*
 * Dotfile abstraction
 * -------------------
 * Describes a mapping between local paths (file or folder) on multiple devices
 * and a path inside the workspace dotfiles repository.
 *
 * Identity (v3): `data.url`, a normalized URI naming WHICH ENTRY IN WHICH REPO.
 *   workspace:dotfiles#shell/bashrc                     the workspace's own repo
 *   git+ssh://git@github.com/me/dotfiles#shell/bashrc   an external repo
 *
 * This replaced `data.repoPath`, which could not express an external repo at all
 * (one implicit repo was a hardcoded invariant, not a modelled fact) and was an
 * un-normalized `z.string()`: since identity is sha*(JSON.stringify(value)),
 * `shell/bashrc` / `./shell/bashrc` / `shell//bashrc` / `shell/bashrc/` were FOUR
 * documents for one repo file. Normalization lives in the schema, so every writer
 * gets it — not just the CLI, which was the only client stripping anything.
 *
 * Links:
 *   Map of deviceId -> localPath
 *
 * A single entry in the repo can be mapped to different locations on different devices.
 */

import Document, { documentSchema } from '../Document.js';
import { z } from 'zod';
import { pathPattern, normalizeHomePlaceholder, deviceFileUrl, normalizeDotfileUrl, dotfileEntryPath } from '../../utils/path-helpers.js';

const DOCUMENT_SCHEMA_NAME = 'data/schema/dotfile';
const DOCUMENT_SCHEMA_VERSION = '3.0';

/*******************
 * Data Schema     *
 *******************/
const documentDataSchema = z
    .object({
        schema: z.string(),
        schemaVersion: z.string().optional(),

        data: z
            .object({
                // Primary identity. Accepts a full URI or a bare repo-relative
                // path (resolved to the workspace-local form) and NORMALIZES both,
                // so four spellings of one entry cannot become four documents.
                url: z.string().min(1).transform(normalizeDotfileUrl),

                // Whether this dotfile entry points to a file or folder in the repo.
                type: z.enum(['file', 'folder']),

                // Per-device mappings: deviceId -> localPath
                // localPath may contain $HOME or other placeholders resolved at runtime.
                links: z.record(
                    z.string(), // deviceId
                    z.string().regex(pathPattern, {
                        message: 'localPath must be an absolute path or contain a placeholder',
                    }).transform(normalizeHomePlaceholder),
                ).default({}),

                description: z.string().optional(),
                tags: z.array(z.string()).optional(),
                priority: z.number().int().default(0),
            })
            .passthrough(),

        metadata: z.object({}).passthrough().optional(),
    });

/*******************
 * Dotfile class   *
 *******************/
export default class Dotfile extends Document {

    // Index configuration is SCHEMA-level, resolved by Document from this
    // static. Never stored on the row (see documentSchema).
    // Record fields that MERGE with the stored document instead of replacing it
    // when a write resolves to an existing doc by checksum. Declared by the
    // schema so the engine stays schema-agnostic (same pattern as indexOptions).
    //
    // `links` needs it because a dotfile's identity is its repo entry, not its
    // device map: a client POSTing only its OWN device's mapping would otherwise
    // wipe every other device's. The CLI compensated client-side with
    // fetch-and-merge; a direct POST had no such protection.
    static mergeOnDedupe = ['data.links'];

    static indexOptions = {
        ftsSearchFields: ['locationUrls', 'data.url', 'data.description'],
        vectorEmbeddingFields: ['locationUrls', 'data.url'],
        checksumFields: ['data.url'],
    };

    constructor(options = {}) {
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;

        super(options);

        if (!this.data.links) { this.data.links = {}; }
        if (!Array.isArray(this.data.tags)) { this.data.tags = []; }

        // Derive locations from the per-device link map.
        // Always recomputed from data so toJSON() stays in sync.
        this.locations = this.deriveLocations();
    }

    /* --------------------
     * Getters
     * ------------------*/

    get url() { return this.data.url; }
    /** Repo-relative entry path — what a client joins onto its local checkout. */
    get entryPath() { return dotfileEntryPath(this.data.url); }
    get type() { return this.data.type; }
    get links() { return this.data.links; }
    get description() { return this.data.description; }
    get tags() { return this.data.tags; }

    /* --------------------
     * Link Management
     * ------------------*/

    addLink(deviceId, localPath) {
        if (!deviceId || !localPath) { return this; }
        this.data.links[deviceId] = normalizeHomePlaceholder(localPath);
        this.locations = this.deriveLocations();
        this.updatedAt = new Date().toISOString();
        return this;
    }

    removeLink(deviceId) {
        if (!deviceId) { return this; }
        delete this.data.links[deviceId];
        this.locations = this.deriveLocations();
        this.updatedAt = new Date().toISOString();
        return this;
    }

    getLink(deviceId) {
        return this.data.links[deviceId];
    }

    hasLink(deviceId) {
        return Object.prototype.hasOwnProperty.call(this.data.links, deviceId);
    }

    /* --------------------
     * Utility helpers
     * ------------------*/

    /* --------------------
     * Static helpers
     * ------------------*/

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        // validateData throws on invalid input and normalizes `data` (link paths →
        // $HOME). Construct from the full object so top-level fields (id, locations,
        // checksumArray, timestamps) survive a reparse — only `data` is replaced with
        // the normalized version.
        const transformed = this.validateData(data);
        return new Dotfile({ ...data, data: transformed.data });
    }

    static get dataSchema() { return documentDataSchema; }
    static get schema() { return documentSchema; }

    static validate(document) { return documentSchema.parse(document); }
    static validateData(docData) { return documentDataSchema.parse(docData); }

    /* --------------------
     * Private
     * ------------------*/

    deriveLocations() {
        // deviceId is encoded in the URL authority (file://<deviceId>/<localPath>).
        return Object.entries(this.data.links || {}).map(([deviceId, localPath]) => ({
            url: deviceFileUrl(deviceId, localPath),
        })).filter((l) => l.url !== null);
    }
}
