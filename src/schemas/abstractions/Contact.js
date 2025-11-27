'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../BaseDocument.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/abstraction/contact';
const DOCUMENT_SCHEMA_VERSION = '1.0';

const identitySchema = z.object({
    type: z.string(),
    provider: z.string().optional(),
    identifier: z.string(),
    label: z.string().optional(),
    primary: z.boolean().optional(),
    verifiedAt: z.string().datetime().optional(),
    metadata: z.record(z.any()).optional(),
}).strict();

const channelSchema = z.object({
    kind: z.string(),
    value: z.string(),
    label: z.string().optional(),
    platform: z.string().optional(),
    primary: z.boolean().optional(),
    metadata: z.record(z.any()).optional(),
}).strict();

const linkSchema = z.object({
    type: z.string(),
    target: z.string(),
    schema: z.string().optional(),
    contextPath: z.string().optional(),
    subject: z.string().optional(),
    metadata: z.record(z.any()).optional(),
}).strict();

const organizationSchema = z.object({
    name: z.string(),
    role: z.string().optional(),
    metadata: z.record(z.any()).optional(),
}).strict();

const contactPayloadSchema = Document.extendDataSchema(
    z.object({
        displayName: z.string(),
        kind: z.enum(['person', 'team', 'integration', 'service']).optional(),
        primaryEmail: z.string().email().optional(),
        name: z.object({
            given: z.string().optional(),
            family: z.string().optional(),
            middle: z.string().optional(),
            prefix: z.string().optional(),
            suffix: z.string().optional(),
        }).optional(),
        timezone: z.string().optional(),
        locale: z.string().optional(),
        identities: z.array(identitySchema).optional(),
        channels: z.array(channelSchema).optional(),
        organizations: z.array(organizationSchema).optional(),
        links: z.array(linkSchema).optional(),
        tags: z.array(z.string()).optional(),
        properties: z.record(z.any()).optional(),
        lastInteractionAt: z.string().datetime().optional(),
    }).passthrough(),
);

const defaultIndexOptions = {
    ftsSearchFields: ['data.displayName', 'data.primaryEmail', 'data.identities', 'data.channels', 'data.links'],
    vectorEmbeddingFields: ['data.displayName', 'data.tags'],
    checksumFields: ['data.displayName', 'data.identities', 'data.channels'],
};

export default class Contact extends Document {

    constructor(options = {}) {
        options.schema = options.schema || DOCUMENT_SCHEMA_NAME;
        options.schemaVersion = options.schemaVersion || DOCUMENT_SCHEMA_VERSION;
        options.indexOptions = {
            ...defaultIndexOptions,
            ...(options.indexOptions || {}),
        };

        super(options);

        this.#ensureArrays(['identities', 'channels', 'organizations', 'links', 'tags']);
    }

    // ----- Getters / Setters -----

    get primaryEmail() {
        if (this.data.primaryEmail) {
            return this.data.primaryEmail;
        }
        const primaryChannel = this.data.channels.find((channel) => channel.kind === 'email' && channel.primary);
        return primaryChannel?.value ?? null;
    }

    set primaryEmail(email) {
        if (!email) {
            this.data.primaryEmail = undefined;
            return;
        }
        const normalized = email.trim().toLowerCase();
        this.data.primaryEmail = normalized;
        this.upsertChannel({
            kind: 'email',
            value: normalized,
            primary: true,
        });
    }

    get primaryIdentity() {
        return this.data.identities.find((identity) => identity.primary) || this.data.identities[0] || null;
    }

    // ----- Identity management -----

    addIdentity(identityInput) {
        if (!identityInput) { return this; }
        const identity = identitySchema.parse(identityInput);
        const index = this.#upsert('identities', identity, (existing) => (
            existing.type === identity.type &&
            existing.identifier === identity.identifier &&
            (existing.provider ?? null) === (identity.provider ?? null)
        ));
        if (identity.primary) {
            this.#enforceSinglePrimary('identities', index);
        }
        return this;
    }

    removeIdentity(match) {
        if (!match) { return this; }
        this.data.identities = this.data.identities.filter((identity) => !this.#match(identity, match));
        return this;
    }

    // ----- Channel management -----

    upsertChannel(channelInput) {
        if (!channelInput) { return this; }
        const channel = channelSchema.parse(channelInput);
        const index = this.#upsert('channels', channel, (existing) => (
            existing.kind === channel.kind &&
            existing.value === channel.value &&
            (existing.platform ?? null) === (channel.platform ?? null)
        ));
        if (channel.primary) {
            this.#enforceSinglePrimary('channels', index, (item) => item.kind === channel.kind);
        }
        return this;
    }

    removeChannel(match) {
        if (!match) { return this; }
        this.data.channels = this.data.channels.filter((channel) => !this.#match(channel, match));
        return this;
    }

    // ----- Link management -----

    linkResource(linkInput) {
        if (!linkInput) { return this; }
        const link = linkSchema.parse(linkInput);
        this.#upsert('links', link, (existing) => existing.type === link.type && existing.target === link.target);
        return this;
    }

    unlinkResource(match) {
        if (!match) { return this; }
        this.data.links = this.data.links.filter((link) => !this.#match(link, match));
        return this;
    }

    // ----- Static helpers -----

    static fromData(data) {
        data.schema = DOCUMENT_SCHEMA_NAME;
        return new Contact(data);
    }

    static get dataSchema() {
        return contactPayloadSchema;
    }

    static get schema() {
        return baseDocumentSchema;
    }

    static get jsonSchema() {
        return {
            schema: DOCUMENT_SCHEMA_NAME,
            data: {
                displayName: 'string',
                primaryEmail: 'string',
            },
        };
    }

    static validate(document) {
        return baseDocumentSchema.parse(document);
    }

    static validateData(documentData) {
        return contactPayloadSchema.parse(documentData);
    }

    // ----- Private helpers -----

    #ensureArrays(fieldNames) {
        fieldNames.forEach((field) => {
            if (!Array.isArray(this.data[field])) {
                this.data[field] = [];
            }
        });
    }

    #upsert(field, item, matcher) {
        const collection = this.data[field];
        const index = collection.findIndex(matcher);
        if (index === -1) {
            collection.push(item);
            return collection.length - 1;
        }
        collection[index] = {
            ...collection[index],
            ...item,
        };
        return index;
    }

    #enforceSinglePrimary(field, primaryIndex, filter = null) {
        const collection = this.data[field];
        if (primaryIndex === undefined || primaryIndex === null) { return; }
        collection.forEach((entry, idx) => {
            if (filter && !filter(entry)) { return; }
            entry.primary = idx === primaryIndex;
        });
    }

    #match(entry, matcher) {
        if (typeof matcher === 'function') {
            return matcher(entry);
        }
        return Object.entries(matcher).every(([key, value]) => entry[key] === value);
    }
}
