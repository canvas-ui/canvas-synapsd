// Schemas
import Document from './Document.js';
import File from './abstractions/File.js';
import Note from './abstractions/Note.js';
import Tab from './abstractions/Tab.js';

// Default schema registry (for now hard-coded)
const SCHEMA_REGISTRY = {
    'data/abstraction/document': Document,
    'data/abstraction/file': File,
    'data/abstraction/note': Note,
    'data/abstraction/tab': Tab,
};


class SchemaRegistry {

    #schemas = new Map();

    constructor() {
        // Initialize schema registry (placeholder)
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

    /**
     * Check if schema is registered
     * @param {string} schemaId Schema identifier
     * @returns {boolean} True if schema is registered, false otherwise
     */
    hasSchema(schemaId) {
        return this.#schemas.has(schemaId);
    }

    /**
     * Validate document against its schema
     * @param {object} document Document to validate
     * @returns {boolean} True if valid, throws error if invalid
     */
    validateDocument(document) {
        if (!document.schema) {
            throw new Error('Document schema not specified');
        }

        const SchemaClass = this.#schemas.get(document.schema);
        if (!SchemaClass) {
            throw new Error(`No schema found for ${document.schema}`);
        }

        try {
            SchemaClass.schemaDefinition.parse(document);
            return true;
        } catch (error) {
            throw new Error(`Schema validation failed: ${error.message}`);
        }
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
