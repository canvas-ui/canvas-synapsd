'use strict';

import SynapsD from '../src/index.js';
import {
    initializeTestDB,
    cleanupTestDB,
    assert,
    assertEqual,
    runTestSuite,
} from './helpers.js';
import BaseDocument from '../src/schemas/BaseDocument.js';
import schemaRegistry from '../src/schemas/SchemaRegistry.js';

// Mock a schema for testing list and hasSchema, if SchemaRegistry allows dynamic registration
// For now, we rely on BaseDocument being available via the registry.
const testSchemaId = 'BaseDocument'; // BaseDocument is a default schema

const schemaTestSuite = {
    async 'getSchema() should retrieve a schema class'() {
        let db;
        try {
            db = await initializeTestDB();
            const SchemaClass = db.getSchema(testSchemaId);
            assert(SchemaClass !== null && SchemaClass !== undefined, `Schema ${testSchemaId} should be found`);
            assertEqual(SchemaClass.name, testSchemaId, `Schema class name should be ${testSchemaId}`);
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getSchema() should return undefined for non-existent schema'() {
        let db;
        try {
            db = await initializeTestDB();
            const SchemaClass = db.getSchema('NonExistentSchema');
            assertEqual(SchemaClass, undefined, 'getSchema should return undefined for non-existent schema');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getDataSchema() should retrieve schema data definition'() {
        let db;
        try {
            db = await initializeTestDB();
            const schemaDataDef = db.getDataSchema(testSchemaId);
            assert(schemaDataDef !== null && schemaDataDef !== undefined, `Data schema for ${testSchemaId} should be found`);
            // Add more specific checks if the structure of getDataSchema() output is known
            assert(typeof schemaDataDef === 'object', 'Data schema definition should be an object');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'hasSchema() should return true for existing schema'() {
        let db;
        try {
            db = await initializeTestDB();
            assert(db.hasSchema(testSchemaId), `hasSchema should return true for ${testSchemaId}`);
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'hasSchema() should return false for non-existent schema'() {
        let db;
        try {
            db = await initializeTestDB();
            assertEqual(db.hasSchema('NonExistentSchema'), false, 'hasSchema should return false for non-existent schema');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'listSchemas() should return an array of schema IDs'() {
        let db;
        try {
            db = await initializeTestDB();
            const schemas = db.listSchemas();
            assert(Array.isArray(schemas), 'listSchemas should return an array');
            assert(schemas.includes(testSchemaId), `listSchemas should include ${testSchemaId}`);
            // Check for other known schemas if any are guaranteed to be registered
            const expectedSchemas = ['Directory', 'Email', 'File', 'Note', 'Tab', 'Todo', 'BaseDocument'];
            expectedSchemas.forEach(s => {
                assert(schemas.includes(s), `Schema list should include ${s}`);
            });
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'listSchemas() with prefix should filter schemas'() {
        let db;
        try {
            db = await initializeTestDB();
            // Assuming 'BaseDocument' and potentially other schemas exist.
            // If we had a schema like 'custom/MySchema', we could test for 'custom/'
            // For now, let's test with a prefix that should match BaseDocument
            const schemas = db.listSchemas('Base');
            assert(Array.isArray(schemas), 'listSchemas with prefix should return an array');
            assert(schemas.includes('BaseDocument'), 'listSchemas with prefix \'Base\' should include BaseDocument');
            assert(!schemas.includes('Email'), 'listSchemas with prefix \'Base\' should not include Email');
        } finally {
            await cleanupTestDB(db);
        }
    },
};

runTestSuite('SynapsD Schema Methods', schemaTestSuite);
