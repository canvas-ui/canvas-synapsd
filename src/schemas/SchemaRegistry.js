'use strict';

// Base document
import BaseDocument from './BaseDocument.js';

// Schemas
import Document from './abstractions/Document.js';
import Directory from './abstractions/Directory.js';
import Email from './abstractions/Email.js';
import File from './abstractions/File.js';
import Note from './abstractions/Note.js';
import Tab from './abstractions/Tab.js';
import Todo from './abstractions/Todo.js';

// Default schema registry (for now hard-coded)
const SCHEMA_REGISTRY = {
    'data/abstraction/base': BaseDocument,
    'data/abstraction/document': Document,
    'data/abstraction/directory': Directory,
    'data/abstraction/email': Email,
    'data/abstraction/file': File,
    'data/abstraction/note': Note,
    'data/abstraction/tab': Tab,
    'data/abstraction/todo': Todo,
};

export function isDocument(obj) {
    if (!obj || typeof obj !== 'object') {return false;}

    // Check for essential document properties
    return (
        obj.schema &&
        typeof obj.schema === 'string' &&
        obj.schemaVersion &&
        obj.data !== undefined &&
        obj.metadata &&
        obj instanceof BaseDocument
    ) || false;
}

export function isDocumentData(obj) {
    if (!obj || typeof obj !== 'object') {return false;}

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
    listSchemas() {
        return Array.from(this.#schemas.keys());
    }

    /**
     * Validate a full document against its schema
     * @param {Object} document - The document to validate
     * @returns {boolean} True if validation passes, false otherwise
     * @private
     */
    #validateDocument(document) {
        const SchemaClass = this.getSchema(document.schema);
        return SchemaClass.validate(document);
    }

    /**
     * Validate document data against its document schema
     * @param {Object} data - The document data to validate
     * @returns {boolean} True if validation passes, false otherwise
     * @private
     */
    #validateDocumentData(data) {
        const SchemaClass = this.getSchema(data.schema);
        return SchemaClass.validateData(data);
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
