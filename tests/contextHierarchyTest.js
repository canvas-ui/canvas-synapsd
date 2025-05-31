'use strict';

import SynapsD from '../src/index.js';

const DB_PATH = '/tmp/synapsd-testdb-hierarchy';

const db = new SynapsD({
    path: DB_PATH
});

async function testCurrentHierarchyBehavior() {
    try {
        await db.start();
        const TabSchema = db.getSchema('data/abstraction/tab');

        // Create a test document
        const tab = TabSchema.fromData({
            data: {
                url: 'https://example.com/hierarchy-test',
                title: 'Hierarchy Test Tab',
            }
        });

        // Insert document in a deep path
        const docId = await db.insertDocument(tab, '/projects/web/frontend', ['custom/hierarchy-feature']);
        console.log(`✓ Inserted document ${docId} in '/projects/web/frontend'`);

        // Check what contexts the document exists in
        console.log('\n--- Initial document context presence ---');
        console.log(`Document in root "/": ${await db.hasDocument(docId, '/')}`);
        console.log(`Document in "projects": ${await db.hasDocument(docId, '/projects')}`);
        console.log(`Document in "web": ${await db.hasDocument(docId, '/projects/web')}`);
        console.log(`Document in "frontend": ${await db.hasDocument(docId, '/projects/web/frontend')}`);

        // Now remove from the full path and see what happens
        console.log('\n--- Removing from "/projects/web/frontend" ---');
        await db.removeDocument(docId, '/projects/web/frontend');

        // Check what contexts remain after removal
        console.log('\n--- Document context presence after removal ---');
        console.log(`Document in root "/": ${await db.hasDocument(docId, '/')}`);
        console.log(`Document in "projects": ${await db.hasDocument(docId, '/projects')}`);
        console.log(`Document in "web": ${await db.hasDocument(docId, '/projects/web')}`);
        console.log(`Document in "frontend": ${await db.hasDocument(docId, '/projects/web/frontend')}`);

        await db.stop();
        console.log('\n✓ Hierarchy behavior test completed!');

    } catch (error) {
        console.error('Hierarchy test failed:', error);
        await db.stop();
        process.exit(1);
    }
}

testCurrentHierarchyBehavior();
