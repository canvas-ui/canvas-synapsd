'use strict';

import { type } from 'os';
/*
 * Dotfile abstraction
 * -------------------
 * Describes a mapping between a local path (file or folder) and a path inside
 * the workspace dotfiles repository (relative to the repo root):
 *   ~/.canvas/data/{user@remote}/workspaces/{workspace}/dotfiles/…
 *
 * Uniqueness is guaranteed through the combination of
 *     localPath + repoUrl + repoPath
 * which we feed into the checksum fields so that SynapsD stores at most one
 * instance of a given mapping.
 *
 * Per-device activation is not stored inside the document itself – a client
 * simply OR-filters the bitmap feature  "client/device/id/<deviceId>" together
 * with the document bitmap when it wants to operate on the subset that is
 * currently active on the local machine.
 */

import Document, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/dotfile';
const DOCUMENT_SCHEMA_VERSION = '2.0';

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
                // Mandatory
                localPath: z.string().regex(pathPattern, {
                    message:
                        'localPath must be an absolute path or contain a placeholder such as {{HOME}} or $HOME',
                }).transform(normalizeHomePlaceholder),

                // Relative path inside the dotfiles repository (e.g., shell/bashrc)
                repoPath: z.string().min(1),

                // Type of mapping target in the repository
                type: z.enum(['file', 'folder']),

                encryption: z.object({
                    enabled: z.boolean(),
                }).optional(),

                // Optional
                backupPath: z.string().optional(),
                backupCreatedAt: z.string().datetime().optional(),

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
            ftsSearchFields: ['data.localPath', 'data.repoPath'],
            vectorEmbeddingFields: ['data.localPath', 'data.repoPath'],
            // Uniqueness: localPath + repoPath (documents are per workspace)
            checksumFields: ['data.localPath', 'data.repoPath'],
        };

        super(options);
        // Defensive normalization in case upstream skipped schema transforms
        if (this.data && typeof this.data.localPath === 'string') {
            this.data.localPath = normalizeHomePlaceholder(this.data.localPath);
        }
    }

    /* --------------------
     * Convenience getters
     * ------------------*/
    get localPath() { return this.data.localPath; }
    get repoPath() { return this.data.repoPath; }
    get type() { return this.data.type; }
    get backupPath() { return this.data.backupPath; }

    /* --------------------
     * Utility helpers
     * ------------------*/

    setBackup(backupPath) {
        if (!backupPath) {throw new Error('backupPath required');}
        this.data.backupPath = backupPath;
        this.data.backupCreatedAt = new Date().toISOString();
        this.updatedAt = this.data.backupCreatedAt;
    }

    /*
     * Two Dotfile docs conflict if they share either endpoint of the mapping.
     */
    conflictsWith(other) {
        if (!other) {return false;}
        return (
            this.localPath === other.localPath || this.repoPath === other.repoPath
        );
    }

    getDisplayName() {
        const right = this.repoPath;
        return `${this.localPath} ↔ ${right}`;
    }

    /* --------------------
     * Static helpers
     * ------------------*/
    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Dotfile(data);
    }

    static get dataSchema() { return documentDataSchema; }
    static get schema() { return documentSchema; }

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                localPath: 'string',
                repoPath: 'string',
                type: '"file"|"folder"',
                backupPath: 'string?',
            },
        };
    }

    static validate(document) { return documentSchema.parse(document); }
    static validateData(docData) { return documentDataSchema.parse(docData); }
}
