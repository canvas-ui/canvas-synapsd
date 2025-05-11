'use strict';

// Base document
import BaseDocument from './BaseDocument.js';

// Document Schemas
import Document from './abstractions/Document.js';
import Email from './abstractions/Email.js';
import File from './abstractions/File.js';
import Note from './abstractions/Note.js';
import Tab from './abstractions/Tab.js';
import Todo from './abstractions/Todo.js';

// Tree Abstractions
import Canvas from './internal/layers/Canvas.js';
import Context from './internal/layers/Context.js';
import Label from './internal/layers/Label.js';
import System from './internal/layers/System.js';
import Universe from './internal/layers/Universe.js';
import Workspace from './internal/layers/Workspace.js';

// Default schema registry (for now hard-coded)
const SCHEMA_REGISTRY = {
    // Data Abstractions
    'data/abstraction/document': Document,
    'data/abstraction/email': Email,
    'data/abstraction/file': File,
    'data/abstraction/note': Note,
    'data/abstraction/tab': Tab,
    'data/abstraction/todo': Todo,

    // Tree Abstractions
    'internal/layers/canvas': Canvas,           // Can store context, feature and filter bitmaps + dashboard / UI layouts
    'internal/layers/context': Context,         // Default context layer(linked to a bitmap)
    'internal/layers/label': Label,             // Label only (no associated bitmaps)
    'internal/layers/system': System,           // System layers
    'internal/layers/universe': Universe,       // Root layer for a workspace
    'internal/layers/workspace': Workspace,     // "Mountpoint" to a workspace
};

export function isDocumentInstance(obj) {
    if (!obj || typeof obj !== 'object') {return false;}

    // Check for essential document properties
    return (
        obj.schema &&
        typeof obj.schema === 'string' &&
        obj.data !== undefined &&
        obj instanceof BaseDocument
    ) || false;
}

export function isDocumentData(obj) {
    if (!obj || typeof obj !== 'object') { return false; }

    // Check for minimal proto object properties
    return (
        obj.schema &&
        typeof obj.schema === 'string' &&
        obj.data !== undefined &&
        !(obj instanceof BaseDocument)
    );
}

/**
 * Schema registry singleton
 */

class SchemaRegistry {

    #schemas = new Map();

    constructor() {
        this.#schemas = this.#initSchemaRegistry();
    }

    /**
     * Get schema class by ID
     * @param {string} schemaId Schema identifier
     * @returns {Class} Schema class
     * @throws {Error} If schema is not found
     */
    getSchema(schemaId) {
        if (!this.hasSchema(schemaId)) {
            throw new Error(`Schema not found: ${schemaId}`);
        }
        return this.#schemas.get(schemaId);
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
     * Check if schema is registered
     * @param {string} schemaId Schema identifier
     * @returns {boolean} True if schema is registered, false otherwise
     */
    hasSchema(schemaId) {
        return this.#schemas.has(schemaId);
    }

    /**
     * List all registered schemas
     * @returns {Array<string>} Array of schema IDs
     */
    listSchemas(prefix) {
        if (!prefix) {
            return Array.from(this.#schemas.keys());
        }

        return Array.from(this.#schemas.keys()).filter(schemaId => schemaId.startsWith(prefix));
    }

    /**
     * Initialize schema registry
     * @returns {Map<string, object>} Schema registry
     */
    #initSchemaRegistry() {
        const schemas = new Map();

        // Initialize schemas from registry
        for (const [schemaId, SchemaClass] of Object.entries(SCHEMA_REGISTRY)) {
            schemas.set(schemaId, SchemaClass);
        }

        return schemas;
    }
}

// Export singleton instance
export default new SchemaRegistry();
