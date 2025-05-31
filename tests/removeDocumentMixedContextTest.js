'use strict';

import SynapsD from '../src/index.js';

const DB_PATH = '/tmp/synapsd-testdb-mixedtest';

const db = new SynapsD({
    path: DB_PATH
});

async function testMixedContextRemoval() {
    try {
        await db.start();
        const TabSchema = db.getSchema('data/abstraction/tab');

        // Create a test document
        const tab = TabSchema.fromData({
            data: {
                url: 'https://example.com/mixed-test',
                title: 'Mixed Context Test Tab',
            }
        });

        // Insert document in multiple contexts
        const docId = await db.insertDocument(tab, '/test/path1', ['custom/mixed-feature']);

        // Also insert it in another path manually to simulate a document in multiple contexts
        await db.updateDocument(docId, null, '/test/path2', []);

        console.log(`✓ Inserted document ${docId} in multiple contexts`);

        // Verify document exists in both contexts initially
        const existsInPath1Before = await db.hasDocument(docId, '/test/path1');
        const existsInPath2Before = await db.hasDocument(docId, '/test/path2');
        const existsInRootBefore = await db.hasDocument(docId);

        console.log(`Before removal - Path1: ${existsInPath1Before}, Path2: ${existsInPath2Before}, Root: ${existsInRootBefore}`);

        // Test: Remove from a mixed context array that includes root "/" plus specific paths
        // This should filter out the "/" and only remove from the specific paths
        try {
            const result = await db.removeDocument(docId, ['/test/path1', '/', '/test/path2']);
            console.log(`✓ Successfully removed document ${result} from mixed context (root should be filtered out)`);
        } catch (error) {
            console.log(`✗ ERROR: Should have been able to remove from mixed context: ${error.message}`);
        }

        // Verify document state after removal
        const existsInPath1After = await db.hasDocument(docId, '/test/path1');
        const existsInPath2After = await db.hasDocument(docId, '/test/path2');
        const existsInRootAfter = await db.hasDocument(docId);

        console.log(`After removal - Path1: ${existsInPath1After}, Path2: ${existsInPath2After}, Root: ${existsInRootAfter}`);

        // Document should still exist in root but not in specific paths
        if (!existsInPath1After && !existsInPath2After && existsInRootAfter) {
            console.log('✓ Document correctly removed from specific contexts but preserved in root');
        } else {
            console.log('✗ ERROR: Document state is incorrect after mixed context removal');
        }

        await db.stop();
        console.log('\n✓ Mixed context test completed successfully!');

    } catch (error) {
        console.error('Mixed context test failed:', error);
        await db.stop();
        process.exit(1);
    }
}

testMixedContextRemoval();
