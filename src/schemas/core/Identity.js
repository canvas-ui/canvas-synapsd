'use strict';

import Document, { documentSchema as baseDocumentSchema } from '../Document.js';
import { z } from 'zod';

const DOCUMENT_SCHEMA_NAME = 'data/schema/identity';
export const IDENTITY_SCHEMA = DOCUMENT_SCHEMA_NAME;
const DOCUMENT_SCHEMA_VERSION = '3.0';
export const IDENTITY_TYPES = ['person', 'organization', 'service', 'bot'];

/**
 * One external identifier for this identity (an email address, a Slack user id,
 * a GPG fingerprint). NOT to be confused with the Identity entity itself — an
 * Identity HAS identifiers, it is not a list of them.
 */
const identifierSchema = z.object({
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

const identityPayloadSchema = Document.extendDataSchema(
    z.object({
        displayName: z.string(),
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
        identifiers: z.array(identifierSchema).optional(),
        channels: z.array(channelSchema).optional(),
        organizations: z.array(organizationSchema).optional(),
        links: z.array(linkSchema).optional(),
        tags: z.array(z.string()).optional(),
        properties: z.record(z.any()).optional(),
        lastInteractionAt: z.string().datetime().optional(),
    }).passthrough(),
);

const defaultIndexOptions = {
    ftsSearchFields: ['data.displayName', 'data.primaryEmail', 'data.identifiers', 'data.channels', 'data.links'],
    // `data.tags` dropped from the embedding input: Contact was the ONLY schema
    // embedding it, and tags move to root `features[]` in the D2 work later this
    // phase. At 0 documents there is no re-embed cost, so taking it out now stops
    // that move from silently forking every identity's vector.
    vectorEmbeddingFields: ['data.displayName'],
    checksumFields: ['data.displayName', 'data.identifiers', 'data.channels'],
};

export default class Identity extends Document {

    // Index configuration is SCHEMA-level, resolved by Document from this
    // static. Never stored on the row (see documentSchema).
    static indexOptions = defaultIndexOptions;

    constructor(options = {}) {
        const schema = options.schema || DOCUMENT_SCHEMA_NAME;
        const leaf = schema === DOCUMENT_SCHEMA_NAME
            ? null
            : (schema.startsWith(`${DOCUMENT_SCHEMA_NAME}/`) ? schema.slice(DOCUMENT_SCHEMA_NAME.length + 1) : false);
        if (leaf === false || (leaf && !IDENTITY_TYPES.includes(leaf))) {
            throw new Error(`Identity schema must be ${DOCUMENT_SCHEMA_NAME} or ${DOCUMENT_SCHEMA_NAME}/{${IDENTITY_TYPES.join('|')}}`);
        }
        options.schema = schema;
        options.schemaVersion = DOCUMENT_SCHEMA_VERSION;

        super(options);

        this.#ensureArrays(['identifiers', 'channels', 'organizations', 'links', 'tags']);
    }

    // ----- Getters / Setters -----

    get type() {
        return this.schema === DOCUMENT_SCHEMA_NAME
            ? null
            : this.schema.slice(DOCUMENT_SCHEMA_NAME.length + 1);
    }

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

    get primaryIdentifier() {
        return this.data.identifiers.find((identity) => identity.primary) || this.data.identifiers[0] || null;
    }

    // ----- Identifier management -----

    addIdentifier(identifierInput) {
        if (!identifierInput) { return this; }
        const identifier = identifierSchema.parse(identifierInput);
        const index = this.#upsert('identifiers', identifier, (existing) => (
            existing.type === identifier.type &&
            existing.identifier === identifier.identifier &&
            (existing.provider ?? null) === (identifier.provider ?? null)
        ));
        if (identifier.primary) {
            this.#enforceSinglePrimary('identifiers', index);
        }
        return this;
    }

    removeIdentifier(match) {
        if (!match) { return this; }
        this.data.identifiers = this.data.identifiers.filter((identifier) => !this.#match(identifier, match));
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
        return new Identity(data);
    }

    static get dataSchema() {
        return identityPayloadSchema;
    }

    static get schema() {
        return baseDocumentSchema;
    }

    static validate(document) {
        return baseDocumentSchema.parse(document);
    }

    static validateData(documentData) {
        return identityPayloadSchema.parse(documentData);
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
