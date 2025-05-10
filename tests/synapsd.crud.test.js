'use strict';

import SynapsD from '../src/index.js';
import {
    initializeTestDB,
    cleanupTestDB,
    assert,
    assertEqual,
    assertDeepEqual,
    assertThrows,
    assertAsyncThrows,
    runTestSuite,
    TEST_DB_PATH
} from './helpers.js';
import BaseDocument from '../src/schemas/BaseDocument.js';
import fs from 'fs';

// Import a specific schema class for testing, e.g., Tab
import Tab from '../src/schemas/abstractions/Tab.js';

const INTERNAL_BITMAP_ID_MAX = 100000; // From SynapsD.js
const TAB_SCHEMA_NAME = 'data/abstraction/tab';

const crudTestSuite = {
    // --- insertDocument ---
    async 'insertDocument() should insert a new document from data object'() {
        let db;
        try {
            db = await initializeTestDB();
            const docData = { schema: TAB_SCHEMA_NAME, data: { url: 'http://example.com/page1', title: 'First Tab' } };
            let eventFired = false;
            let eventPayload = null;
            db.on('documentInserted', (payload) => {
                eventFired = true;
                eventPayload = payload;
            });

            const docId = await db.insertDocument(docData);
            assert(typeof docId === 'number' && docId > INTERNAL_BITMAP_ID_MAX, 'Should return a numeric ID');

            const retrievedDoc = await db.getDocumentById(docId);
            assert(retrievedDoc instanceof Tab, `Retrieved document should be instance of Tab (actual: ${retrievedDoc ? retrievedDoc.constructor.name : null})`);
            assertEqual(retrievedDoc.id, docId, 'Retrieved doc ID mismatch');
            assertEqual(retrievedDoc.schema, TAB_SCHEMA_NAME, 'Retrieved doc schema mismatch');
            assertEqual(retrievedDoc.data.title, 'First Tab', 'Retrieved doc data mismatch');
            assertEqual(retrievedDoc.data.url, 'http://example.com/page1', 'Retrieved doc URL mismatch');

            const primaryChecksum = retrievedDoc.getPrimaryChecksum();
            assert(primaryChecksum, 'Primary checksum should exist');
            const idFromChecksum = await db._SynapsD__checksumIndex.checksumStringToId(primaryChecksum);
            assertEqual(idFromChecksum, docId, 'Checksum index should map primary checksum to docId');

            // Check action bitmap for timestamp (TimestampIndex internal details are not directly tested here)
            assert(db.actionBitmaps.created.has(docId), 'actionBitmaps.created should contain ID');

            const defaultContextBitmap = await db.contextBitmapCollection.getBitmap('/');
            assert(defaultContextBitmap && defaultContextBitmap.has(docId), 'Default context bitmap missing ID');

            const schemaFeatureBitmap = await db.bitmapIndex.getBitmap(TAB_SCHEMA_NAME);
            assert(schemaFeatureBitmap && schemaFeatureBitmap.has(docId), `Schema feature bitmap for ${TAB_SCHEMA_NAME} missing ID`);

            assert(eventFired, 'documentInserted event should be fired');
            assertEqual(eventPayload.id, docId, 'Event payload ID mismatch');
            assert(eventPayload.document instanceof Tab, 'Event payload document type mismatch for Tab');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'insertDocument() with existing checksum should update and use existing ID'() {
        let db;
        try {
            db = await initializeTestDB();
            const docData1 = { schema: 'BaseDocument', data: { title: 'Unique Content', version: 1 } };
            const docId1 = await db.insertDocument(docData1);

            const docData2 = { schema: 'BaseDocument', data: { title: 'Unique Content', version: 2 } }; // Same primary content
            const docId2 = await db.insertDocument(docData2);

            assertEqual(docId1, docId2, 'Should reuse the same ID for document with same primary checksum');

            const retrievedDoc = await db.getDocumentById(docId1);
            assertEqual(retrievedDoc.data.version, 2, 'Document data should be updated to version 2');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'insertDocument() with BaseDocument instance'() {
        let db;
        try {
            db = await initializeTestDB();
            const docInstance = new BaseDocument({ schema: 'BaseDocument', data: { title: 'Instance Doc' } });
            const docId = await db.insertDocument(docInstance);
            assert(typeof docId === 'number', 'Should return a numeric ID for instance input');

            const retrievedDoc = await db.getDocumentById(docId);
            assertEqual(retrievedDoc.data.title, 'Instance Doc', 'Retrieved doc data mismatch for instance input');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'insertDocument() with custom context and features'() {
        let db;
        try {
            db = await initializeTestDB();
            const docData = { schema: 'BaseDocument', data: { title: 'Contextual Doc' } };
            const contextSpec = '/work/projectA';
            const featureBitmapArray = ['important', 'featureX'];

            const docId = await db.insertDocument(docData, contextSpec, featureBitmapArray);

            // Check context
            const projectABitmap = await db.contextBitmapCollection.getBitmap('/work/projectA');
            assert(projectABitmap && projectABitmap.has(docId), 'Custom context /work/projectA missing ID');

            // Check features
            const importantBitmap = await db.bitmapIndex.getBitmap('important');
            const featureXBitmap = await db.bitmapIndex.getBitmap('featureX');
            assert(importantBitmap && importantBitmap.has(docId), 'Feature important missing ID');
            assert(featureXBitmap && featureXBitmap.has(docId), 'Feature featureX missing ID');

            // Check schema feature still exists
            const schemaFeatureBitmap = await db.bitmapIndex.getBitmap('BaseDocument');
            assert(schemaFeatureBitmap && schemaFeatureBitmap.has(docId), 'Schema feature bitmap missing ID after custom features');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'insertDocument() should throw for invalid document data'() {
        let db;
        try {
            db = await initializeTestDB();
            const invalidData = { schema: 'BaseDocument', data: null }; // Invalid data for BaseDocument
            await assertAsyncThrows(
                async () => db.insertDocument(invalidData),
                'insertDocument should throw for data that fails schema validation'
            );
        } finally {
            await cleanupTestDB(db);
        }
    },

    // --- getDocumentById ---
    async 'getDocumentById() should retrieve existing document'() {
        let db;
        try {
            db = await initializeTestDB();
            const docData = { schema: 'BaseDocument', data: { title: 'GetMe' } };
            const docId = await db.insertDocument(docData);

            const retrievedDoc = await db.getDocumentById(docId);
            assert(retrievedDoc instanceof BaseDocument, 'Retrieved doc not BaseDocument instance');
            assertEqual(retrievedDoc.id, docId, 'Retrieved doc ID error');
            assertEqual(retrievedDoc.data.title, 'GetMe', 'Retrieved doc data error');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getDocumentById() should return null for non-existent ID'() {
        let db;
        try {
            db = await initializeTestDB();
            const retrievedDoc = await db.getDocumentById(999999); // Non-existent
            assertEqual(retrievedDoc, null, 'Should return null for non-existent ID');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getDocumentById() with options.parse = false'() {
        let db;
        try {
            db = await initializeTestDB();
            const docData = { schema: 'BaseDocument', data: { title: 'RawDog' } };
            const docId = await db.insertDocument(docData);

            const rawDoc = await db.getDocumentById(docId, { parse: false });
            assert(!(rawDoc instanceof BaseDocument), 'Retrieved raw doc should not be BaseDocument instance');
            assert(typeof rawDoc === 'object' && rawDoc !== null, 'Raw doc should be an object');
            assertEqual(rawDoc.id, docId, 'Raw doc ID error');
            assertEqual(rawDoc.data.title, 'RawDog', 'Raw doc data error');
        } finally {
            await cleanupTestDB(db);
        }
    },

    // --- hasDocument ---
    async 'hasDocument() should return true for existing document'() {
        let db;
        try {
            db = await initializeTestDB();
            const docId = await db.insertDocument({ schema: 'BaseDocument', data: { title: 'Checker' }});
            const exists = await db.hasDocument(docId);
            assert(exists, 'hasDocument should return true for existing ID');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'hasDocument() should return false for non-existent document'() {
        let db;
        try {
            db = await initializeTestDB();
            const exists = await db.hasDocument(88888);
            assertEqual(exists, false, 'hasDocument should return false for non-existent ID');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'hasDocument() with context and feature filters'() {
        let db;
        try {
            db = await initializeTestDB();
            const docId1 = await db.insertDocument(
                { schema: 'BaseDocument', data: { name: 'Doc1' } },
                '/c1',
                ['f1']
            );
            const docId2 = await db.insertDocument(
                { schema: 'BaseDocument', data: { name: 'Doc2' } },
                '/c2',
                ['f2']
            );
             const docId3 = await db.insertDocument(
                { schema: 'BaseDocument', data: { name: 'Doc3' } },
                '/c1',
                ['f2'] // In c1, but with f2
            );

            assert(await db.hasDocument(docId1, '/c1', ['f1']), 'Doc1 in /c1 with f1 - positive case');
            assertEqual(await db.hasDocument(docId1, '/c2', ['f1']), false, 'Doc1 not in /c2');
            assertEqual(await db.hasDocument(docId1, '/c1', ['f2']), false, 'Doc1 not with f2');

            assert(await db.hasDocument(docId2, '/c2', ['f2']), 'Doc2 in /c2 with f2 - positive case');

            // Test with default context ('/') which should exist if document is inserted
            // All documents are implicitly in '/' if contextBitmapCollection.AND handles it or if no context is restrictive
            // The current hasDocument implementation defaults to '/' if contextSpec is empty, so it should work.
            const docIdPlain = await db.insertDocument({ schema: 'BaseDocument', data: { name: 'PlainDoc' }});
            assert(await db.hasDocument(docIdPlain), 'Plain doc check without filters');
            assert(await db.hasDocument(docIdPlain, '/'), 'Plain doc check with default context '/'');
            assert(await db.hasDocument(docIdPlain, null, ['BaseDocument']), 'Plain doc check with schema feature');
            assertEqual(await db.hasDocument(docIdPlain, '/c1'), false, 'Plain doc not in /c1');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'hasDocument() returns false if document exists but not in specified context/feature'() {
        let db;
        try {
            db = await initializeTestDB();
            const docData = { schema: 'BaseDocument', data: { title: 'FilterTest' } };
            const docId = await db.insertDocument(docData, '/apples', ['fruit']);

            // Exists in general
            assert(await db.hasDocument(docId), 'Document should exist generally');

            // Does not exist in different context
            assertEqual(await db.hasDocument(docId, '/oranges', ['fruit']), false, 'Should be false in wrong context');

            // Exists in context, but wrong feature
            assertEqual(await db.hasDocument(docId, '/apples', ['vegetable']), false, 'Should be false with wrong feature');

            // Exists in feature, but wrong context
            assertEqual(await db.hasDocument(docId, '/kitchen', ['fruit']), false, 'Should be false with wrong context, correct feature');

        } finally {
            await cleanupTestDB(db);
        }
    },

    // TODO: More tests for hasDocument, especially with ! (negation) in context/feature arrays if supported by BitmapIndex.AND/OR

    // --- updateDocument ---
    async 'updateDocument() should update existing document data'() {
        let db;
        try {
            db = await initializeTestDB();
            const initialData = { schema: 'BaseDocument', data: { title: 'Initial Title', version: 1 } };
            const docId = await db.insertDocument(initialData);
            const originalDoc = await db.getDocumentById(docId);

            const updateData = { data: { title: 'Updated Title', version: 2, newField: 'added' } };
            let eventFired = false;
            let eventPayload = null;
            db.on('documentUpdated', (payload) => {
                eventFired = true;
                eventPayload = payload;
            });

            const updatedId = await db.updateDocument(docId, updateData);
            assertEqual(updatedId, docId, 'updateDocument should return the same document ID');

            const retrievedDoc = await db.getDocumentById(docId);
            assertEqual(retrievedDoc.data.title, 'Updated Title', 'Title should be updated');
            assertEqual(retrievedDoc.data.version, 2, 'Version should be updated');
            assertEqual(retrievedDoc.data.newField, 'added', 'New field should be added');
            assert(retrievedDoc.updatedAt > originalDoc.updatedAt, 'updatedAt timestamp should be newer');

            // Check checksums (simplified check: assume primary checksum might change or stay same based on title)
            // A more thorough check would involve detailed checksum verification.
            const oldChecksums = originalDoc.checksumArray;
            const newChecksums = retrievedDoc.checksumArray;
            assert(JSON.stringify(oldChecksums) !== JSON.stringify(newChecksums) || oldChecksums.length === 0 && newChecksums.length === 0, 'Checksum array should reflect changes or be empty if no checksummable data');

            // Check updated timestamp
            const updatedBitmap = await db._SynapsD__timestampIndex.getBitmap('updated', retrievedDoc.updatedAt.toISOString().slice(0, 10));
            assert(updatedBitmap && updatedBitmap.has(docId), 'Timestamp index for updated date incorrect');

            assert(eventFired, 'documentUpdated event should be fired');
            assertEqual(eventPayload.id, docId, 'Update event payload ID mismatch');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'updateDocument() should update context and features'() {
        let db;
        try {
            db = await initializeTestDB();
            const docId = await db.insertDocument({ schema: 'BaseDocument', data: { name: 'Updater' } }, '/initialCtx', ['initialFeat']);

            await db.updateDocument(docId, null, '/newCtx', ['newFeat']);

            const initialCtxBitmap = await db.contextBitmapCollection.getBitmap('/initialCtx');
            // Note: updateDocument in SynapsD currently ADDS to context/features, does not replace/remove old ones.
            // This test reflects that behavior.
            assert(initialCtxBitmap && initialCtxBitmap.has(docId), 'Should still be in initial context unless logic changes');

            const newCtxBitmap = await db.contextBitmapCollection.getBitmap('/newCtx');
            assert(newCtxBitmap && newCtxBitmap.has(docId), 'Should be added to new context');

            const initialFeatBitmap = await db.bitmapIndex.getBitmap('initialFeat');
            assert(initialFeatBitmap && initialFeatBitmap.has(docId), 'Should still have initial feature');

            const newFeatBitmap = await db.bitmapIndex.getBitmap('newFeat');
            assert(newFeatBitmap && newFeatBitmap.has(docId), 'Should be added to new feature');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'updateDocument() should throw if document ID does not exist'() {
        let db;
        try {
            db = await initializeTestDB();
            await assertAsyncThrows(
                async () => db.updateDocument(999123, { data: { title: 'ghost' } }),
                'updateDocument should throw for non-existent document ID'
            );
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'updateDocument() should throw for invalid update data'() {
        let db;
        try {
            db = await initializeTestDB();
            const docId = await db.insertDocument({ schema: 'BaseDocument', data: { name: 'Valid' }});
            const invalidUpdateData = { schema: 'BaseDocument', data: null }; // Invalid for BaseDocument
            await assertAsyncThrows(
                async () => db.updateDocument(docId, invalidUpdateData),
                'updateDocument should throw for invalid update data'
            );
        } finally {
            await cleanupTestDB(db);
        }
    },

    // --- removeDocument ---
    async 'removeDocument() should remove document from specified context'() {
        let db;
        try {
            db = await initializeTestDB();
            const context1 = '/work';
            const context2 = '/home';
            const docId = await db.insertDocument({ schema: 'BaseDocument', data: { name: 'Removable' } }, [context1, context2]);

            assert((await db.contextBitmapCollection.getBitmap(context1)).has(docId), 'Doc should be in /work initially');
            assert((await db.contextBitmapCollection.getBitmap(context2)).has(docId), 'Doc should be in /home initially');

            const removeResult = await db.removeDocument(docId, context1);
            assertEqual(removeResult, docId, 'removeDocument should return the docId on success');

            assert(!(await db.contextBitmapCollection.getBitmap(context1)).has(docId), 'Doc should be removed from /work');
            assert((await db.contextBitmapCollection.getBitmap(context2)).has(docId), 'Doc should still be in /home');
            assert(await db.hasDocument(docId), 'Document itself should still exist in the main store');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'removeDocument() should remove document from specified feature'() {
        let db;
        try {
            db = await initializeTestDB();
            const feature1 = 'important';
            const feature2 = 'archived';
            const docId = await db.insertDocument({ schema: 'BaseDocument', data: { name: 'Featured' } }, '/', [feature1, feature2]);

            assert((await db.bitmapIndex.getBitmap(feature1)).has(docId), 'Doc should have feature1 initially');
            assert((await db.bitmapIndex.getBitmap(feature2)).has(docId), 'Doc should have feature2 initially');

            await db.removeDocument(docId, '/', [feature1]); // context='/' means only apply feature removal

            assert(!(await db.bitmapIndex.getBitmap(feature1)).has(docId), 'Doc should lose feature1');
            assert((await db.bitmapIndex.getBitmap(feature2)).has(docId), 'Doc should still have feature2');
            assert(await db.hasDocument(docId), 'Document itself should still exist');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'removeDocument() with non-existent ID should run without error (idempotency)'() {
        let db;
        try {
            db = await initializeTestDB();
            // Attempting to remove a non-existent document from context/features should not throw
            // as the untick operations on bitmaps are typically idempotent or handle missing keys gracefully.
            const result = await db.removeDocument(888777, '/anyContext', ['anyFeature']);
            assertEqual(result, 888777, 'removeDocument for non-existent ID should still return the ID');
        } finally {
            await cleanupTestDB(db);
        }
    },

    // --- deleteDocument ---
    async 'deleteDocument() should remove document from store and all indexes'() {
        let db;
        try {
            db = await initializeTestDB();
            const context = '/projectX';
            const feature = 'toBeDeleted';
            const docData = { schema: 'BaseDocument', data: { name: 'Deleter', content: 'abc' } };
            const docId = await db.insertDocument(docData, context, [feature]);

            const originalDoc = await db.getDocumentById(docId);
            const primaryChecksum = originalDoc.getPrimaryChecksum();

            assert(await db.hasDocument(docId, context, [feature]), 'Document should exist with context/feature before delete');

            let deleteResult = await db.deleteDocument(docId);
            assert(deleteResult, 'deleteDocument should return true on success');

            assertEqual(await db.getDocumentById(docId), null, 'Document should be null after delete from store');
            assertEqual(await db.hasDocument(docId), false, 'hasDocument should be false after delete');

            // Check context bitmap
            const ctxBitmap = await db.contextBitmapCollection.getBitmap(context, false); // Don't auto-create
            assert(ctxBitmap === null || !ctxBitmap.has(docId), 'Should be removed from context bitmap');

            // Check feature bitmap
            const featBitmap = await db.bitmapIndex.getBitmap(feature, false); // Don't auto-create
            assert(featBitmap === null || !featBitmap.has(docId), 'Should be removed from feature bitmap');

            // Check schema feature bitmap
            const schemaFeatBitmap = await db.bitmapIndex.getBitmap('BaseDocument', false);
            assert(schemaFeatBitmap === null || !schemaFeatBitmap.has(docId), 'Should be removed from schema feature bitmap');

            // Check checksum index
            const idFromChecksum = await db._SynapsD__checksumIndex.checksumStringToId(primaryChecksum);
            assertEqual(idFromChecksum, null, 'Should be removed from checksum index');

            // Check deleted documents bitmap
            assert(db.deletedDocumentsBitmap.has(docId), 'Should be added to deletedDocumentsBitmap');

            // Check timestamp index (deleted)
            const deletedTimestampBitmap = await db._SynapsD__timestampIndex.getBitmap('deleted', originalDoc.updatedAt.toISOString().slice(0,10));
            assert(deletedTimestampBitmap && deletedTimestampBitmap.has(docId), 'Should be added to deleted timestamp index');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'deleteDocument() with non-existent ID should return false'() {
        let db;
        try {
            db = await initializeTestDB();
            const result = await db.deleteDocument(777666);
            assertEqual(result, false, 'deleteDocument for non-existent ID should return false');
        } finally {
            await cleanupTestDB(db);
        }
    },

    // --- Array CRUD Operations ---
    async 'insertDocumentArray() should insert multiple documents'() {
        let db;
        try {
            db = await initializeTestDB();
            const docArray = [
                { schema: 'BaseDocument', data: { title: 'ArrayDoc 1' } },
                { schema: 'BaseDocument', data: { title: 'ArrayDoc 2' } },
            ];

            // Ensure no individual events are fired
            let individualEventFired = false;
            db.on('documentInserted', () => { individualEventFired = true; });

            const errors = await db.insertDocumentArray(docArray, '/batchContext', ['batchFeature']);
            assertEqual(errors.length, 0, 'insertDocumentArray should have no errors for valid docs');
            assert(!individualEventFired, 'No individual documentInserted event should fire for array insert');

            const docs = await db.findDocuments('/batchContext', ['batchFeature']);
            assertEqual(docs.length, 2, 'Should find 2 documents after array insert');
            assert(docs.some(d => d.data.title === 'ArrayDoc 1'), 'ArrayDoc 1 should be present');
            assert(docs.some(d => d.data.title === 'ArrayDoc 2'), 'ArrayDoc 2 should be present');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'insertDocumentArray() should return errors for invalid documents in batch'() {
        let db;
        try {
            db = await initializeTestDB();
            const docArray = [
                { schema: 'BaseDocument', data: { title: 'Valid ArrayDoc' } },
                { schema: 'BaseDocument', data: null }, // Invalid
                { schema: 'UnknownSchema', data: { title: 'Invalid Schema' } } // Invalid schema
            ];
            const errors = await db.insertDocumentArray(docArray);
            assertEqual(errors.length, 2, 'Should return 2 errors for the invalid documents');
            assert(errors.some(e => e.doc.data === null), 'Error report for null data missing');
            assert(errors.some(e => e.doc.schema === 'UnknownSchema'), 'Error report for unknown schema missing');

            const validDocs = await db.findDocuments('/', ['BaseDocument']);
            assertEqual(validDocs.length, 1, 'Only one valid document should be inserted');
            assertEqual(validDocs[0].data.title, 'Valid ArrayDoc', 'Valid document data mismatch');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'updateDocumentArray() should update multiple documents'() {
        let db;
        try {
            db = await initializeTestDB();
            const ids = [];
            ids.push(await db.insertDocument({ schema: 'BaseDocument', data: { name: 'UpdateArr1', version: 1 } }));
            ids.push(await db.insertDocument({ schema: 'BaseDocument', data: { name: 'UpdateArr2', version: 1 } }));

            const updateArray = [
                { id: ids[0], data: { version: 2, name: 'UpdatedArr1' } },
                { id: ids[1], data: { version: 2, name: 'UpdatedArr2' } },
            ];

            const errors = await db.updateDocumentArray(updateArray);
            assertEqual(errors.length, 0, 'updateDocumentArray should have no errors for valid updates');

            const doc1 = await db.getDocumentById(ids[0]);
            const doc2 = await db.getDocumentById(ids[1]);

            assertEqual(doc1.data.version, 2, 'Doc1 version should be updated');
            assertEqual(doc1.data.name, 'UpdatedArr1', 'Doc1 name should be updated');
            assertEqual(doc2.data.version, 2, 'Doc2 version should be updated');
            assertEqual(doc2.data.name, 'UpdatedArr2', 'Doc2 name should be updated');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'removeDocumentArray() should remove multiple documents from context/features'() {
        let db;
        try {
            db = await initializeTestDB();
            const context = '/removableBatch';
            const feature = 'removableFeatBatch';
            const ids = [];
            ids.push(await db.insertDocument({ schema: 'BaseDocument', data: { name: 'RemArr1' } }, context, [feature]));
            ids.push(await db.insertDocument({ schema: 'BaseDocument', data: { name: 'RemArr2' } }, context, [feature]));
            ids.push(await db.insertDocument({ schema: 'BaseDocument', data: { name: 'RemArr3NotRemoved' } }, context, [feature]));

            const errors = await db.removeDocumentArray([ids[0], ids[1]], context, [feature]);
            assertEqual(Object.keys(errors).length, 0, 'removeDocumentArray should have no errors');

            assert(!(await db.contextBitmapCollection.getBitmap(context)).has(ids[0]), 'Doc1 should be removed from context');
            assert(!(await db.bitmapIndex.getBitmap(feature)).has(ids[0]), 'Doc1 should be removed from feature');
            assert(!(await db.contextBitmapCollection.getBitmap(context)).has(ids[1]), 'Doc2 should be removed from context');
            assert(!(await db.bitmapIndex.getBitmap(feature)).has(ids[1]), 'Doc2 should be removed from feature');

            assert((await db.contextBitmapCollection.getBitmap(context)).has(ids[2]), 'Doc3 should still be in context');
            assert((await db.bitmapIndex.getBitmap(feature)).has(ids[2]), 'Doc3 should still have feature');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'deleteDocumentArray() should delete multiple documents'() {
        let db;
        try {
            db = await initializeTestDB();
            const ids = [];
            ids.push(await db.insertDocument({ schema: 'BaseDocument', data: { name: 'DelArr1' } }));
            ids.push(await db.insertDocument({ schema: 'BaseDocument', data: { name: 'DelArr2' } }));
            ids.push(await db.insertDocument({ schema: 'BaseDocument', data: { name: 'DelArr3NotDeleted' } }));

            const errors = await db.deleteDocumentArray([ids[0], ids[1]]);
            assertEqual(errors.length, 0, 'deleteDocumentArray should have no errors');

            assertEqual(await db.getDocumentById(ids[0]), null, 'Doc1 should be deleted');
            assertEqual(await db.getDocumentById(ids[1]), null, 'Doc2 should be deleted');
            assert(await db.getDocumentById(ids[2]) !== null, 'Doc3 should not be deleted');

            assert(db.deletedDocumentsBitmap.has(ids[0]), 'Doc1 ID should be in deletedDocumentsBitmap');
            assert(db.deletedDocumentsBitmap.has(ids[1]), 'Doc2 ID should be in deletedDocumentsBitmap');
            assert(!db.deletedDocumentsBitmap.has(ids[2]), 'Doc3 ID should not be in deletedDocumentsBitmap');

        } finally {
            await cleanupTestDB(db);
        }
    },

    // --- Checksum-based Getters ---
    async 'getDocumentByChecksumString() should retrieve document by primary checksum'() {
        let db;
        try {
            db = await initializeTestDB();
            const docData = { schema: 'BaseDocument', data: { title: 'Checksum Doc', uniqueField: 'cs123' } };
            const docId = await db.insertDocument(docData);
            const insertedDoc = await db.getDocumentById(docId);
            const primaryChecksum = insertedDoc.getPrimaryChecksum();

            const retrievedDoc = await db.getDocumentByChecksumString(primaryChecksum);
            assert(retrievedDoc !== null, 'Document should be found by primary checksum');
            assertEqual(retrievedDoc.id, docId, 'ID mismatch for checksum retrieval');
            assertEqual(retrievedDoc.data.title, 'Checksum Doc', 'Data mismatch for checksum retrieval');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getDocumentByChecksumString() should return null for non-existent checksum'() {
        let db;
        try {
            db = await initializeTestDB();
            const retrievedDoc = await db.getDocumentByChecksumString('nonexistent:checksum');
            assertEqual(retrievedDoc, null, 'Should return null for non-existent checksum');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getDocumentsByChecksumStringArray() should retrieve multiple documents'() {
        let db;
        try {
            db = await initializeTestDB();
            const docData1 = { schema: 'BaseDocument', data: { title: 'CS Array 1', content: "A" } };
            const docData2 = { schema: 'BaseDocument', data: { title: 'CS Array 2', content: "B" } };
            const doc1 = await db.getDocumentById(await db.insertDocument(docData1));
            const doc2 = await db.getDocumentById(await db.insertDocument(docData2));

            const checksums = [doc1.getPrimaryChecksum(), doc2.getPrimaryChecksum()];
            const retrievedDocs = await db.getDocumentsByChecksumStringArray(checksums);

            assertEqual(retrievedDocs.length, 2, 'Should retrieve 2 documents by checksum array');
            assert(retrievedDocs.some(d => d.id === doc1.id), 'Doc1 missing from checksum array result');
            assert(retrievedDocs.some(d => d.id === doc2.id), 'Doc2 missing from checksum array result');
        } finally {
            await cleanupTestDB(db);
        }
    },

    // --- findDocuments ---
    async 'findDocuments() without filters should return all documents (respecting limit)'() {
        let db;
        try {
            db = await initializeTestDB();
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'FindAll 1' } });
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'FindAll 2' } });
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'FindAll 3' } });

            let allDocs = await db.findDocuments();
            assertEqual(allDocs.length, 3, 'Should return all 3 documents without filters');

            allDocs = await db.findDocuments(null, [], [], { limit: 2 });
            assertEqual(allDocs.length, 2, 'Should respect limit when finding all documents');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'findDocuments() with context filter'() {
        let db;
        try {
            db = await initializeTestDB();
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'CtxFind A1' } }, '/ctxA');
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'CtxFind A2' } }, '/ctxA');
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'CtxFind B1' } }, '/ctxB');

            const ctxADocs = await db.findDocuments('/ctxA');
            assertEqual(ctxADocs.length, 2, 'Should find 2 documents in /ctxA');
            assert(ctxADocs.every(d => d.data.title.startsWith('CtxFind A')), 'Docs in /ctxA have wrong titles');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'findDocuments() with feature filter'() {
        let db;
        try {
            db = await initializeTestDB();
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'FeatFind X1' } }, '/', ['featX']);
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'FeatFind X2' } }, '/', ['featX']);
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'FeatFind Y1' } }, '/', ['featY']);

            const featXDocs = await db.findDocuments(null, ['featX']);
            assertEqual(featXDocs.length, 2, 'Should find 2 documents with featX');
            assert(featXDocs.every(d => d.data.title.startsWith('FeatFind X')), 'Docs with featX have wrong titles');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'findDocuments() with combined context and feature filters'() {
        let db;
        try {
            db = await initializeTestDB();
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'Combo1' } }, '/comboCtx', ['comboFeat']);
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'Combo2' } }, '/comboCtx', ['otherFeat']);
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'Combo3' } }, '/otherCtx', ['comboFeat']);
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'Combo4Target' } }, '/comboCtx', ['comboFeat']);

            const comboDocs = await db.findDocuments('/comboCtx', ['comboFeat']);
            assertEqual(comboDocs.length, 2, 'Should find 2 documents with /comboCtx and comboFeat');
            assert(comboDocs.some(d => d.data.title === 'Combo1'), 'Combo1 missing');
            assert(comboDocs.some(d => d.data.title === 'Combo4Target'), 'Combo4Target missing');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'findDocuments() with additional filterArray'() {
        let db;
        try {
            db = await initializeTestDB();
            // For this test, we need a way to create arbitrary bitmaps for the filterArray.
            // Let's assume 'filterKey1' and 'filterKey2' are such bitmap keys.
            const docId1 = await db.insertDocument({ schema: 'BaseDocument', data: { name: 'FilterArr1' } });
            const docId2 = await db.insertDocument({ schema: 'BaseDocument', data: { name: 'FilterArr2' } });
            const docId3 = await db.insertDocument({ schema: 'BaseDocument', data: { name: 'FilterArr3' } });

            await db.bitmapIndex.tick('customFilter/filterKey1', docId1);
            await db.bitmapIndex.tick('customFilter/filterKey1', docId2);
            await db.bitmapIndex.tick('customFilter/filterKey2', docId2);
            await db.bitmapIndex.tick('customFilter/filterKey2', docId3);

            // Find docs with filterKey1
            let filteredDocs = await db.findDocuments(null, [], ['customFilter/filterKey1']);
            assertEqual(filteredDocs.length, 2, 'Should find 2 docs with filterKey1');
            assert(filteredDocs.some(d => d.id === docId1), 'Doc1 missing for filterKey1');
            assert(filteredDocs.some(d => d.id === docId2), 'Doc2 missing for filterKey1');

            // Find docs with filterKey1 AND filterKey2
            filteredDocs = await db.findDocuments(null, [], ['customFilter/filterKey1', 'customFilter/filterKey2']);
            assertEqual(filteredDocs.length, 1, 'Should find 1 doc with filterKey1 AND filterKey2');
            assertEqual(filteredDocs[0].id, docId2, 'Doc2 should be the one with both filters');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'findDocuments() with options.parse = false'() {
        let db;
        try {
            db = await initializeTestDB();
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'RawFind' } });
            const rawDocs = await db.findDocuments(null, [], [], { parse: false });
            assertEqual(rawDocs.length, 1, 'Should find 1 raw document');
            assert(!(rawDocs[0] instanceof BaseDocument), 'Raw doc should not be BaseDocument instance');
            assertEqual(rawDocs[0].data.title, 'RawFind', 'Raw doc data mismatch');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'findDocuments() returns empty array if no documents match'() {
        let db;
        try {
            db = await initializeTestDB();
            await db.insertDocument({ schema: 'BaseDocument', data: { title: 'Exists' } }, '/realCtx');
            const noMatchDocs = await db.findDocuments('/fakeCtx');
            assertEqual(noMatchDocs.length, 0, 'Should return empty array for no matching documents');
        } finally {
            await cleanupTestDB(db);
        }
    },

    // --- getDocument (convenience) ---
    async 'getDocument() should retrieve by ID and parse by default'() {
        let db;
        try {
            db = await initializeTestDB();
            const docId = await db.insertDocument({ schema: 'BaseDocument', data: { title: 'ConvenienceGet' } });
            const doc = await db.getDocument(docId);
            assert(doc instanceof BaseDocument, 'getDocument should parse by default');
            assertEqual(doc.data.title, 'ConvenienceGet', 'Data mismatch in getDocument');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getDocument() with options.parse = false'() {
        let db;
        try {
            db = await initializeTestDB();
            const docId = await db.insertDocument({ schema: 'BaseDocument', data: { title: 'ConvenienceRaw' } });
            const doc = await db.getDocument(docId, { parse: false });
            assert(!(doc instanceof BaseDocument), 'getDocument should not parse when parse:false');
            assertEqual(doc.data.title, 'ConvenienceRaw', 'Raw data mismatch in getDocument');
        } finally {
            await cleanupTestDB(db);
        }
    }

};

runTestSuite('SynapsD CRUD (Insert, GetById, HasDocument)', crudTestSuite);
