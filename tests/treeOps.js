'use strict';

import SynapsD from '../src/index.js';
import util from 'util'; // For deep logging

// Use the same DB path as _test.js to potentially reuse data/layers
const DB_PATH = '/tmp/synapsd-testdb';

const db = new SynapsD({
    path: DB_PATH
});

/**
 * Test Data
 */
const noteA = {
    schema: 'data/abstraction/note',
    data: { title: 'Note A', content: 'Content for A' }
};
const noteB = {
    schema: 'data/abstraction/note',
    data: { title: 'Note B', content: 'Content for B' }
};
const tabC = {
    schema: 'data/abstraction/tab',
    data: { title: 'Tab C', url: 'https://example.com/c' }
};
const noteD = {
    schema: 'data/abstraction/note',
    data: { title: 'Note D', content: 'Content for D' }
};

async function testTreeOperations() {
    try {
        await db.start();
        console.log(`\n--- DB Status: ${db.status} ---\n`);

        console.log('--- Initial Tree Structure ---');
        // Use util.inspect for better deep object logging
        console.log(util.inspect(db.tree.jsonTree, { showHidden: false, depth: null, colors: true }));

        console.log('\n--- Inserting Documents with Paths ---');

        const idA = await db.insertDocument(noteA, '/work/projectA');
        console.log(`Inserted Note A (ID: ${idA}) into path /work/projectB`);

        const idB = await db.insertDocument(noteB, '/work/project');
        console.log(`Inserted Note B (ID: ${idB}) into path /work/projectA/notes`);

        const idC = await db.insertDocument(tabC, '/work/projectA');
        console.log(`Inserted Tab C (ID: ${idC}) into path /work/projectA`);

        const idD = await db.insertDocument(noteD, '/personal/journal');
        console.log(`Inserted Note D (ID: ${idD}) into path /personal/journal`);

        // Insert one doc with no path (should default to root)
        const idRoot = await db.insertDocument({ schema: 'data/abstraction/note', data: { title: 'Root Note' } }, null);
        console.log(`Inserted Root Note (ID: ${idRoot}) with null path`);


        console.log('\n--- Tree Structure After Inserts ---');
        console.log(util.inspect(db.tree.buildJsonTree(), { showHidden: false, depth: null, colors: true }));

        console.log('\n--- Listing Documents by Path ---');

        const listAndLog = async (path) => {
            console.log(`\nListing documents for path: "${path}"`);
            const results = await db.listDocuments(path);
            const resultInfo = results.map(doc => ({ id: doc.id, schema: doc.schema, title: doc.data?.title || doc.data?.url }));
            console.log('  Results:', resultInfo);
        };

        await listAndLog('/work/projectA/notes'); // Expected: Note A, Note B
        await listAndLog('/work/projectA'); // Expected: Note A, Note B, Tab C
        await listAndLog('/personal/journal'); // Expected: Note D
        await listAndLog('/'); // Expected: idRoot plus potentially others if reusing db
        await listAndLog('/non/existent'); // Expected: []

        console.log('\n--- Test Complete ---');

        console.log(JSON.stringify(db.tree.buildJsonTree(), null, 2 ));

    } catch (error) {
        console.error("\n*** TEST FAILED ***");
        console.error(error);
    } finally {
        // Optional: Shut down DB
        // await db.shutdown();
        // console.log('DB Shutdown.');
    }
}

testTreeOperations();
