'use strict';

import BitmapCollection from '../src/indexes/bitmaps/lib/BitmapCollection.js';
import BitmapIndex from '../src/indexes/bitmaps/index.js';
import Bitmap from '../src/indexes/bitmaps/lib/Bitmap.js';
import { /* RoaringBitmap32 needed for some spy checks if not using actual calls */ } from 'roaring';
import {
    initializeTestDB,
    cleanupTestDB,
    assert,
    assertEqual,
    assertThrows,
    assertAsyncThrows,
    runTestSuite
} from './helpers.js';

const COLLECTION_NAME = 'testUserCollection';
// const VALID_BITMAP_INDEX_KEY_PREFIX = 'user/'; // Not directly used in this suite name, more for context

const bitmapCollectionTestSuite = {
    // --- Constructor and Getters ---
    async 'constructor should initialize correctly'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const collection = new BitmapCollection(COLLECTION_NAME, bitmapIndex, { opt1: true });

            assertEqual(collection.collectionName, COLLECTION_NAME, 'collectionName getter mismatch');
            assertEqual(collection.bitmapIndex, bitmapIndex, 'bitmapIndex property mismatch');
            assert(collection.options.opt1 === true, 'options property mismatch');
            assertEqual(collection.prefix, `${COLLECTION_NAME}/`, 'prefix getter mismatch');
        } finally {
            await cleanupTestDB(db);
        }
    },

    'constructor should throw if name or bitmapIndex is missing'() {
        assertThrows(() => new BitmapCollection(null, {}), 'Should throw if name is missing');
        // For the next line, we need a mock bitmapIndex or a real one if not for the null check itself.
        // Since initializeTestDB is async, we can't easily get a real one here for a sync throw test.
        // A simple mock object for bitmapIndex is sufficient for this constructor check.
        const mockBitmapIndex = {};
        assertThrows(() => new BitmapCollection(COLLECTION_NAME, null), 'Should throw if bitmapIndex is missing');
    },

    // --- makeKey() ---
    'makeKey() should normalize and prefix the key'() {
        const collection = new BitmapCollection(COLLECTION_NAME, {}); // Mock bitmapIndex for this sync test
        assertEqual(collection.makeKey('rawKey'), `${COLLECTION_NAME}/rawKey`, 'Simple key');
        assertEqual(collection.makeKey('!negatedKey'), `${COLLECTION_NAME}/negatedKey`, 'Negated key');
        assertEqual(collection.makeKey('key with spaces'), `${COLLECTION_NAME}/keywithspaces`, 'Key with spaces');
        assertEqual(collection.makeKey('key@#$'), `${COLLECTION_NAME}/key`, 'Key with special chars');
        assertEqual(collection.makeKey('key.with-dots_and_dashes'), `${COLLECTION_NAME}/key.with-dots_and_dashes`, 'Key with allowed chars');
        assertEqual(collection.makeKey('key/'), `${COLLECTION_NAME}/key`, 'Key with trailing slash');
        assertEqual(collection.makeKey(''), `${COLLECTION_NAME}/`, 'Empty key segment - results in prefix only');
    },

    // --- Delegated Methods (Spot Checks - assuming BitmapIndex is well-tested) ---
    async 'createBitmap() should call bitmapIndex.createBitmap with prefixed key'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const collection = bitmapIndex.createCollection('data'); // Use a valid prefix

            let calledWithKey = null;
            const originalCreateBitmap = bitmapIndex.createBitmap.bind(bitmapIndex);
            bitmapIndex.createBitmap = async (key, data, opts) => {
                calledWithKey = key;
                return originalCreateBitmap(key, data, opts);
            };

            await collection.createBitmap('item1', [1,2]);
            assertEqual(calledWithKey, 'data/item1', 'createBitmap not called with correctly prefixed key');
            bitmapIndex.createBitmap = originalCreateBitmap; // Restore
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getBitmap() should call bitmapIndex.getBitmap with prefixed key'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const collection = bitmapIndex.createCollection('user'); // Use a valid prefix
            await bitmapIndex.createBitmap('user/user123', [100]);

            let calledWithKey = null;
            const originalGetBitmap = bitmapIndex.getBitmap.bind(bitmapIndex);
            bitmapIndex.getBitmap = async (key, autoCreate) => {
                calledWithKey = key;
                return originalGetBitmap(key, autoCreate);
            };

            await collection.getBitmap('user123');
            assertEqual(calledWithKey, 'user/user123', 'getBitmap not called with prefixed key');
            bitmapIndex.getBitmap = originalGetBitmap; // Restore
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'tick() should call bitmapIndex.tick with prefixed key'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const collection = bitmapIndex.createCollection('tag'); // Use a valid prefix

            let calledWithKey = null;
            const originalTick = bitmapIndex.tick.bind(bitmapIndex);
            bitmapIndex.tick = async (key, ids) => {
                calledWithKey = key;
                return originalTick(key, ids);
            };

            await collection.tick('popular', 1);
            assertEqual(calledWithKey, 'tag/popular', 'tick not called with prefixed key');
            bitmapIndex.tick = originalTick; // Restore
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'AND() should call bitmapIndex.AND with prefixed keys'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const collection = bitmapIndex.createCollection('custom'); // Use a valid prefix
            await bitmapIndex.createBitmap('custom/filterA', [1,2,3]);
            await bitmapIndex.createBitmap('custom/filterB', [2,3,4]);

            let calledWithKeys = null;
            const originalAND = bitmapIndex.AND.bind(bitmapIndex);
            bitmapIndex.AND = async (keysArray) => {
                calledWithKeys = keysArray;
                return originalAND(keysArray);
            };

            await collection.AND(['filterA', 'filterB']);
            assert(Array.isArray(calledWithKeys), 'AND not called with an array');
            assertEqual(calledWithKeys.length, 2, 'AND called with wrong number of keys');
            assert(calledWithKeys.includes('custom/filterA'), 'AND keys missing custom/filterA');
            assert(calledWithKeys.includes('custom/filterB'), 'AND keys missing custom/filterB');
            bitmapIndex.AND = originalAND; // Restore
        } finally {
            await cleanupTestDB(db);
        }
    }
    // Other delegated methods (list, rename, delete, untick, OR, XOR, etc.)
    // would follow a similar testing pattern: spy on the bitmapIndex method
    // and verify it's called with correctly prefixed keys.
    // For brevity, not all are explicitly written out but the pattern is established.
};

runTestSuite('BitmapCollection Class', bitmapCollectionTestSuite);
