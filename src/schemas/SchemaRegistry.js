'use strict';

// Schemas
import BaseDocument from './BaseDocument.js';
//import Directory from './abstractions/Directory.js';
//import Email from './abstractions/Email.js';
//import File from './abstractions/File.js';
import Note from './abstractions/Note.js';
import Tab from './abstractions/Tab.js';
//import Todo from './abstractions/Todo.js';

// Default schema registry (for now hard-coded)
const SCHEMA_REGISTRY = {
    'data/abstraction/document': BaseDocument,
    //'data/abstraction/directory': Directory,
    //'data/abstraction/email': Email,
    //'data/abstraction/file': File,
    'data/abstraction/note': Note,
    'data/abstraction/tab': Tab,
    //'data/abstraction/todo': Todo,
};


class SchemaRegistry {

    #schemas = new Map();

    constructor() {
        this.#schemas = this.#initSchemaRegistry();
    }

    /**
     * Get schema by ID
     * @param {string} schemaId Schema identifier
     * @returns {object} Schema definition
     */
    getSchema(schemaId) {
        const schema = this.#schemas.get(schemaId);
        if (!schema) {
            throw new Error(`Schema ${schemaId} not found`);
        }
        return schema;
    }

    getJsonSchema(schemaId) {
        const schema = this.getSchema(schemaId);
        return schema.toJSON();
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
