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

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/dotfile';
const DOCUMENT_SCHEMA_VERSION = '3.0';

// Regex allows:  /abs/path, ~/path, $HOME/path, {{HOME}}/path etc.
const pathPattern = /^(\{\{\s*[A-Za-z0-9_]+\s*\}\}|\$[A-Za-z0-9_]+|~)?[/A-Za-z0-9_.-]+$/;

// Normalize {{ home }} / {{ HOME }} / ~ to $HOME (nix-focused)
function normalizeHomePlaceholder(input) {
    if (typeof input !== 'string') { return input; }
    let out = input;
    out = out.replace(/^(\{\{\s*home\s*\}\})(?=\/|$)/i, '$HOME');
    out = out.replace(/^~(?=\/|$)/, '$HOME');
    return out;
}

/*******************
 * Data Schema     *
 *******************/
const documentDataSchema = z
    .object({
        schema: z.string(),
        schemaVersion: z.string().optional(),

        data: z
            .object({
                // Relative path inside the dotfiles repository (e.g., shell/bashrc)
                // This is the primary identifier for the dotfile content.
                repoPath: z.string().min(1),

                // Type of mapping target in the repository
                type: z.enum(['file', 'folder']),

                // Mappings per device: deviceId -> localPath
                links: z.record(
                    z.string(), // Device ID / Name
                    z.string().regex(pathPattern, {
                        message: 'localPath must be an absolute path or contain a placeholder'
                    }).transform(normalizeHomePlaceholder)
                ).default({}),

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
        // Attach schema name/version before super
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;

        // Index configuration (before super)
        options.indexOptions = {
            ...(options.indexOptions || {}),
            // Search in repoPath and all mapped local paths
            ftsSearchFields: ['allLocalPaths', 'data.repoPath'],
            vectorEmbeddingFields: ['allLocalPaths', 'data.repoPath'],
            // Uniqueness: repoPath (one config per file in repo)
            checksumFields: ['data.repoPath'],
        };

        super(options);

        // Ensure links object exists
        if (!this.data.links) {
            this.data.links = {};
        }
    }

    /* --------------------
     * Getters / Setters
     * ------------------*/

    get repoPath() { return this.data.repoPath; }
    get type() { return this.data.type; }
    get links() { return this.data.links; }

    // Computed property for search indexing
    get allLocalPaths() {
        return Object.values(this.data.links).join(' ');
    }

    /* --------------------
     * Link Management
     * ------------------*/

    addLink(deviceId, localPath) {
        if (!deviceId || !localPath) { return; }
        this.data.links[deviceId] = normalizeHomePlaceholder(localPath);
        this.updatedAt = new Date().toISOString();
    }

    removeLink(deviceId) {
        if (!deviceId) { return; }
        delete this.data.links[deviceId];
        this.updatedAt = new Date().toISOString();
    }

    getLink(deviceId) {
        return this.data.links[deviceId];
    }

    /* --------------------
     * Utility helpers
     * ------------------*/

    /*
     * Check if this dotfile conflicts with another.
     * Conflict means:
     * 1. Same repoPath (already handled by checksum, but good to check)
     * 2. OR Same localPath on the SAME device.
     */
    conflictsWith(other) {
        if (!other) { return false; }
        if (this.repoPath === other.repoPath) { return true; }

        // Check for overlapping local paths on same devices
        const myDevices = Object.keys(this.links);
        for (const deviceId of myDevices) {
            const otherPath = other.getLink(deviceId);
            if (otherPath && otherPath === this.links[deviceId]) {
                return true;
            }
        }
        return false;
    }

    getDisplayName() {
        const count = Object.keys(this.links).length;
        return `${this.repoPath} (${count} links)`;
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
                links: 'Record<string, string>',
            },
        };
    }

    static validate(document) { return documentSchema.parse(document); }
    static validateData(docData) { return documentDataSchema.parse(docData); }
}
