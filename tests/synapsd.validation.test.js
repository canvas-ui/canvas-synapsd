'use strict';

import SynapsD from '../src/index.js';
import {
    initializeTestDB,
    cleanupTestDB,
    assert,
    assertEqual,
    assertThrows,
    runTestSuite,
} from './helpers.js';
import BaseDocument from '../src/schemas/BaseDocument.js';

const validationTestSuite = {
    async 'validateDocumentInstance() should validate a BaseDocument instance'() {
        let db;
        try {
            db = await initializeTestDB();
            const docInstance = new BaseDocument({ data: { title: 'Test Doc' } }); // Valid instance
            assert(db.validateDocumentInstance(docInstance), 'Valid document instance should pass validation');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'validateDocumentInstance() should throw for invalid instance'() {
        let db;
        try {
            db = await initializeTestDB();
            const docInstance = new BaseDocument({ data: { title: 'Test Doc' } });
            docInstance.data = null; // Make it invalid
            assertThrows(() => {
                db.validateDocumentInstance(docInstance);
            }, 'Invalid document instance should throw during validation');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'validateDocumentData() should validate correct document data'() {
        let db;
        try {
            db = await initializeTestDB();
            const validData = { schema: 'BaseDocument', data: { title: 'Test' } };
            assert(db.validateDocumentData(validData), 'Valid document data should pass validation');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'validateDocumentData() should return false for data with missing schema'() {
        let db;
        try {
            db = await initializeTestDB();
            const invalidData = { data: { title: 'Test' } }; // Missing schema
            assertEqual(db.validateDocumentData(invalidData), false, 'Data with missing schema should fail validation');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'validateDocumentData() should return false for data with missing data property'() {
        let db;
        try {
            db = await initializeTestDB();
            const invalidData = { schema: 'BaseDocument' }; // Missing data property
            assertEqual(db.validateDocumentData(invalidData), false, 'Data with missing data property should fail validation');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'validateDocumentData() should return false for unknown schema'() {
        let db;
        try {
            db = await initializeTestDB();
            const invalidData = { schema: 'UnknownSchema', data: { title: 'Test' } };
            assertEqual(db.validateDocumentData(invalidData), false, 'Data with unknown schema should fail validation');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'validateDocument() should correctly dispatch to instance validation'() {
        let db;
        try {
            db = await initializeTestDB();
            const docInstance = new BaseDocument({ data: { title: 'Test Doc' } });
            // Mock validateDocumentInstance to check if it's called
            let instanceValidationCalled = false;
            db.validateDocumentInstance = (doc) => {
                instanceValidationCalled = true;
                return BaseDocument.prototype.validate.call(doc); // Call original logic
            };
            db.validateDocument(docInstance);
            assert(instanceValidationCalled, 'validateDocumentInstance should be called for a document instance');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'validateDocument() should correctly dispatch to data validation'() {
        let db;
        try {
            db = await initializeTestDB();
            const docData = { schema: 'BaseDocument', data: { title: 'Test' } };
            // Mock validateDocumentData to check if it's called
            let dataValidationCalled = false;
            db.validateDocumentData = (data) => {
                dataValidationCalled = true;
                const SchemaClass = db.getSchema(data.schema);
                return SchemaClass.validateData(data); // Call original logic
            };
            db.validateDocument(docData);
            assert(dataValidationCalled, 'validateDocumentData should be called for document data object');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'validateDocument() should throw for invalid input type'() {
        let db;
        try {
            db = await initializeTestDB();
            assertThrows(() => {
                db.validateDocument(123); // Invalid type
            }, 'validateDocument should throw for invalid input type (number)');
            assertThrows(() => {
                db.validateDocument('sometext'); // Invalid type
            }, 'validateDocument should throw for invalid input type (string)');
            assertThrows(() => {
                db.validateDocument(null); // Invalid type
            }, 'validateDocument should throw for invalid input type (null)');
        } finally {
            await cleanupTestDB(db);
        }
    },
};

runTestSuite('SynapsD Validation Methods', validationTestSuite);
