'use strict';

/*
 * Dotfile abstraction
 * -------------------
 * Describes a mapping between a *local* path (file or directory on any
 * machine) and a path inside the dot-files Git repository that lives
 * under ~/.canvas/data/{user@remote}/{workspace}/dotfiles/…
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
const DOCUMENT_SCHEMA_VERSION = '3.0';

// Regex allows:  /abs/path, ~/path, $HOME/path, {{HOME}}/path etc.
const pathPattern = /^(\{\{\s*[A-Za-z0-9_]+\s*\}\}|\$[A-Za-z0-9_]+|~)?[\/A-Za-z0-9_.-]+$/;

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
                }),

                // Full URL of the dotfiles repository (e.g., http://user@host:port/rest/v2/workspaces/<ws>/dotfiles/git)
                repoUrl: z.string().url(),
                // Path inside the dotfiles repository (e.g., work/mbag/wallpaper.jpg)
                repoPath: z.string().min(1),

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
            ...options.indexOptions,
            ftsSearchFields: ['data.localPath', 'data.repoUrl', 'data.repoPath'],
            vectorEmbeddingFields: ['data.localPath', 'data.repoUrl', 'data.repoPath'],
            // Uniqueness: localPath + repoUrl + repoPath
            checksumFields: ['data.localPath', 'data.repoUrl', 'data.repoPath'],
        };

        super(options);
    }

    /* --------------------
     * Convenience getters
     * ------------------*/
    get localPath() { return this.data.localPath; }
    get repoUrl() { return this.data.repoUrl; }
    get repoPath() { return this.data.repoPath; }
    get backupPath() { return this.data.backupPath; }

    /* --------------------
     * Utility helpers
     * ------------------*/

    setBackup(backupPath) {
        if (!backupPath) throw new Error('backupPath required');
        this.data.backupPath = backupPath;
        this.data.backupCreatedAt = new Date().toISOString();
        this.updatedAt = this.data.backupCreatedAt;
    }

    /*
     * Two Dotfile docs conflict if they share either endpoint of the mapping.
     */
    conflictsWith(other) {
        if (!other) return false;
        return (
            this.localPath === other.localPath ||
            (this.repoUrl === other.repoUrl && this.repoPath === other.repoPath)
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
                repoUrl: 'string',
                repoPath: 'string',
                backupPath: 'string?',
            },
        };
    }

    static validate(document) { return documentSchema.parse(document); }
    static validateData(docData) { return documentDataSchema.parse(docData); }
}
