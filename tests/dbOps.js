import SynapsD from '../src/index.js'

const db = new SynapsD({
    path: '/tmp/synapsd-testdb'
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

        // --- Clean slate ---
        console.log('\n--- Clearing existing data (if any) ---');
        const allDocs = await db.listDocuments();
        const allIds = allDocs.map(d => d.id);
        if (allIds.length > 0) {
            console.log(`Deleting ${allIds.length} existing documents...`);
            await db.deleteDocumentArray(allIds);
            console.log('Existing documents deleted.');
            // Reset relevant bitmaps (optional, depends on test needs)
            await db.bitmaps.deleteBitmap('internal/gc/deleted');
            await db.bitmaps.deleteBitmap('internal/action/created');
            await db.bitmaps.deleteBitmap('internal/action/updated');
            await db.bitmaps.deleteBitmap('internal/action/deleted');
            // Reinitialize action bitmaps if necessary
            db.deletedDocumentsBitmap = await db.bitmaps.createBitmap('internal/gc/deleted');
            db.actionBitmaps = {
                 created: await db.bitmaps.createBitmap('internal/action/created'),
                 updated: await db.bitmaps.createBitmap('internal/action/updated'),
                 deleted: await db.bitmaps.createBitmap('internal/action/deleted'),
            };
            console.log('Internal bitmaps reset.');
        } else {
            console.log('No existing documents found to clear.');
        }
        console.log('Initial Stats After Clearing:', db.stats);


        console.log('\n--- Inserting Valid Test Documents ---');

        // Insertions with specific context/features
        // We expect these to get IDs like 100001, 100002, etc. if starting fresh
        const tab1Id = await db.insertDocument(tab1Data, ['context/aaa', 'context/bbb'], ['client/os/linux']);
        console.log(`Inserted Tab 1 (ID: ${tab1Id}) with context:[aaa,bbb], features:[linux]`);

        const note1Id = await db.insertDocument(note1Data, ['context/aaa', 'context/ccc'], ['client/os/macos']);
        console.log(`Inserted Note 1 (ID: ${note1Id}) with context:[aaa,ccc], features:[macos]`);

        const tab2Id = await db.insertDocument(tab2Data, ['context/bbb', 'context/ccc'], ['client/os/linux']);
        console.log(`Inserted Tab 2 (ID: ${tab2Id}) with context:[bbb,ccc], features:[linux]`);

        const note2Id = await db.insertDocument(note2Data, ['context/aaa'], ['client/os/macos']);
        console.log(`Inserted Note 2 (ID: ${note2Id}) with context:[aaa], features:[macos]`);

        console.log('\n--- Current Stats After Valid Insertions ---');
        console.log(db.stats);


        console.log('\n--- Testing listDocuments (Standard Cases) ---');

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


        console.log('\n--- Testing Invalid/Non-Standard Insertions ---');

        // Test case helper for expected errors
        const testInsertionError = async (testName, docData, context, features) => {
            console.log(`\nTesting Error Case: ${testName}`);
            try {
                await db.insertDocument(docData, context, features);
                console.error(`  [FAIL] Expected an error but insertion succeeded.`);
            } catch (error) {
                console.log(`  [PASS] Received expected error: ${error.message}`);
            }
        };

        // 1. Null/Undefined document
        await testInsertionError('Null Document', null);
        await testInsertionError('Undefined Document', undefined);

        // 2. Missing Schema
        await testInsertionError('Missing Schema', { data: { title: 'No Schema' } });

        // 3. Invalid Schema
        await testInsertionError('Invalid Schema', { schema: 'invalid/schema/path', data: { title: 'Bad Schema' } });

        // 4. Missing Data property
        await testInsertionError('Missing Data Property', { schema: 'data/abstraction/note' });

        // 5. Invalid Data according to Schema (Invalid URL for Tab)
        await testInsertionError('Invalid Data (Bad URL)', { schema: 'data/abstraction/tab', data: { url: 'not-a-valid-url', title: 'Bad URL Tab' } });

        // 6. Invalid Data (Missing required field - URL for Tab)
        await testInsertionError('Invalid Data (Missing URL)', { schema: 'data/abstraction/tab', data: { title: 'Missing URL Tab' } });

        // 7. Inserting a pre-made instance (should work fine)
        console.log(`\nTesting: Inserting pre-made Tab instance`);
        try {
            const preMadeTab = Tab.fromData({ schema: 'data/abstraction/tab', data: { url: 'http://premade.com', title: 'Pre-made' } });
            const preMadeId = await db.insertDocument(preMadeTab, ['context/premade']);
            console.log(`  [PASS] Inserted pre-made instance with ID: ${preMadeId}`);
            // Verify it exists
            const fetched = await db.getById(preMadeId);
            if (fetched && fetched.data.title === 'Pre-made') {
                 console.log(`  [PASS] Verified pre-made instance exists.`);
            } else {
                 console.error(`  [FAIL] Failed to verify pre-made instance.`);
            }
        } catch (error) {
            console.error(`  [FAIL] Error inserting pre-made instance: ${error.message}`);
        }

        // 8. Invalid contextSpec type (should throw in #parseContextSpec, caught by insertDocument)
        await testInsertionError('Invalid contextSpec (number)', tabData3, 123);
        await testInsertionError('Invalid contextSpec (object)', tabData3, { context: 'invalid' });

        // 9. Invalid featureBitmapArray type (should throw in insertDocument)
        await testInsertionError('Invalid featureBitmapArray (string)', tabData3, '/', 'not-an-array');
        await testInsertionError('Invalid featureBitmapArray (object)', tabData3, '/', { feature: 'invalid' });


        console.log('\n--- Testing Updates with Edge Cases ---');
        // Helper for update errors
        const testUpdateError = async (testName, docIdOrData, context, features) => {
             console.log(`\nTesting Update Error Case: ${testName}`);
             try {
                 await db.updateDocument(docIdOrData, context, features);
                 console.error(`  [FAIL] Expected an error but update succeeded.`);
             } catch (error) {
                 console.log(`  [PASS] Received expected error: ${error.message}`);
             }
        };

        // 1. Update non-existent ID
        await testUpdateError('Update Non-existent ID', 'non-existent-id-123');

        // 2. Update with data object missing ID
        await testUpdateError('Update Data Missing ID', { schema: 'data/abstraction/tab', data: { url: 'http://update.fail', title: 'No ID Update' } });

        // 3. Update with invalid data (should fail validation within update)
        const invalidUpdateData = { id: tab1Id, schema: 'data/abstraction/tab', data: { url: 'invalid-update-url' } };
        // Need to use the correct signature for updateDocument now
        await testUpdateError('Update With Invalid Data', tab1Id, invalidUpdateData);

        // 4. Update using object instance (should work)
        console.log(`\nTesting: Update using Tab instance`);
        try {
            const tabToUpdate = await db.getById(tab1Id);
            if (!tabToUpdate) throw new Error('Could not fetch tab1Id for update test');
            tabToUpdate.data.title = "Updated Title via Instance";
            const updatedId = await db.updateDocument(tabToUpdate, ['context/updated']);
            console.log(`  [PASS] Updated instance with ID: ${updatedId}`);
             // Verify it exists and was updated
             const fetched = await db.getById(updatedId); // updatedId should === tab1Id
             if (fetched && fetched.data.title === 'Updated Title via Instance') {
                  console.log(`  [PASS] Verified instance update.`);
             } else {
                  console.error(`  [FAIL] Failed to verify instance update.`);
             }
             // Verify context was added
             const docsInUpdatedContext = await db.listDocuments(['context/updated']);
             if (docsInUpdatedContext.some(d => d.id === updatedId)) {
                  console.log(`  [PASS] Verified context ['context/updated'] was added.`);
             } else {
                  console.error(`  [FAIL] Failed to verify context addition.`);
             }
        } catch (error) {
             console.error(`  [FAIL] Error updating using instance: ${error.message}`, error);
        }

        // 5. Update using just ID and new context/features
        console.log(`\nTesting: Update context/features using only ID`);
        try {
            const updatedId = await db.updateDocument(note1Id, ['context/new'], ['feature/added']); // Using Case 4/5 signature
            console.log(`  [PASS] Updated context/features for ID: ${updatedId}`);
            const fetched = await db.getById(updatedId);
            // Verify context
            const docsInNewContext = await db.listDocuments(['context/new']);
            if (docsInNewContext.some(d => d.id === updatedId)) {
                  console.log(`  [PASS] Verified context ['context/new'] was added.`);
            } else {
                  console.error(`  [FAIL] Failed to verify context ['context/new'] addition.`);
            }
            // Verify feature
            const docsWithNewFeature = await db.listDocuments(null, ['feature/added']);
             if (docsWithNewFeature.some(d => d.id === updatedId)) {
                  console.log(`  [PASS] Verified feature ['feature/added'] was added.`);
            } else {
                  console.error(`  [FAIL] Failed to verify feature ['feature/added'] addition.`);
            }
        } catch (error) {
            console.error(`  [FAIL] Error updating context/features via ID: ${error.message}`, error);
        }


        console.log('\n--- Final Stats ---');
        console.log(db.stats);

        console.log('\n--- Listing Final Bitmaps (Sanity Check) ---');
        console.log(await db.bitmaps.listBitmaps());

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
