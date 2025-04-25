import SynapsD from '../src/index.js'
import fs from 'fs';
import path from 'path';
import assert from 'assert';

// Test database path
const DB_PATH = '/tmp/synapsd-test-crud';

// Remove existing test database if it exists
if (fs.existsSync(DB_PATH)) {
    fs.rmSync(DB_PATH, { recursive: true, force: true });
}

// Create a fresh database instance
const db = new SynapsD({
    path: DB_PATH
});

// Error tracking for summary
const testResults = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    errors: []
};

/**
 * Test helper functions
 */
function test(name, fn) {
    testResults.total++;
    try {
        fn();
        console.log(`✅ PASS: ${name}`);
        testResults.passed++;
    } catch (error) {
        console.error(`❌ FAIL: ${name}`);
        console.error(`   Error: ${error.message}`);
        testResults.failed++;
        testResults.errors.push({ name, error });
    }
}

/**
 * Sample documents
 */

const note1Data = {
    schema: 'data/abstraction/note',
    data: {
        title: 'Note 1',
        content: 'Content for note 1',
    }
}

const note2Data = {
    schema: 'data/abstraction/note',
    data: {
        title: 'Note 2',
        content: 'Content for note 2',
    }
}

const tab1Data = {
    schema: 'data/abstraction/tab',
    data: {
        url: 'https://example.com/tab1',
        title: 'Tab 1'
    }
}

const tab2Data = {
    schema: 'data/abstraction/tab',
    data: {
        url: 'https://example.com/tab2',
        title: 'Tab 2'
    }
}

const contextArray = [
    'foo',
    'bar',
    'baz',
]

const featureArray = [
    'client/os/linux',
    'client/user/fooouser',
    'client/app/firefox',
]

/**
 * Main test function
 */
async function runTests() {
    console.log('Starting SynapsD CRUD tests...');

    try {
        // Start the database
        await db.start();
        console.log('Database started successfully');

        // Run all tests
        await testCreate();
        await testRead();
        await testUpdate();
        await testDelete();

        // Print test summary
        console.log('\n--- Test Summary ---');
        console.log(`Total tests: ${testResults.total}`);
        console.log(`Passed: ${testResults.passed}`);
        console.log(`Failed: ${testResults.failed}`);

        if (testResults.errors.length > 0) {
            console.log('\n--- Failed Tests ---');
            testResults.errors.forEach(({ name, error }, index) => {
                console.log(`${index + 1}. ${name}: ${error.message}`);
            });
        }
    } catch (error) {
        console.error('Error running tests:', error);
    } finally {
        // Shutdown the database
        await db.shutdown();
        console.log('Database shut down');
    }
}

/**
 * CREATE tests
 */
async function testCreate() {
    console.log('\n=== Testing CREATE operations ===');

    // Test insertDocument
    test('insertDocument - basic', async () => {
        const id = await db.insertDocument(note1Data);
        console.log(id);
        assert(id && typeof id === 'number', 'Should return a numeric ID');
    });

    // Test insertDocument with context and features
    test('insertDocument - with context and features', async () => {
        const id = await db.insertDocument(note2Data, contextArray, featureArray);
        assert(id && typeof id === 'number', 'Should return a numeric ID');

        // Verify document has correct context and features
        const hasDoc = await db.hasDocument(id, contextArray[0], featureArray[0]);
        assert(hasDoc, 'Document should exist in specified context and feature');
    });

    // Test insertDocumentArray
    test('insertDocumentArray', async () => {
        const errors = await db.insertDocumentArray([tab1Data, tab2Data], contextArray, featureArray);
        assert(Array.isArray(errors) && errors.length === 0, 'Should return empty errors array');

        // Use listDocuments to verify insertion worked
        const tabs = await db.listDocuments('/', 'data/abstraction/tab');
        assert(tabs.length === 2, 'Should have inserted 2 tabs');
    });
}

/**
 * READ tests
 */
async function testRead() {
    console.log('\n=== Testing READ operations ===');

    // Insert test data first
    let note1Id, note2Id;
    try {
        note1Id = await db.insertDocument(note1Data);
        console.log('inserted note1');
        console.log(note1Id);
        note2Id = await db.insertDocument(note2Data, 'test_context');
        console.log('inserted note2');
        console.log(note2Id);
    } catch (error) {
        console.error('Failed to insert test data for READ tests:', error);
        return;
    }

    // Test getById
    test('getById', async () => {
        const note = await db.getById(note1Id);
        assert(note && note.schema === 'data/abstraction/note', 'Should retrieve document with correct schema');
        console.log(note);
        assert(note.data && note.data.title === note1Data.data.title, 'Should have correct title');
    });

    // Test getByIdArray
    test('getByIdArray', async () => {
        const notes = await db.getByIdArray([note1Id, note2Id]);
        assert(Array.isArray(notes) && notes.length === 2, 'Should retrieve 2 documents');
        assert(notes[0].id === note1Id || notes[1].id === note1Id, 'Should retrieve first document');
        assert(notes[0].id === note2Id || notes[1].id === note2Id, 'Should retrieve second document');
    });

    // Test hasDocument
    test('hasDocument', async () => {
        const exists = await db.hasDocument(note1Id);
        assert(exists, 'Document should exist');

        const doesNotExist = await db.hasDocument(99999999);
        assert(!doesNotExist, 'Non-existent document should return false');
    });

    // Test hasDocumentByChecksum
    test('hasDocumentByChecksum', async () => {
        const note = await db.getById(note1Id);
        const checksum = note.getPrimaryChecksum();

        const exists = await db.hasDocumentByChecksum(checksum);
        assert(exists, 'Document should exist by checksum');
    });

    // Test listDocuments
    test('listDocuments - all documents', async () => {
        const docs = await db.listDocuments();
        assert(docs.length >= 2, 'Should retrieve at least 2 documents');
    });

    // Test listDocuments with context
    test('listDocuments - with context', async () => {
        const docs = await db.listDocuments('test_context');
        assert(docs.length >= 1, 'Should retrieve at least 1 document');

        // At least one document should have note2's data
        const hasNote2 = docs.some(doc =>
            doc.data.title === 'Note 2' && doc.data.content === 'Content for note 2'
        );
        assert(hasNote2, 'Should retrieve Note 2 in test_context');
    });

    // Test listDocuments with feature filter
    test('listDocuments - with feature', async () => {
        const docs = await db.listDocuments('/', 'data/abstraction/note');
        assert(docs.length >= 2, 'Should retrieve at least 2 note documents');
        assert(docs.every(doc => doc.schema === 'data/abstraction/note'), 'All documents should be notes');
    });

    // Test getByChecksumString
    test('getByChecksumString', async () => {
        const note = await db.getById(note1Id);
        const checksum = note.getPrimaryChecksum();
        const retrievedNote = await db.getByChecksumString(checksum);
        assert(retrievedNote && retrievedNote.id === note.id, 'Should retrieve correct document by checksum');
    });
}

/**
 * UPDATE tests
 */
async function testUpdate() {
    console.log('\n=== Testing UPDATE operations ===');

    // Insert test data first
    let noteId;
    try {
        noteId = await db.insertDocument(note1Data);
    } catch (error) {
        console.error('Failed to insert test data for UPDATE tests:', error);
        return;
    }

    // Test updateDocument
    test('updateDocument - update data', async () => {
        // Get the document to update
        const note = await db.getById(noteId);

        // Modify the data
        note.data.title = 'Updated Note Title';
        note.data.content = 'Updated content for note';

        // Update the document
        const updatedId = await db.updateDocument(noteId, note);
        assert(updatedId === noteId, 'Should return the same ID');

        // Verify the update worked
        const updatedNote = await db.getById(noteId);
        assert(updatedNote.data.title === 'Updated Note Title', 'Title should be updated');
        assert(updatedNote.data.content === 'Updated content for note', 'Content should be updated');
    });

    // Test updateDocument with new context
    test('updateDocument - with new context', async () => {
        const updatedId = await db.updateDocument(noteId, null, 'new_context');
        assert(updatedId === noteId, 'Should return the same ID');

        // Verify the document is in the new context
        const hasDoc = await db.hasDocument(noteId, 'new_context');
        assert(hasDoc, 'Document should exist in new context');
    });

    // Test updateDocument with new features
    test('updateDocument - with new features', async () => {
        const updatedId = await db.updateDocument(
            noteId,
            null,
            null,
            ['test_feature']
        );
        assert(updatedId === noteId, 'Should return the same ID');

        // Verify the document has the new feature
        const hasDoc = await db.hasDocument(noteId, null, ['test_feature']);
        assert(hasDoc, 'Document should have new feature');
    });

    // Test updateDocumentArray
    test('updateDocumentArray', async () => {
        // Insert two test documents
        const id1 = await db.insertDocument({
            schema: 'data/abstraction/note',
            data: { title: 'Batch Update 1', content: 'Content 1' }
        });

        const id2 = await db.insertDocument({
            schema: 'data/abstraction/note',
            data: { title: 'Batch Update 2', content: 'Content 2' }
        });

        // Get the documents to update
        const doc1 = await db.getById(id1);
        const doc2 = await db.getById(id2);

        // Modify the data
        doc1.data.title = 'Updated Batch 1';
        doc2.data.title = 'Updated Batch 2';

        // Update both documents
        const errors = await db.updateDocumentArray([doc1, doc2], 'batch_context');
        assert(Array.isArray(errors) && errors.length === 0, 'Should return empty errors array');

        // Verify the updates worked
        const updatedDoc1 = await db.getById(id1);
        const updatedDoc2 = await db.getById(id2);

        assert(updatedDoc1.data.title === 'Updated Batch 1', 'First document should be updated');
        assert(updatedDoc2.data.title === 'Updated Batch 2', 'Second document should be updated');

        // Verify they're in the batch_context
        const docsInContext = await db.listDocuments('batch_context');
        assert(docsInContext.some(d => d.id === id1), 'First document should be in batch_context');
        assert(docsInContext.some(d => d.id === id2), 'Second document should be in batch_context');
    });
}

/**
 * DELETE tests
 */
async function testDelete() {
    console.log('\n=== Testing DELETE operations ===');

    // Insert test data first
    let noteId, tabId;
    try {
        noteId = await db.insertDocument(note1Data, 'delete_context', ['delete_feature']);
        tabId = await db.insertDocument(tab1Data, 'delete_context', ['delete_feature']);
    } catch (error) {
        console.error('Failed to insert test data for DELETE tests:', error);
        return;
    }

    // Test removeDocument (removes from context/features but keeps in DB)
    test('removeDocument', async () => {
        await db.removeDocument(noteId, 'delete_context');

        // Document should still exist in the database
        const stillExists = await db.hasDocument(noteId);
        assert(stillExists, 'Document should still exist in database');

        // But should not be in the context anymore
        const notInContext = await db.hasDocument(noteId, 'delete_context');
        assert(!notInContext, 'Document should be removed from context');
    });

    // Test removeDocumentArray
    test('removeDocumentArray', async () => {
        // Create another document for batch removal
        const noteId2 = await db.insertDocument(note2Data, 'batch_remove_context');

        // Remove both documents from their contexts
        const errors = await db.removeDocumentArray([noteId, noteId2], 'batch_remove_context');
        assert(Array.isArray(errors) && Object.keys(errors).length === 0, 'Should return empty errors object');

        // Both should still exist in the database
        const stillExists1 = await db.hasDocument(noteId);
        const stillExists2 = await db.hasDocument(noteId2);
        assert(stillExists1 && stillExists2, 'Documents should still exist in database');

        // But not in the batch_remove_context
        const docs = await db.listDocuments('batch_remove_context');
        assert(!docs.some(d => d.id === noteId2), 'Documents should be removed from context');
    });

    // Test deleteDocument (completely removes from DB)
    test('deleteDocument', async () => {
        const result = await db.deleteDocument(tabId);
        assert(result === true, 'Should return true for successful deletion');

        // Document should not exist anymore
        const exists = await db.hasDocument(tabId);
        assert(!exists, 'Document should not exist after deletion');
    });

    // Test deleteDocumentArray
    test('deleteDocumentArray', async () => {
        // Create two documents for batch deletion
        const id1 = await db.insertDocument({
            schema: 'data/abstraction/note',
            data: { title: 'Delete Batch 1', content: 'Content 1' }
        });

        const id2 = await db.insertDocument({
            schema: 'data/abstraction/note',
            data: { title: 'Delete Batch 2', content: 'Content 2' }
        });

        // Delete both documents
        const errors = await db.deleteDocumentArray([id1, id2]);
        assert(Array.isArray(errors) && errors.length === 0, 'Should return empty errors array');

        // Neither document should exist
        const exists1 = await db.hasDocument(id1);
        const exists2 = await db.hasDocument(id2);
        assert(!exists1 && !exists2, 'Documents should not exist after batch deletion');
    });
}

// Run the tests
runTests()
    .then(() => console.log('Tests completed'))
    .catch(err => console.error('Error during tests:', err));
