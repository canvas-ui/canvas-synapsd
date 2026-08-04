'use strict';

// Base document — also the class registered for `data/abstraction/document`.
import Document from './Document.js';

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
 * The CORE entity set — synapsd's own primitives. Ids stay `data/abstraction/*`
 * under D1(c): the v3 model lands, the id rename is deferred to its own rev gated
 * on a coordinated submodule release. `kind` is what consumers migrate to; see
 * TODO.md.
 *
 * `kind` values are HIERARCHICAL (the `data/mime/*` precedent) — a `browser/tab`
 * ticks both `data/kind/browser` and `data/kind/browser/tab`, so "everything
 * browser-ish" is one key with no enumeration of children.
 */
const CORE_SCHEMAS = {
    'data/abstraction/document': { SchemaClass: Document },
    'data/abstraction/file': { SchemaClass: File },
    'data/abstraction/message': { SchemaClass: Message },
    'data/abstraction/email': { SchemaClass: Email, kind: 'email' },
    'data/abstraction/event': { SchemaClass: Event, kindField: 'data.type', kindPrefix: 'event' },
    'data/abstraction/todo': { SchemaClass: Task },
    'data/abstraction/identity': { SchemaClass: Identity, kindField: 'data.type', kindPrefix: 'identity' },
    'data/abstraction/device': { SchemaClass: Device },
    'data/abstraction/application': { SchemaClass: Application, kindField: 'data.type', kindPrefix: 'application' },
};

/**
 * App-level schemas, bundled pending the parent's own `registerSchema()` calls.
 * Registered exactly like a third-party schema would be — same code path, so the
 * eventual move is a deletion here, not a rewrite.
 */
const APP_SCHEMAS = {
    'data/abstraction/note': { SchemaClass: Note, kind: 'note' },
    'data/abstraction/tab': { SchemaClass: Tab, kind: 'browser/tab' },
    'data/abstraction/link': { SchemaClass: Link, kind: 'link' },
    'data/abstraction/dotfile': { SchemaClass: Dotfile, kindField: 'data.type', kindPrefix: 'dotfile' },
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

    // schemaId -> { SchemaClass, tier, kind?, kindField?, kindPrefix?, indexOptions? }
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
     * consumer silently change what `data/abstraction/file` means for everyone.
     *
     * @param {string} schemaId          e.g. 'data/abstraction/note'
     * @param {Function} SchemaClass     a Document subclass
     * @param {object} [options]
     * @param {string} [options.kind]        literal kind value, e.g. 'browser/tab'
     * @param {string} [options.kindField]   dotted path to a subtype discriminator,
     *                                       e.g. 'data.type' — resolved per document
     * @param {string} [options.kindPrefix]  parent segment prepended to a kindField
     *                                       value, e.g. 'dotfile' -> 'dotfile/folder'
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

        if (options.kind && options.kindField) {
            throw new Error(
                `registerSchema: ${schemaId} sets both kind and kindField — a schema has one kind axis, ` +
                'either a literal or a per-document field, not both',
            );
        }

        // Enforced, not conventional: kind values are persisted in bitmap keys and
        // are therefore append-only, so an unprefixed generic value ('file',
        // 'person', 'calendar') that later collides with another schema's is not
        // fixable without a migration. Decided 2026-08-03 — always prefix with the
        // entity, no per-schema judgment call.
        if (options.kindField && !options.kindPrefix) {
            throw new Error(
                `registerSchema: ${schemaId} sets kindField without kindPrefix — kind values derived ` +
                'from a document field must be prefixed with the entity (e.g. kindPrefix: \'widget\' ' +
                'yields data/kind/widget/<value>), so they cannot collide across schemas',
            );
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
            kind: options.kind,
            kindField: options.kindField,
            kindPrefix: options.kindPrefix,
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
     * Get the full registration record — the shape Phase 3's row work reads
     * `kind` and `indexOptions` from, so ingest never reads them off the row.
     * @param {string} schemaId Schema identifier
     * @returns {object} Registration entry
     * @throws {Error} If schema is not found
     */
    getSchemaEntry(schemaId) {
        const entry = this.#entries.get(schemaId);
        if (!entry) {
            throw new Error(`Schema not found: ${schemaId}`);
        }
        // Read `indexOptions` through to the class static rather than caching a
        // copy here: it is resolved from the class at construction time, and a
        // second stored copy could drift from what documents actually use.
        return { ...entry, indexOptions: entry.SchemaClass?.indexOptions };
    }

    /**
     * Resolve the `kind` value for a document: a literal from the registration, or
     * the registration's `kindField` read off the document (optionally under a
     * parent segment). Returns null when the schema declares no kind axis.
     *
     * Hierarchical by construction — the caller ticks every parent segment, so
     * 'dotfile/folder' also answers to 'dotfile'.
     *
     * @param {string} schemaId
     * @param {object} [document] document instance or plain object
     * @returns {string|null}
     */
    resolveKind(schemaId, document = null) {
        const entry = this.#entries.get(schemaId);
        if (!entry) { return null; }
        if (entry.kind) { return entry.kind; }
        if (!entry.kindField || !document) { return null; }

        const value = entry.kindField
            .split('.')
            .reduce((acc, segment) => (acc == null ? acc : acc[segment]), document);

        if (typeof value !== 'string' || value === '') { return null; }
        return entry.kindPrefix ? `${entry.kindPrefix}/${value}` : value;
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
