'use strict';

/*
 * Dotfile abstraction
 * -------------------
 * Describes a mapping between local paths (file or folder) on multiple devices
 * and a path inside the workspace dotfiles repository.
 *
 * Repository Path (source of truth):
 *   ~/.canvas/data/{user@remote}/workspaces/{workspace}/dotfiles/{repoPath}
 *
 * Links:
 *   Map of deviceId -> localPath
 *
 * Uniqueness is guaranteed by `repoPath` per workspace.
 * A single file in the repo can be mapped to different locations on different devices.
 */

import Document, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';
import { pathPattern, normalizeHomePlaceholder, deviceFileUrl } from '../../utils/path-helpers.js';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/dotfile';
const DOCUMENT_SCHEMA_VERSION = '3.1';

/*******************
 * Data Schema     *
 *******************/
const documentDataSchema = z
    .object({
        schema: z.string(),
        schemaVersion: z.string().optional(),

        data: z
            .object({
                // Relative path inside the dotfiles repository (e.g., shell/bashrc).
                // This is the primary identifier for the dotfile content.
                repoPath: z.string().min(1),

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

        metadata: z.object().optional(),
    });

/*******************
 * Dotfile class   *
 *******************/
export default class Dotfile extends Document {
    constructor(options = {}) {
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        options.indexOptions = {
            ...(options.indexOptions || {}),
            ftsSearchFields: ['locationUrls', 'data.repoPath', 'data.description'],
            vectorEmbeddingFields: ['locationUrls', 'data.repoPath'],
            checksumFields: ['data.repoPath'],
        };

        super(options);

        if (!this.data.links) { this.data.links = {}; }
        if (!Array.isArray(this.data.tags)) { this.data.tags = []; }

        // Derive locations from the per-device link map.
        // Always recomputed from data so toJSON() stays in sync.
        this.locations = this.#buildLocations();
    }

    /* --------------------
     * Getters
     * ------------------*/

    get repoPath() { return this.data.repoPath; }
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
        this.locations = this.#buildLocations();
        this.updatedAt = new Date().toISOString();
        return this;
    }

    removeLink(deviceId) {
        if (!deviceId) { return this; }
        delete this.data.links[deviceId];
        this.locations = this.#buildLocations();
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

    /**
     * Check if this dotfile conflicts with another.
     * Conflicts when:
     *  1. Same repoPath (duplicate)
     *  2. Same localPath on the same device
     */
    conflictsWith(other) {
        if (!other) { return false; }
        if (this.repoPath === other.repoPath) { return true; }

        for (const deviceId of Object.keys(this.links)) {
            const otherPath = other.getLink(deviceId);
            if (otherPath && otherPath === this.links[deviceId]) { return true; }
        }
        return false;
    }

    /* --------------------
     * Static helpers
     * ------------------*/

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        const transformed = this.validateData(data);
        return new Dotfile(transformed);
    }

    static get dataSchema() { return documentDataSchema; }
    static get schema() { return documentSchema; }

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                repoPath: 'string',
                type: '"file"|"folder"',
                links: 'Record<deviceId, localPath>',
                description: 'string',
                tags: 'string[]',
            },
        };
    }

    static validate(document) { return documentSchema.parse(document); }
    static validateData(docData) { return documentDataSchema.parse(docData); }

    /* --------------------
     * Private
     * ------------------*/

    #buildLocations() {
        return Object.entries(this.data.links || {}).map(([deviceId, localPath]) => ({
            url: deviceFileUrl(deviceId, localPath),
            metadata: { deviceId },
        })).filter((l) => l.url !== null);
    }
}
