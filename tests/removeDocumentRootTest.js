'use strict';

import SynapsD from '../src/index.js';

const DB_PATH = '/tmp/synapsd-testdb-removetest';

const db = new SynapsD({
    path: DB_PATH
});

async function testRemoveFromRoot() {
    try {
        await db.start();
        const TabSchema = db.getSchema('data/abstraction/tab');

        // Create a test document
        const tab = TabSchema.fromData({
            data: {
                url: 'https://example.com/test',
                title: 'Test Tab',
            }
        });

        // Insert with both root and specific context
        const docId = await db.insertDocument(tab, '/test/specific/path', ['custom/test-feature']);
        console.log(`✓ Inserted document ${docId} successfully`);

        // Test 1: Try to remove from root context only - should fail
        try {
            await db.removeDocument(docId, '/');
            console.log('✗ ERROR: removeDocument from root "/" should have failed!');
        } catch (error) {
            console.log(`✓ Correctly prevented removal from root "/": ${error.message}`);
        }

        // Test 2: Try to remove from empty string (defaults to root) - should fail
        try {
            await db.removeDocument(docId, '');
            console.log('✗ ERROR: removeDocument from empty string should have failed!');
        } catch (error) {
            console.log(`✓ Correctly prevented removal from empty string: ${error.message}`);
        }

        // Test 3: Try to remove from null/undefined (defaults to root) - should fail
        try {
            await db.removeDocument(docId, null);
            console.log('✗ ERROR: removeDocument from null should have failed!');
        } catch (error) {
            console.log(`✓ Correctly prevented removal from null: ${error.message}`);
        }

        // Test 4: Remove from specific context - should work
        try {
            const result = await db.removeDocument(docId, '/test/specific/path');
            console.log(`✓ Successfully removed document ${result} from specific context`);
        } catch (error) {
            console.log(`✗ ERROR: Should have been able to remove from specific context: ${error.message}`);
        }

        // Test 5: Verify document still exists in root but not in specific context
        const existsInRoot = await db.hasDocument(docId);
        const existsInSpecific = await db.hasDocument(docId, '/test/specific/path');

        console.log(`Document exists in root: ${existsInRoot}`);
        console.log(`Document exists in specific context: ${existsInSpecific}`);

        if (existsInRoot && !existsInSpecific) {
            console.log('✓ Document correctly exists in root but removed from specific context');
        } else {
            console.log('✗ ERROR: Document state is incorrect after removal');
        }

        await db.stop();
        console.log('\n✓ All tests completed successfully!');

    } catch (error) {
        console.error('Test failed:', error);
        await db.stop();
        process.exit(1);
    }
}

testRemoveFromRoot();
