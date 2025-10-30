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
    MockDataset,
} from './helpers.js';

// Helper to create mock actionBitmaps for tests not using full SynapsD init
const createMockActionBitmaps = () => ({
    created: new Bitmap([], {key: 'mock/action/created'}),
    updated: new Bitmap([], {key: 'mock/action/updated'}),
    deleted: new Bitmap([], {key: 'mock/action/deleted'}),
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

    async 'insert() should add ID to timestamp bitmap and tick actionBitmap'() {
        const mockDataset = new MockDataset();
        const actionBitmaps = createMockActionBitmaps();
        const timestampIndex = new TimestampIndex(mockDataset, actionBitmaps);

        const action = 'created';
        const timestampInput = '2023-10-26T10:20:30Z';
        const normalizedTimestamp = '2023-10-26';
        const id = 101;

        await timestampIndex.insert(action, timestampInput, id);

        // Verify bitmap stored in dataset
        const storedBuffer = await mockDataset.get(normalizedTimestamp);
        assert(Buffer.isBuffer(storedBuffer), 'Should store a Buffer');

        const bitmap = RoaringBitmap32.deserialize(storedBuffer, 'portable');
        assert(bitmap.has(id), `Bitmap should contain ID ${id}`);
        assert(actionBitmaps.created.has(id), `'created' action bitmap should contain ID ${id}`);
    },

    async 'insert() should support multiple IDs per timestamp'() {
        const mockDataset = new MockDataset();
        const actionBitmaps = createMockActionBitmaps();
        const timestampIndex = new TimestampIndex(mockDataset, actionBitmaps);

        const timestamp = '2023-10-27';
        const ids = [201, 202, 203];

        // Insert multiple IDs with same timestamp
        for (const id of ids) {
            await timestampIndex.insert('updated', timestamp, id);
        }

        // Verify all IDs are in the bitmap
        const retrievedIds = await timestampIndex.get(timestamp);
        assertEqual(retrievedIds.length, 3, 'Should have 3 IDs');
        for (const id of ids) {
            assert(retrievedIds.includes(id), `Should contain ID ${id}`);
        }
    },

    async 'insert() should handle various timestamp formats via normalization'() {
        const mockDataset = new MockDataset();
        const actionBitmaps = createMockActionBitmaps();
        const timestampIndex = new TimestampIndex(mockDataset, actionBitmaps);

        await timestampIndex.insert('updated', new Date(2023, 9, 27), 301);
        let ids = await timestampIndex.get('2023-10-27');
        assert(ids.includes(301), 'Failed for Date object timestamp');

        await timestampIndex.insert('deleted', '2023-10-28', 302);
        ids = await timestampIndex.get('2023-10-28');
        assert(ids.includes(302), 'Failed for YYYY-MM-DD string');
    },

    async 'insert() should throw for invalid action'() {
        const timestampIndex = new TimestampIndex(new MockDataset(), createMockActionBitmaps());
        await assertAsyncThrows(
            async () => timestampIndex.insert('viewed', '2023-10-26', 103),
            'insert() should throw for invalid action',
        );
    },

    async 'insert() should throw for invalid timestamp that normalizes to null'() {
        const timestampIndex = new TimestampIndex(new MockDataset(), createMockActionBitmaps());
        await assertAsyncThrows(
            async () => timestampIndex.insert('created', 'invalid-date-string', 104),
            'insert() should throw for invalid timestamp input',
        );
    },

    async 'get() should retrieve IDs by normalized timestamp'() {
        const mockDataset = new MockDataset();
        const timestampIndex = new TimestampIndex(mockDataset, createMockActionBitmaps());

        // Insert some IDs
        await timestampIndex.insert('created', '2023-11-01', 401);
        await timestampIndex.insert('updated', '2023-11-01', 402);

        const ids = await timestampIndex.get('2023-11-01T05:00:00Z');
        assertEqual(ids.length, 2, 'Should retrieve 2 IDs');
        assert(ids.includes(401) && ids.includes(402), 'Should contain both IDs');

        const emptyIds = await timestampIndex.get('non-existent');
        assertEqual(emptyIds.length, 0, 'get() should return empty array for non-existent key');
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
        await timestampIndex.insert('created', '2023-10-02', 303); // Multiple IDs same day
        await timestampIndex.insert('created', '2023-10-03', 304);
        await timestampIndex.insert('updated', '2023-10-05', 305);

        const ids = await timestampIndex.findByRange('2023-10-01', '2023-10-03');
        assertEqual(ids.length, 4, 'findByRange length mismatch');
        assert(ids.includes(301) && ids.includes(302) && ids.includes(303) && ids.includes(304), 'findByRange content error');
    },

    async 'findByRangeAndAction() should filter by action'() {
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
        await timestampIndex.insert('created', '2023-10-01', 501);
        await timestampIndex.insert('updated', '2023-10-01', 502);
        await timestampIndex.insert('created', '2023-10-02', 503);

        const createdIds = await timestampIndex.findByRangeAndAction('created', '2023-10-01', '2023-10-02');
        assertEqual(createdIds.length, 2, 'Should have 2 created IDs');
        assert(createdIds.includes(501) && createdIds.includes(503), 'Should only include created IDs');

        const updatedIds = await timestampIndex.findByRangeAndAction('updated', '2023-10-01', '2023-10-02');
        assertEqual(updatedIds.length, 1, 'Should have 1 updated ID');
        assert(updatedIds.includes(502), 'Should only include updated ID');
    },

    async 'remove() should remove ID from timestamp bitmap'() {
        const mockDataset = new MockDataset();
        const timestampIndex = new TimestampIndex(mockDataset, createMockActionBitmaps());

        await timestampIndex.insert('created', '2023-12-01', 601);
        await timestampIndex.insert('created', '2023-12-01', 602);

        let ids = await timestampIndex.get('2023-12-01');
        assertEqual(ids.length, 2, 'Should have 2 IDs before remove');

        await timestampIndex.remove('2023-12-01', 601);
        ids = await timestampIndex.get('2023-12-01');
        assertEqual(ids.length, 1, 'Should have 1 ID after remove');
        assert(ids.includes(602), 'Should still have ID 602');
        assert(!ids.includes(601), 'Should not have ID 601');
    },

    async 'remove() should delete timestamp entry when bitmap becomes empty'() {
        const mockDataset = new MockDataset();
        const timestampIndex = new TimestampIndex(mockDataset, createMockActionBitmaps());

        await timestampIndex.insert('created', '2023-12-05', 701);
        assert(await timestampIndex.has('2023-12-05'), 'Should exist before remove');

        await timestampIndex.remove('2023-12-05', 701);
        assert(!(await timestampIndex.has('2023-12-05')), 'Should not exist after removing last ID');
    },

    async 'delete() should remove entire timestamp entry'() {
        const mockDataset = new MockDataset();
        const timestampIndex = new TimestampIndex(mockDataset, createMockActionBitmaps());

        await timestampIndex.insert('created', '2023-12-01', 801);
        await timestampIndex.insert('created', '2023-12-01', 802);

        let ids = await timestampIndex.get('2023-12-01');
        assertEqual(ids.length, 2, 'Should have 2 IDs before delete');

        const result = await timestampIndex.delete('2023-12-01');
        assert(result, 'delete should return true on success');

        ids = await timestampIndex.get('2023-12-01');
        assertEqual(ids.length, 0, 'Should have no IDs after delete');
    },

    async 'findByTimeframe() should support common timeframes'() {
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

        // Insert document with today's date
        const today = new Date();
        await timestampIndex.insert('updated', today, 901);

        const todayIds = await timestampIndex.findByTimeframe('today');
        assert(todayIds.includes(901), 'Should find today\'s documents');

        // Test with action filter
        const updatedTodayIds = await timestampIndex.findByTimeframe('today', 'updated');
        assert(updatedTodayIds.includes(901), 'Should find updated documents from today');
    },
};

runTestSuite('TimestampIndex Class (Corrected Design)', timestampIndexTestSuite);
