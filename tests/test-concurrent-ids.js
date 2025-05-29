import SynapsD from '../src/index.js';
import fs from 'fs';
import path from 'path';

async function cleanupTestDB(dbPath) {
    try {
        if (fs.existsSync(dbPath)) {
            fs.rmSync(dbPath, { recursive: true, force: true });
            console.log(`✓ Cleaned up test database: ${dbPath}`);
        }
    } catch (error) {
        console.log(`! Warning: Could not clean up ${dbPath}: ${error.message}`);
    }
}

async function testConcurrentDocumentInsertion() {
    const dbPath = './test-db-concurrent';

    try {
        console.log('Testing concurrent document ID generation...');

        // Clean up any existing test database
        await cleanupTestDB(dbPath);

        const db = new SynapsD({ path: dbPath });
        await db.start();

        console.log('✓ Database started successfully');

        // Check initial document count
        const initialCount = db.documents.getCount();
        console.log('✓ Initial document count:', initialCount);

        // Create multiple documents concurrently to test for race conditions
        const documentsToInsert = [
            { schema: 'data/abstraction/tab', data: { url: 'http://tab1.tld', title: 'Tab 1', timestamp: new Date().toISOString() } },
            { schema: 'data/abstraction/tab', data: { url: 'http://tab2.tld', title: 'Tab 2', timestamp: new Date().toISOString() } },
            { schema: 'data/abstraction/tab', data: { url: 'http://tab3.tld', title: 'Tab 3', timestamp: new Date().toISOString() } },
            { schema: 'data/abstraction/tab', data: { url: 'http://tab4.tld', title: 'Tab 4', timestamp: new Date().toISOString() } },
            { schema: 'data/abstraction/tab', data: { url: 'http://tab5.tld', title: 'Tab 5', timestamp: new Date().toISOString() } },
        ];

        console.log(`✓ Prepared ${documentsToInsert.length} documents for concurrent insertion`);

        // Insert all documents concurrently
        const insertPromises = documentsToInsert.map((doc, index) =>
            db.insertDocument(doc).then(id => ({ index, id, doc }))
        );

        const results = await Promise.all(insertPromises);
        console.log('✓ All documents inserted concurrently');

        // Verify all IDs are unique
        const ids = results.map(r => r.id);
        const uniqueIds = new Set(ids);

        console.log('✓ Generated IDs:', ids);
        console.log('✓ Unique IDs count:', uniqueIds.size);
        console.log('✓ Total IDs count:', ids.length);

        if (uniqueIds.size !== ids.length) {
            throw new Error(`Race condition detected! Got ${ids.length} IDs but only ${uniqueIds.size} unique ones: ${JSON.stringify(ids)}`);
        }

        console.log('✓ All IDs are unique - no race condition detected');

        // Verify the correct number of actual documents were inserted (not counting placeholders)
        const finalCount = db.documents.getCount();
        const documentsAdded = finalCount - initialCount;
        console.log('✓ Final document count:', finalCount);
        console.log('✓ Documents added during test:', documentsAdded);

        // The actual documents + some reserved placeholders should equal the total count
        // We expect at least our documents to be inserted
        if (documentsAdded < documentsToInsert.length) {
            throw new Error(`Expected at least ${documentsToInsert.length} documents to be added, but only ${documentsAdded} were added`);
        }

        await db.shutdown();
        console.log('✓ Database shutdown successfully');

        // Clean up test database
        await cleanupTestDB(dbPath);

        console.log('\n✓ All tests passed! Concurrent ID generation works correctly.');

    } catch (error) {
        console.error('✗ Test failed:', error.message);
        console.error(error.stack);

        // Clean up on error
        await cleanupTestDB(dbPath);
        process.exit(1);
    }
}

testConcurrentDocumentInsertion();
