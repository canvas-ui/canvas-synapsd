'use strict';

/*
 * Application abstraction
 * -----------------------
 * Tracks what applications are available across devices and how to (re)install them.
 *
 * Identity: `data.appId` (stable across devices)
 * Presence: `data.installs` map of deviceId -> install state (status/path/version/lastSeen/…)
 *
 * Types:
 * - appimage: installable via URL (optionally checksum)
 * - flatpak: installable via ref/remote
 * - snap: installable via name/channel
 * - portable: installable via URL or referenced repoPath (or device-local path)
 * - system: provided by OS / package manager (usually not portable across devices)
 * - local: arbitrary local app (generally not installable)
 */

import Document, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/application';
const DOCUMENT_SCHEMA_VERSION = '1.0';

const applicationTypeSchema = z.enum(['appimage', 'flatpak', 'snap', 'portable', 'system', 'local']);
const installStatusSchema = z.enum(['available', 'missing', 'installing', 'error', 'unknown']);

// Regex allows:  /abs/path, ~/path, $HOME/path, {{HOME}}/path etc. (nix-focused)
const pathPattern = /^(\{\{\s*[A-Za-z0-9_]+\s*\}\}|\$[A-Za-z0-9_]+|~)?[/A-Za-z0-9_.-]+$/;

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

const installStateSchema = z.object({
    status: installStatusSchema.default('unknown'),
    version: z.string().optional(),
    path: z
        .string()
        .regex(pathPattern, { message: 'path must be an absolute path or contain a placeholder' })
        .transform(normalizeHomePlaceholder)
        .optional(),
    lastSeen: z.string().datetime().optional(),
    lastCheckedAt: z.string().datetime().optional(),
    error: z.string().optional(),
}).passthrough();

const applicationPayloadSchema = Document.extendDataSchema(
    z.object({
        // Stable identifier (primary identity) e.g. "com.spotify.Client" or "canvas:terminal"
        appId: z.string().min(1),
        name: z.string().min(1).optional(),
        type: applicationTypeSchema,

        // Type-specific installation metadata (kept intentionally flexible)
        // Common keys by convention:
        // - appimage: { url, sha256?, filename? }
        // - flatpak: { ref, remote? }
        // - snap: { name, channel? }
        // - portable: { url? , repoPath? , path? , sha256? }
        // - system/local: optional
        source: z.record(z.any()).optional(),

        // Per-device presence / install state
        installs: z.record(z.string(), installStateSchema).default({}),

        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
    }).passthrough(),
).superRefine((doc, ctx) => {
    const data = doc?.data || {};
    const source = data.source || {};

    const requireSourceKey = (key, message) => {
        const ok = typeof source?.[key] === 'string' && source[key].trim().length > 0;
        if (!ok) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['data', 'source', key],
                message,
            });
        }
    };

    if (data.type === 'appimage') {
        requireSourceKey('url', 'appimage applications require data.source.url');
    }
    if (data.type === 'flatpak') {
        requireSourceKey('ref', 'flatpak applications require data.source.ref');
    }
    if (data.type === 'snap') {
        requireSourceKey('name', 'snap applications require data.source.name');
    }
    if (data.type === 'portable') {
        const hasAny = Boolean(source?.repoPath || source?.url || source?.path);
        if (!hasAny) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['data', 'source'],
                message: 'portable applications require one of data.source.repoPath, data.source.url, or data.source.path',
            });
        }
    }
});

const defaultIndexOptions = {
    ftsSearchFields: ['data.appId', 'data.name', 'data.type', 'allInstallPaths'],
    vectorEmbeddingFields: ['data.name', 'data.appId', 'allInstallPaths'],
    checksumFields: ['data.appId'],
};

/*******************
 * Application     *
 *******************/

export default class Application extends Document {
    constructor(options = {}) {
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;
        options.indexOptions = {
            ...defaultIndexOptions,
            ...(options.indexOptions || {}),
        };

        super(options);

        if (!this.data.installs) { this.data.installs = {}; }
        if (!Array.isArray(this.data.tags)) { this.data.tags = []; }
    }

    /* --------------------
     * Getters / Setters
     * ------------------*/

    get appId() { return this.data.appId; }
    get name() { return this.data.name; }
    get type() { return this.data.type; }
    get source() { return this.data.source; }
    get installs() { return this.data.installs; }

    // Computed property for search indexing
    get allInstallPaths() {
        return Object.values(this.data.installs || {})
            .map((s) => s?.path)
            .filter(Boolean)
            .join(' ');
    }

    /* --------------------
     * Install State
     * ------------------*/

    setInstall(deviceId, installState = {}) {
        if (!deviceId) { return this; }
        const parsed = installStateSchema.parse(installState);
        this.data.installs[deviceId] = parsed;
        this.updatedAt = new Date().toISOString();
        return this;
    }

    removeInstall(deviceId) {
        if (!deviceId) { return this; }
        delete this.data.installs[deviceId];
        this.updatedAt = new Date().toISOString();
        return this;
    }

    getInstall(deviceId) {
        if (!deviceId) { return undefined; }
        return this.data.installs[deviceId];
    }

    isAvailableOn(deviceId) {
        const state = this.getInstall(deviceId);
        return state?.status === 'available';
    }

    markAvailable(deviceId, { path, version, lastSeen } = {}) {
        const current = this.getInstall(deviceId) || {};
        return this.setInstall(deviceId, {
            ...current,
            status: 'available',
            path: path ?? current.path,
            version: version ?? current.version,
            lastSeen: lastSeen ?? new Date().toISOString(),
        });
    }

    markMissing(deviceId, { lastCheckedAt } = {}) {
        const current = this.getInstall(deviceId) || {};
        return this.setInstall(deviceId, {
            ...current,
            status: 'missing',
            lastCheckedAt: lastCheckedAt ?? new Date().toISOString(),
        });
    }

    /* --------------------
     * Static helpers
     * ------------------*/

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        const transformed = this.validateData(data);
        return new Application(transformed);
    }

    static get dataSchema() { return applicationPayloadSchema; }
    static get schema() { return documentSchema; }

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                appId: 'string',
                name: 'string',
                type: '"appimage"|"flatpak"|"snap"|"portable"|"system"|"local"',
                source: 'Record<string, any>',
                installs: 'Record<string, { status: string, path?: string, version?: string }>',
            },
        };
    }

    static validate(document) { return documentSchema.parse(document); }
    static validateData(documentData) { return applicationPayloadSchema.parse(documentData); }
}

