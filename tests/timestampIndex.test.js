'use strict';

import TimestampIndex from '../src/indexes/inverted/Timestamp.js';
import Bitmap from '../src/indexes/bitmaps/lib/Bitmap.js';
import roaring from 'roaring';
const { RoaringBitmap32 } = roaring;
import {
    initializeTestDB,
    cleanupTestDB,
    assert,
    assertEqual,
    assertAsyncThrows,
    runTestSuite,
    MockDataset
} from './helpers.js';

// Helper to create mock actionBitmaps for tests not using full SynapsD init
const createMockActionBitmaps = () => ({
    created: new Bitmap([], {key: 'mock/action/created'}),
    updated: new Bitmap([], {key: 'mock/action/updated'}),
    deleted: new Bitmap([], {key: 'mock/action/deleted'})
});

const timestampIndexTestSuite = {
    'constructor should initialize with dataset and actionBitmaps'() {
        const mockDataset = new MockDataset();
        const mockActionBitmaps = createMockActionBitmaps();
        const tsIndex = new TimestampIndex(mockDataset, mockActionBitmaps);
        assert(tsIndex.dataset === mockDataset, 'dataset mismatch');
        assert(tsIndex.actionBitmaps === mockActionBitmaps, 'actionBitmaps mismatch');
    },

    'constructor should throw if dataset or actionBitmaps are invalid'() {
        const mockDataset = new MockDataset();
        const mockActionBitmapsValid = createMockActionBitmaps();
        let didThrow = false;
        try { new TimestampIndex(null, mockActionBitmapsValid); } catch (e) { didThrow = true; }
        assert(didThrow, 'Should throw if dataset is null');
        didThrow = false;
        try { new TimestampIndex(mockDataset, null); } catch (e) { didThrow = true; }
        assert(didThrow, 'Should throw if actionBitmaps is null');
        didThrow = false;
        // Test with actionBitmaps missing a required action
        try { new TimestampIndex(mockDataset, { created: new Bitmap([], {key:'c'}), updated: new Bitmap([], {key:'u'}) /* deleted is missing */ }); } catch (e) { didThrow = true; }
        assert(didThrow, 'Should throw for actionBitmaps missing a key');
        didThrow = false;
        try { new TimestampIndex(mockDataset, { created: null, updated: mockActionBitmapsValid.updated, deleted: mockActionBitmapsValid.deleted }); } catch (e) { didThrow = true; }
        assert(didThrow, 'Should throw for invalid actionBitmaps structure (null entry)');
    },

    async 'insert() should store timestamp:id in dataset and tick actionBitmap'() {
        const mockDataset = new MockDataset();
        const actionBitmaps = createMockActionBitmaps();
        const timestampIndex = new TimestampIndex(mockDataset, actionBitmaps);

        const action = 'created';
        const timestampInput = '2023-10-26T10:20:30Z';
        const normalizedTimestamp = '2023-10-26';
        const id = 101;

        await timestampIndex.insert(action, timestampInput, id);

        assertEqual(await mockDataset.get(normalizedTimestamp), id, 'Timestamp:ID not stored in dataset');
        assert(actionBitmaps.created.has(id), `'created' action bitmap should contain ID ${id}`);
    },

    async 'insert() should handle various timestamp formats via normalization'() {
        const mockDataset = new MockDataset();
        const actionBitmaps = createMockActionBitmaps();
        const timestampIndex = new TimestampIndex(mockDataset, actionBitmaps);
        const id = 102;

        await timestampIndex.insert('updated', new Date(2023, 9, 27), id); // Month is 0-indexed
        assert(await mockDataset.get('2023-10-27') === id, 'Failed for Date object timestamp');

        await timestampIndex.insert('deleted', '2023-10-28', id + 1);
        assert(await mockDataset.get('2023-10-28') === (id + 1), 'Failed for YYYY-MM-DD string');
    },

    async 'insert() should throw for invalid action'() {
        const timestampIndex = new TimestampIndex(new MockDataset(), createMockActionBitmaps());
        await assertAsyncThrows(
            async () => timestampIndex.insert('viewed', '2023-10-26', 103),
            'insert() should throw for invalid action'
        );
    },

    async 'insert() should throw for invalid timestamp that normalizes to null'() {
        const timestampIndex = new TimestampIndex(new MockDataset(), createMockActionBitmaps());
        await assertAsyncThrows(
            async () => timestampIndex.insert('created', 'invalid-date-string', 104),
            'insert() should throw for invalid timestamp input'
        );
    },

    async 'get() should retrieve ID by normalized timestamp'() {
        const mockDataset = new MockDataset();
        const timestampIndex = new TimestampIndex(mockDataset, createMockActionBitmaps());
        await mockDataset.set('2023-11-01', 201); // Use set for MockDataset

        const id = await timestampIndex.get('2023-11-01T05:00:00Z');
        assertEqual(id, 201, 'get() failed to retrieve by normalized timestamp');
        assertEqual(await timestampIndex.get('non-existent'), undefined, 'get() should return undefined for non-key');
    },

    async 'findByRange() should retrieve IDs within date range'() {
        const mockDataset = new MockDataset();
        mockDataset.getRange = async function* (options) {
            const storeEntries = Array.from(this.store.entries());
            storeEntries.sort((a,b) => a[0].localeCompare(b[0]));
            for (const [key, value] of storeEntries) {
                if ((!options.start || key >= options.start) && (!options.end || key <= options.end)) {
                    yield { key, value };
                }
            }
        };
        const timestampIndex = new TimestampIndex(mockDataset, createMockActionBitmaps());
        await timestampIndex.insert('created', '2023-10-01', 301);
        await timestampIndex.insert('updated', '2023-10-02', 302);
        await timestampIndex.insert('created', '2023-10-03', 304);
        await timestampIndex.insert('updated', '2023-10-05', 305);

        const ids = await timestampIndex.findByRange('2023-10-01', '2023-10-03');
        assertEqual(ids.length, 3, 'findByRange length mismatch');
        assert(ids.includes(301) && ids.includes(302) && ids.includes(304), 'findByRange content error');
    },

    async 'delete() should remove timestamp entry'() {
        const mockDataset = new MockDataset();
        const timestampIndex = new TimestampIndex(mockDataset, createMockActionBitmaps());
        await timestampIndex.insert('created', '2023-12-01', 401);
        assert(await timestampIndex.get('2023-12-01') === 401, 'Should exist before delete');
        const result = await timestampIndex.delete('2023-12-01');
        assert(result, 'delete should return true on success');
        assertEqual(await timestampIndex.get('2023-12-01'), undefined, 'Should not exist after delete');
    }
};

runTestSuite('TimestampIndex Class (Corrected Design)', timestampIndexTestSuite);
