'use strict';

// Base document — also the class registered for `data/schema/document`.
import Document from './Document.js';

// The Rev B old->new id map, re-exported here so consumers already importing the
// registry need no second import path.
export { SCHEMA_ID_RENAMES } from './rename-map.js';

// Core schemas — synapsd's own primitives (schemas/core/).
import Email from './core/Email.js';
import Event from './core/Event.js';
import File from './core/File.js';
import Identity from './core/Identity.js';
import Message from './core/Message.js';
import Task from './core/Task.js';
import Device from './core/Device.js';
import Application from './core/Application.js';

// App-level schemas (schemas/app/). These are NOT synapsd primitives — they
// belong to canvas-server and register through `registerSchema()`. They stay
// bundled here only until the parent lands its own registration; the folder and
// the `tier: 'app'` marker are what make that pending move greppable rather than
// folklore.
import Link from './app/Link.js';
import Note from './app/Note.js';
import Tab from './app/Tab.js';
import Dotfile from './app/Dotfile.js';

// Tree Abstractions
import Canvas from './internal/layers/Canvas.js';
import Context from './internal/layers/Context.js';
import Label from './internal/layers/Label.js';
import System from './internal/layers/System.js';
import Universe from './internal/layers/Universe.js';
import Workspace from './internal/layers/Workspace.js';
import Project from './internal/layers/Project.js';

/**
 * The CORE entity set — synapsd's own primitives. Ids are hierarchical
 * `data/schema/*` (Rev B, 2026-08-05): the id IS the axis, and a multi-segment id
 * ticks every ancestor segment (`data/schema/message/email` ticks
 * `data/schema/message` too — see schemaBitmapKeys in index.js).
 *
 * `subtypeField` names a per-document discriminator (`data.type`). It is resolved
 * by `resolveSubtype()` and indexed as a DERIVED SEGMENT of the schema id: an
 * Application doc with `data.type: 'flatpak'` also ticks
 * `data/schema/application/flatpak`. Register-vs-derive rule: a subtype that needs
 * its own validation or identity gets registered as its own id with a class
 * (message/email); a mere discriminator on one class stays derived (this field).
 * Consumers query both kinds of key identically.
 */
const CORE_SCHEMAS = {
    'data/schema/document': { SchemaClass: Document },
    'data/schema/file': { SchemaClass: File },
    'data/schema/message': { SchemaClass: Message },
    'data/schema/message/email': { SchemaClass: Email },
    'data/schema/event': { SchemaClass: Event, subtypeField: 'data.type' },
    'data/schema/task': { SchemaClass: Task },
    'data/schema/identity': { SchemaClass: Identity, subtypeField: 'data.type' },
    'data/schema/device': { SchemaClass: Device },
    'data/schema/application': { SchemaClass: Application, subtypeField: 'data.type' },
};

/**
 * App-level schemas, bundled pending the parent's own `registerSchema()` calls.
 * Registered exactly like a third-party schema would be — same code path, so the
 * eventual move is a deletion here, not a rewrite.
 */
const APP_SCHEMAS = {
    'data/schema/note': { SchemaClass: Note },
    'data/schema/tab': { SchemaClass: Tab },
    'data/schema/link': { SchemaClass: Link },
    'data/schema/dotfile': { SchemaClass: Dotfile, subtypeField: 'data.type' },
};

const INTERNAL_SCHEMAS = {
    // Tree Abstractions
    'internal/layers/canvas': Canvas,           // Can store context, feature and filter bitmaps + dashboard / UI layouts
    'internal/layers/context': Context,         // Default context layer(linked to a bitmap)
    'internal/layers/label': Label,             // Label only (no associated bitmaps)
    'internal/layers/system': System,           // System layers
    'internal/layers/universe': Universe,       // Root layer for a workspace
    'internal/layers/workspace': Workspace,     // "Mountpoint" to a workspace
    'internal/layers/project': Project,         // Project layer
};

export function isDocumentInstance(obj) {
    if (!obj || typeof obj !== 'object') {return false;}

    // Check for essential document properties
    return (
        obj.schema &&
        typeof obj.schema === 'string' &&
        obj.data !== undefined &&
        obj instanceof Document
    ) || false;
}

export function isDocumentData(obj) {
    if (!obj || typeof obj !== 'object') { return false; }

    // Check for minimal proto object properties (data must be a non-null object)
    return (
        obj.schema &&
        typeof obj.schema === 'string' &&
        obj.data != null && typeof obj.data === 'object' &&
        !(obj instanceof Document)
    );
}

/**
 * Schema registry singleton
 */

class SchemaRegistry {

    // schemaId -> { SchemaClass, tier, subtypeField?, indexOptions? }
    #entries = new Map();

    constructor() {
        this.#entries = this.#initSchemaRegistry();
    }

    /**
     * Register a schema at runtime.
     *
     * This is the API app-level consumers (canvas-server, and eventually third
     * parties) use instead of editing this file. Core ids are sealed: they are
     * synapsd's own primitives and re-pointing one at a foreign class would let a
     * consumer silently change what `data/schema/file` means for everyone.
     *
     * @param {string} schemaId          e.g. 'data/schema/note'
     * @param {Function} SchemaClass     a Document subclass
     * @param {object} [options]
     * @param {string} [options.subtypeField] dotted path to a per-document subtype
     *                                        discriminator, e.g. 'data.type'
     * @param {object} [options.indexOptions] fts/vector/checksum field lists
     * @returns {SchemaRegistry} this, for chaining
     */
    registerSchema(schemaId, SchemaClass, options = {}) {
        if (typeof schemaId !== 'string' || schemaId.trim() === '') {
            throw new Error('registerSchema: schemaId must be a non-empty string');
        }

        if (typeof SchemaClass !== 'function' || !(SchemaClass.prototype instanceof Document)) {
            throw new Error(`registerSchema: ${schemaId} must be registered with a Document subclass`);
        }

        if (CORE_SCHEMAS[schemaId]) {
            throw new Error(`registerSchema: ${schemaId} is a core schema and cannot be re-registered`);
        }

        if (options.subtypeField !== undefined && typeof options.subtypeField !== 'string') {
            throw new Error(`registerSchema: ${schemaId} subtypeField must be a dotted field path string`);
        }

        // `static indexOptions` on the class is the ONE source of truth — that is
        // what Document resolves from at construction time (it cannot import
        // this registry without a cycle). Registering with indexOptions therefore
        // writes the static rather than storing a parallel copy that would look
        // authoritative while affecting nothing.
        if (options.indexOptions) {
            SchemaClass.indexOptions = options.indexOptions;
        }

        this.#entries.set(schemaId, {
            SchemaClass,
            tier: 'app',
            subtypeField: options.subtypeField,
        });

        return this;
    }

    /**
     * Unregister an app-level schema. Core schemas cannot be removed.
     * @param {string} schemaId
     * @returns {boolean} true if a schema was removed
     */
    unregisterSchema(schemaId) {
        if (CORE_SCHEMAS[schemaId]) {
            throw new Error(`unregisterSchema: ${schemaId} is a core schema and cannot be removed`);
        }
        return this.#entries.delete(schemaId);
    }

    /**
     * Get schema class by ID
     * @param {string} schemaId Schema identifier
     * @returns {Class} Schema class
     * @throws {Error} If schema is not found
     */
    getSchema(schemaId) {
        return this.getSchemaEntry(schemaId).SchemaClass;
    }

    /**
     * Get the full registration record — the shape ingest reads `subtypeField`
     * and `indexOptions` from, so it never reads them off the row.
     * @param {string} schemaId Schema identifier
     * @returns {object} Registration entry
     * @throws {Error} If schema is not found
     */
    getSchemaEntry(schemaId) {
        const entry = this.#entries.get(schemaId);
        if (!entry) {
            // Exact-match only, deliberately: a derived subtype key
            // (data/schema/application/flatpak) is a real BITMAP key but not a
            // schema id — resolving it here to the parent would let an unknown
            // or mistyped subtype construct and validate as the parent class,
            // silently. Name the real schema instead of guessing; callers that
            // legitimately hold a bitmap key use resolveSchemaId().
            const ancestor = this.resolveSchemaId(schemaId);
            if (ancestor && ancestor !== schemaId) {
                throw new Error(
                    `${schemaId} is a derived subtype bitmap key, not a schema id — the schema is ${ancestor}`,
                );
            }
            throw new Error(`Schema not found: ${schemaId}`);
        }
        // Read `indexOptions` through to the class static rather than caching a
        // copy here: it is resolved from the class at construction time, and a
        // second stored copy could drift from what documents actually use.
        return { ...entry, indexOptions: entry.SchemaClass?.indexOptions };
    }

    /**
     * Resolve a document's SUBTYPE — the registration's `subtypeField` read off the
     * document. Returns null when the schema declares no subtype axis, or the field
     * is absent/empty.
     *
     * One raw segment, never a path: it becomes the last segment of the schema id
     * (`data/schema/application` + `/flatpak`), so scoping is the id's job. That is
     * why the v3 `kindPrefix` has no successor here. Indexed by schemaBitmapKeys()
     * in index.js on every write since Rev B (2026-08-05).
     *
     * @param {string} schemaId
     * @param {object} [document] document instance or plain object
     * @returns {string|null}
     */
    resolveSubtype(schemaId, document = null) {
        const entry = this.#entries.get(schemaId);
        if (!entry || !entry.subtypeField || !document) { return null; }

        const value = entry.subtypeField
            .split('.')
            .reduce((acc, segment) => (acc == null ? acc : acc[segment]), document);

        if (typeof value !== 'string' || value.trim() === '') { return null; }
        return value.trim();
    }

    /**
     * Get proto schema definition by ID (for frontend/API validation)
     * @param {string} schemaId Schema identifier
     * @returns {object} Proto schema definition
     */
    getDataSchema(schemaId) {
        const SchemaClass = this.getSchema(schemaId);
        return SchemaClass.dataSchema;
    }

    /**
     * Get the JSON Schema (draft-07) for a schema id — derived from the class's
     * zod `dataSchema`, so it carries the enums, ranges and required/optional
     * facts a consumer would otherwise hand-copy.
     *
     * `$id` is stamped HERE rather than on the class: the registry owns the
     * id <-> class mapping, and a class does not know which id (or ids) it was
     * registered under.
     *
     * @param {string} schemaId Schema identifier
     * @returns {object|null} JSON Schema, or null for classes with no data
     *                        schema (internal layer types are not documents)
     */
    getJsonSchema(schemaId) {
        const SchemaClass = this.getSchema(schemaId);
        const derived = SchemaClass.jsonSchema;
        if (!derived) { return null; }
        return { $id: schemaId, ...derived };
    }

    /**
     * Resolve a bitmap KEY to the nearest registered schema id — identity on a
     * registered id, ancestor walk on a derived subtype key
     * (`data/schema/application/flatpak` -> `data/schema/application`), null when
     * no registered ancestor exists. This is the explicit bridge between the
     * membership plane (where derived subtype keys are real) and the identity
     * plane (where only registered ids exist); getSchema() stays exact-match.
     *
     * @param {string} key schema id or schema-derived bitmap key
     * @returns {string|null} registered schema id, or null
     */
    resolveSchemaId(key) {
        if (typeof key !== 'string' || key === '') { return null; }
        let candidate = key;
        while (candidate) {
            if (this.#entries.has(candidate)) { return candidate; }
            const slash = candidate.lastIndexOf('/');
            if (slash <= 0) { break; }
            candidate = candidate.slice(0, slash);
        }
        return null;
    }

    /**
     * Serializable registration record for one schema id — what an HTTP consumer
     * gets instead of the class (a class JSON-serializes to `{}`, which is the bug
     * this method exists to fix). Field lists come from the class statics through
     * getSchemaEntry(), so they cannot drift from what documents actually use.
     *
     * @param {string} schemaId Schema identifier
     * @returns {object} { id, tier, subtypeField, indexOptions, jsonSchema }
     * @throws {Error} If schema is not found
     */
    getSchemaDescriptor(schemaId) {
        const entry = this.getSchemaEntry(schemaId);
        return {
            id: schemaId,
            tier: entry.tier,
            subtypeField: entry.subtypeField ?? null,
            indexOptions: entry.indexOptions ?? null,
            jsonSchema: this.getJsonSchema(schemaId),
        };
    }

    /**
     * Check if schema is registered
     * @param {string} schemaId Schema identifier
     * @returns {boolean} True if schema is registered, false otherwise
     */
    hasSchema(schemaId) {
        return this.#entries.has(schemaId);
    }

    /**
     * List all registered schemas
     * @returns {Array<string>} Array of schema IDs
     */
    listSchemas(prefix) {
        const ids = Array.from(this.#entries.keys());
        if (!prefix) { return ids; }
        return ids.filter(schemaId => schemaId.startsWith(prefix));
    }

    /**
     * Initialize schema registry
     * @returns {Map<string, object>} Schema registry
     */
    #initSchemaRegistry() {
        const entries = new Map();

        for (const [schemaId, definition] of Object.entries(CORE_SCHEMAS)) {
            entries.set(schemaId, { ...definition, tier: 'core' });
        }

        for (const [schemaId, definition] of Object.entries(APP_SCHEMAS)) {
            entries.set(schemaId, { ...definition, tier: 'app' });
        }

        for (const [schemaId, SchemaClass] of Object.entries(INTERNAL_SCHEMAS)) {
            entries.set(schemaId, { SchemaClass, tier: 'internal' });
        }

        return entries;
    }
}

// Export singleton instance
export default new SchemaRegistry();
