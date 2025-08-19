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
    const numDocuments = 1000; // Stress test with 1000 documents

    try {
        console.log(`Testing concurrent document ID generation with ${numDocuments} documents...`);

        // Clean up any existing test database
        await cleanupTestDB(dbPath);

        const db = new SynapsD({ path: dbPath });
        await db.start();

        console.log('✓ Database started successfully');

        // Check initial document count
        const initialCount = db.documents.getCount();
        console.log('✓ Initial document count:', initialCount);

        // Create many documents concurrently to stress-test for race conditions
        const documentsToInsert = [];
        for (let i = 1; i <= numDocuments; i++) {
            documentsToInsert.push({
                schema: 'data/abstraction/tab',
                data: {
                    url: `http://tab${i}.tld`,
                    title: `Tab ${i}`,
                    timestamp: new Date().toISOString(),
                    index: i, // Add index for verification
                },
            });
        }

        console.log(`✓ Prepared ${documentsToInsert.length} documents for concurrent insertion`);

        // Record start time
        const startTime = Date.now();

        // Insert all documents concurrently in batches to avoid overwhelming the system
        const batchSize = 50;
        const results = [];

        for (let i = 0; i < documentsToInsert.length; i += batchSize) {
            const batch = documentsToInsert.slice(i, i + batchSize);
            console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(documentsToInsert.length / batchSize)}...`);

            const batchPromises = batch.map((doc, index) =>
                db.insertDocument(doc).then(id => ({ batchIndex: Math.floor(i / batchSize), index: i + index, id, doc })),
            );

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
        }

        const endTime = Date.now();
        const duration = endTime - startTime;

        console.log(`✓ All ${results.length} documents inserted concurrently in ${duration}ms`);
        console.log(`✓ Average: ${(duration / results.length).toFixed(2)}ms per document`);

        // Verify all IDs are unique
        const ids = results.map(r => r.id);
        const uniqueIds = new Set(ids);

        console.log('✓ First 10 generated IDs:', ids.slice(0, 10));
        console.log('✓ Last 10 generated IDs:', ids.slice(-10));
        console.log('✓ Unique IDs count:', uniqueIds.size);
        console.log('✓ Total IDs count:', ids.length);

        if (uniqueIds.size !== ids.length) {
            const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
            throw new Error(`Race condition detected! Got ${ids.length} IDs but only ${uniqueIds.size} unique ones. Duplicates: ${JSON.stringify([...new Set(duplicates)])}`);
        }

        console.log('✓ All IDs are unique - no race condition detected');

        // Verify IDs are sequential
        const sortedIds = [...ids].sort((a, b) => a - b);
        const expectedFirstId = 100001;
        let sequentialErrors = 0;

        for (let i = 0; i < sortedIds.length; i++) {
            const expectedId = expectedFirstId + i;
            if (sortedIds[i] !== expectedId) {
                sequentialErrors++;
                if (sequentialErrors <= 5) { // Only log first 5 errors
                    console.log(`! Non-sequential ID at position ${i}: expected ${expectedId}, got ${sortedIds[i]}`);
                }
            }
        }

        if (sequentialErrors > 0) {
            console.log(`! Warning: ${sequentialErrors} non-sequential IDs found (expected due to concurrent insertion)`);
        } else {
            console.log('✓ All IDs are sequential');
        }

        // Verify the correct number of documents were inserted
        const finalCount = db.documents.getCount();
        const documentsAdded = finalCount - initialCount;
        console.log('✓ Final document count:', finalCount);
        console.log('✓ Documents added during test:', documentsAdded);

        if (documentsAdded < documentsToInsert.length) {
            throw new Error(`Expected at least ${documentsToInsert.length} documents to be added, but only ${documentsAdded} were added`);
        }

        // Test bitmap consistency by querying documents by schema
        const schemaResults = await db.findDocuments('/', ['data/abstraction/tab']);
        console.log('✓ Documents found by schema query:', schemaResults.count);

        if (schemaResults.count < numDocuments) {
            throw new Error(`Expected at least ${numDocuments} documents in schema bitmap, but found ${schemaResults.count}`);
        }

        await db.shutdown();
        console.log('✓ Database shutdown successfully');

        // Clean up test database
        await cleanupTestDB(dbPath);

        console.log(`\n✓ All tests passed! Concurrent insertion of ${numDocuments} documents works correctly.`);
        console.log(`✓ Performance: ${(numDocuments / (duration / 1000)).toFixed(0)} documents/second`);

    } catch (error) {
        console.error('✗ Test failed:', error.message);
        console.error(error.stack);

        // Clean up on error
        await cleanupTestDB(dbPath);
        process.exit(1);
    }
}

testConcurrentDocumentInsertion();
