import SynapsD from '../src/index.js'

const db = new SynapsD({
    path: '/tmp/testdb6'
})

import { isDocument, isDocumentInstance } from '../src/schemas/SchemaRegistry.js';

const Note = db.getSchema('data/abstraction/note');
const Tab = db.getSchema('data/abstraction/tab');

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

const tabData3 = {
    schema: 'data/abstraction/tab',
    data: {
        url: 'https://exmapletab3.com',
    }
}
const contextArray = [
    'context/foo',
    'context/baz',
]

const featureArray = [
    'client/os/linux',
    'client/user/fooouser',
    'client/app/firefox',
]


async function test() {
    try {
        await db.start();
        console.log(`\n--- DB Status: ${db.status} ---\n`);
        console.log('Initial Stats:', db.stats);
        console.log('\n--- Inserting Test Documents ---');

        // Insertions with specific context/features
        // We expect these to get IDs like 100001, 100002, etc.
        const tab1Id = await db.insertDocument(tab1Data, ['context/aaa', 'context/bbb'], ['client/os/linux']);
        console.log(`Inserted Tab 1 (ID: ${tab1Id}) with context:[aaa,bbb], features:[linux]`);

        const note1Id = await db.insertDocument(note1Data, ['context/aaa', 'context/ccc'], ['client/os/macos']);
        console.log(`Inserted Note 1 (ID: ${note1Id}) with context:[aaa,ccc], features:[macos]`);

        const tab2Id = await db.insertDocument(tab2Data, ['context/bbb', 'context/ccc'], ['client/os/linux']);
        console.log(`Inserted Tab 2 (ID: ${tab2Id}) with context:[bbb,ccc], features:[linux]`);

        const note2Id = await db.insertDocument(note2Data, ['context/aaa'], ['client/os/macos']);
        console.log(`Inserted Note 2 (ID: ${note2Id}) with context:[aaa], features:[macos]`);

        console.log('\n--- Current Stats ---');
        console.log(db.stats);

        console.log('\n--- Listing Bitmaps (Sanity Check) ---');
        console.log(await db.bitmaps.listBitmaps()); // List all bitmap keys

        console.log('\n--- Testing listDocuments ---');

        // Helper to log results nicely
        const logListResult = async (testCase, context = [], features = [], filters = []) => {
            console.log(`\nTesting: ${testCase}`);
            console.log(`  Context: [${context.join(', ')}]`);
            console.log(`  Features: [${features.join(', ')}]`);
            console.log(`  Filters: [${filters.join(', ')}]`);
            const results = await db.listDocuments(context, features, filters);
            const resultIds = results.map(doc => doc.id).sort(); // Extract and sort IDs
            console.log(`  Result IDs: [${resultIds.join(', ')}]`);
            return resultIds;
        };

        // --- Context Tests (AND logic) ---
        await logListResult('Context AND: aaa & bbb', ['context/aaa', 'context/bbb']); // Expected: tab1Id
        await logListResult('Context AND: aaa & ccc', ['context/aaa', 'context/ccc']); // Expected: note1Id
        await logListResult('Context AND: bbb & ccc', ['context/bbb', 'context/ccc']); // Expected: tab2Id
        await logListResult('Single Context: aaa', ['context/aaa']); // Expected: tab1Id, note1Id, note2Id
        await logListResult('Single Context: bbb', ['context/bbb']); // Expected: tab1Id, tab2Id
        await logListResult('Single Context: ccc', ['context/ccc']); // Expected: note1Id, tab2Id
        await logListResult('Non-existent Context', ['context/nonexistent']); // Expected: []
        await logListResult('Non-existent AND Existing Context', ['context/aaa', 'context/nonexistent']); // Expected: []

        // --- Feature Tests (OR logic internally, then ANDed with context/filters) ---
        await logListResult('Single Feature: linux', [], ['client/os/linux']); // Expected: tab1Id, tab2Id
        await logListResult('Single Feature: macos', [], ['client/os/macos']); // Expected: note1Id, note2Id
        await logListResult('Multiple Features (OR): linux OR macos', [], ['client/os/linux', 'client/os/macos']); // Expected: tab1Id, note1Id, tab2Id, note2Id

        // --- Combined Context (AND) & Feature (OR) Tests ---
        // Result = AND(context) AND OR(features)
        await logListResult('Context bbb AND Feature macos', ['context/bbb'], ['client/os/macos']); // Expected: [] (bbb={t1,t2}, macos={n1,n2} -> intersection={})
        await logListResult('Context aaa AND Feature linux', ['context/aaa'], ['client/os/linux']); // Expected: tab1Id (aaa={t1,n1,n2}, linux={t1,t2} -> intersection={t1})

        // --- Filter Array Tests (AND logic) ---
        // This ANDs all filters in the array
        await logListResult('Filter Array: context/aaa AND client/os/linux', [], [], ['context/aaa', 'client/os/linux']); // Expected: tab1Id
        await logListResult('Filter Array: context/ccc AND client/os/macos', [], [], ['context/ccc', 'client/os/macos']); // Expected: note1Id

        // --- No Filters ---
        await logListResult('No Filters', [], [], []); // Expected: tab1Id, note1Id, tab2Id, note2Id


        console.log('\n--- Listing Bitmaps (Sanity Check) ---');
        console.log(await db.bitmaps.listBitmaps());

        console.log('\n---List Documents test ---');
        let res = await db.listDocuments(['context/aaa', 'context/bbb']);
        console.log(res);

        console.log('\n--- Test Complete ---');

    } catch (error) {
        console.error("\n*** TEST FAILED ***");
        console.error(error);
    } finally {
        // Optional: Clean up DB if needed, or just leave it for inspection
        // await db.shutdown();
        // console.log('DB Shutdown.');
    }
}

test();
