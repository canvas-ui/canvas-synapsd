'use strict';

/*
 * Application abstraction
 * -----------------------
 * Tracks what applications are available across devices and how to (re)install them.
 *
 * Identity: `data.appId` (stable across devices, e.g. "com.spotify.Client")
 * Presence: `data.installs` — map of deviceId -> install state
 *
 * Types:
 * - appimage  : portable single-file executable, installed via URL (± checksum)
 * - flatpak   : installed via ref/remote
 * - snap      : installed via name/channel
 * - portable  : binary/script installed via URL, repoPath, or device-local path
 * - system    : provided by the OS / package manager (not portable across devices)
 * - local     : arbitrary local app, generally not reinstallable remotely
 */

import Document, { documentSchema } from '../BaseDocument.js';
import { z } from 'zod';
import { pathPattern, normalizeHomePlaceholder, deviceFileUrl } from '../../utils/path-helpers.js';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/application';
const DOCUMENT_SCHEMA_VERSION = '1.1';

const applicationTypeSchema = z.enum(['appimage', 'flatpak', 'snap', 'portable', 'system', 'local']);
const installStatusSchema = z.enum(['available', 'missing', 'installing', 'error', 'unknown']);

/*******************
 * Sub-schemas     *
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
        // Stable identifier (primary identity)
        appId: z.string().min(1),
        name: z.string().min(1).optional(),
        type: applicationTypeSchema,
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),

        // Type-specific installation metadata (kept intentionally flexible).
        // Common keys by convention:
        //   appimage  : { url, sha256?, filename? }
        //   flatpak   : { ref, remote? }
        //   snap      : { name, channel? }
        //   portable  : { url?, repoPath?, path?, sha256? }
        //   system / local : optional
        source: z.record(z.any()).optional(),

        // Per-device install state: deviceId -> installState
        installs: z.record(z.string(), installStateSchema).default({}),
    }).passthrough(),
).superRefine((doc, ctx) => {
    const data = doc?.data || {};
    const source = data.source || {};

    const requireSourceKey = (key, message) => {
        if (typeof source?.[key] !== 'string' || !source[key].trim()) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['data', 'source', key], message });
        }
    };

    if (data.type === 'appimage') { requireSourceKey('url', 'appimage requires data.source.url'); }
    if (data.type === 'flatpak')  { requireSourceKey('ref', 'flatpak requires data.source.ref'); }
    if (data.type === 'snap')     { requireSourceKey('name', 'snap requires data.source.name'); }
    if (data.type === 'portable') {
        if (!source?.repoPath && !source?.url && !source?.path) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['data', 'source'],
                message: 'portable requires one of data.source.repoPath, data.source.url, or data.source.path',
            });
        }
    }
});

/*******************
 * Application     *
 *******************/

export default class Application extends Document {
    constructor(options = {}) {
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;
        options.indexOptions = {
            ftsSearchFields: ['data.appId', 'data.name', 'data.type', 'data.description', 'locationUrls'],
            vectorEmbeddingFields: ['data.name', 'data.appId', 'locationUrls'],
            checksumFields: ['data.appId'],
            ...(options.indexOptions || {}),
        };

        super(options);

        if (!this.data.installs) { this.data.installs = {}; }
        if (!Array.isArray(this.data.tags)) { this.data.tags = []; }

        // Derive locations from available installs (and source URL if present).
        // Always recomputed from data so toJSON() stays in sync.
        this.locations = this.#buildLocations();
    }

    /* --------------------
     * Getters
     * ------------------*/

    get appId() { return this.data.appId; }
    get name() { return this.data.name; }
    get type() { return this.data.type; }
    get description() { return this.data.description; }
    get tags() { return this.data.tags; }
    get source() { return this.data.source; }
    get installs() { return this.data.installs; }

    /* --------------------
     * Install State
     * ------------------*/

    setInstall(deviceId, installState = {}) {
        if (!deviceId) { return this; }
        this.data.installs[deviceId] = installStateSchema.parse(installState);
        this.locations = this.#buildLocations();
        this.updatedAt = new Date().toISOString();
        return this;
    }

    removeInstall(deviceId) {
        if (!deviceId) { return this; }
        delete this.data.installs[deviceId];
        this.locations = this.#buildLocations();
        this.updatedAt = new Date().toISOString();
        return this;
    }

    getInstall(deviceId) {
        if (!deviceId) { return undefined; }
        return this.data.installs[deviceId];
    }

    isAvailableOn(deviceId) {
        return this.getInstall(deviceId)?.status === 'available';
    }

    /** Returns deviceIds where the app is available. */
    listInstalledDevices() {
        return Object.entries(this.data.installs)
            .filter(([, state]) => state?.status === 'available')
            .map(([deviceId]) => deviceId);
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
                description: 'string',
                tags: 'string[]',
                source: 'Record<string, any>',
                installs: 'Record<deviceId, { status: string, path?: string, version?: string }>',
            },
        };
    }

    static validate(document) { return documentSchema.parse(document); }
    static validateData(documentData) { return applicationPayloadSchema.parse(documentData); }

    /* --------------------
     * Private
     * ------------------*/

    #buildLocations() {
        const locations = [];

        // One location entry per device where the app is installed
        for (const [deviceId, state] of Object.entries(this.data.installs || {})) {
            if (state?.path) {
                locations.push({
                    url: deviceFileUrl(deviceId, state.path),
                    metadata: { deviceId, status: state.status },
                });
            }
        }

        // Source URL as a location entry (for reinstall/discovery)
        const sourceUrl = this.data.source?.url;
        if (typeof sourceUrl === 'string' && sourceUrl.trim()) {
            locations.push({ url: sourceUrl, metadata: { type: 'source' } });
        }

        return locations.filter((l) => l.url !== null);
    }
}
