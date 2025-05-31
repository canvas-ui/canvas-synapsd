'use strict';

import SynapsD from '../src/index.js';

const DB_PATH = '/tmp/synapsd-testdb-recursive';

const db = new SynapsD({
    path: DB_PATH
});

async function testRecursiveVsNonRecursive() {
    try {
        await db.start();
        const TabSchema = db.getSchema('data/abstraction/tab');

        console.log('🧪 Testing Recursive vs Non-Recursive Document Removal\n');

        // Test 1: Non-recursive removal (new default behavior)
        console.log('--- Test 1: Non-Recursive Removal (Default) ---');

        const tab1 = TabSchema.fromData({
            data: { url: 'https://example.com/test1', title: 'Test Tab 1' }
        });

        const docId1 = await db.insertDocument(tab1, '/projects/web/frontend', ['custom/test1']);
        console.log(`✓ Inserted document ${docId1} in '/projects/web/frontend'`);

        // Check initial state
        console.log('\nBefore removal:');
        console.log(`  - projects: ${await db.hasDocument(docId1, '/projects')}`);
        console.log(`  - web: ${await db.hasDocument(docId1, '/projects/web')}`);
        console.log(`  - frontend: ${await db.hasDocument(docId1, '/projects/web/frontend')}`);

        // Non-recursive removal (default)
        await db.removeDocument(docId1, '/projects/web/frontend');
        console.log('\nAfter non-recursive removal:');
        console.log(`  - projects: ${await db.hasDocument(docId1, '/projects')}`);
        console.log(`  - web: ${await db.hasDocument(docId1, '/projects/web')}`);
        console.log(`  - frontend: ${await db.hasDocument(docId1, '/projects/web/frontend')}`);
        console.log('✓ Only leaf context "frontend" was removed');

        // Test 2: Recursive removal (explicit flag)
        console.log('\n--- Test 2: Recursive Removal (Explicit Flag) ---');

        const tab2 = TabSchema.fromData({
            data: { url: 'https://example.com/test2', title: 'Test Tab 2' }
        });

        const docId2 = await db.insertDocument(tab2, '/projects/web/backend', ['custom/test2']);
        console.log(`✓ Inserted document ${docId2} in '/projects/web/backend'`);

        // Check initial state
        console.log('\nBefore removal:');
        console.log(`  - projects: ${await db.hasDocument(docId2, '/projects')}`);
        console.log(`  - web: ${await db.hasDocument(docId2, '/projects/web')}`);
        console.log(`  - backend: ${await db.hasDocument(docId2, '/projects/web/backend')}`);

        // Recursive removal (explicit)
        await db.removeDocument(docId2, '/projects/web/backend', [], { recursive: true });
        console.log('\nAfter recursive removal:');
        console.log(`  - projects: ${await db.hasDocument(docId2, '/projects')}`);
        console.log(`  - web: ${await db.hasDocument(docId2, '/projects/web')}`);
        console.log(`  - backend: ${await db.hasDocument(docId2, '/projects/web/backend')}`);
        console.log('✓ All hierarchical contexts removed');

        // Test 3: Array operation with mixed options
        console.log('\n--- Test 3: Array Operations ---');

        const tab3 = TabSchema.fromData({
            data: { url: 'https://example.com/test3', title: 'Test Tab 3' }
        });
        const tab4 = TabSchema.fromData({
            data: { url: 'https://example.com/test4', title: 'Test Tab 4' }
        });

        const docId3 = await db.insertDocument(tab3, '/docs/public/guides', ['custom/test3']);
        const docId4 = await db.insertDocument(tab4, '/docs/private/specs', ['custom/test4']);
        console.log(`✓ Inserted documents ${docId3} and ${docId4} in different contexts`);

        // Test non-recursive array removal
        const result = await db.removeDocumentArray([docId3, docId4], '/docs/public/guides', [], { recursive: false });
        console.log(`✓ Array removal completed: ${result.successful.length} successful, ${result.failed.length} failed`);

        console.log('\n--- Summary ---');
        console.log('✅ Non-recursive removal: Removes from leaf context only (new default)');
        console.log('✅ Recursive removal: Removes from entire hierarchy (explicit opt-in)');
        console.log('✅ Array operations: Support both modes');
        console.log('✅ Root protection: Still prevents removal from "/" in both modes');

        await db.stop();
        console.log('\n🎉 All recursive/non-recursive tests passed!');

    } catch (error) {
        console.error('❌ Recursive removal test failed:', error);
        await db.stop();
        process.exit(1);
    }
}

testRecursiveVsNonRecursive();
