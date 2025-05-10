'use strict';

import roaring from 'roaring';
const { RoaringBitmap32 } = roaring;

import Bitmap from '../src/indexes/bitmaps/lib/Bitmap.js';
import {
    initializeTestDB, // Using full DB for integrated testing
    cleanupTestDB,
    assert,
    assertEqual,
    assertAsyncThrows,
    assertThrows,
    runTestSuite
} from './helpers.js';

const VALID_KEY_PREFIX = 'data/'; // Using a valid prefix for keys

const bitmapCrudTestSuite = {
    async 'createBitmap() should create and store a new bitmap'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}testCreate1`;
            const oids = [1, 2, 3];

            const bitmap = await bitmapIndex.createBitmap(key, oids);
            assert(bitmap instanceof Bitmap, 'Should return a Bitmap instance');
            assertEqual(bitmap.size, 3, 'Bitmap size mismatch');
            assert(oids.every(oid => bitmap.has(oid)), 'Bitmap missing some initial OIDs');
            assertEqual(bitmap.key, key, 'Bitmap key property mismatch');

            // Verify in dataset (indirectly via hasBitmap and getBitmap)
            assert(bitmapIndex.hasBitmap(key), 'hasBitmap should find the created bitmap');
            const retrievedBitmap = await bitmapIndex.getBitmap(key);
            assert(retrievedBitmap !== null, 'getBitmap should retrieve the created bitmap');
            assertEqual(retrievedBitmap.size, 3, 'Retrieved bitmap size mismatch');

            // Verify in cache
            assert(bitmapIndex.cache.has(key), 'Bitmap should be in cache after creation');
            assertEqual(bitmapIndex.cache.get(key), bitmap, 'Cached bitmap instance mismatch');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'createBitmap() from RoaringBitmap32 instance'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}testCreateFromRoaring`;
            const roaringInstance = new RoaringBitmap32([10, 20, 30]);

            const bitmap = await bitmapIndex.createBitmap(key, roaringInstance);
            assert(bitmap instanceof Bitmap, 'Should return a Bitmap instance');
            assertEqual(bitmap.size, 3, 'Bitmap size should match roaring instance');
            assert(roaringInstance.toArray().every(oid => bitmap.has(oid)), 'Bitmap content mismatch from roaring');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'createBitmap() when bitmap already exists should return existing'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}testCreateExists`;
            const firstBitmap = await bitmapIndex.createBitmap(key, [1, 2]);
            const secondBitmap = await bitmapIndex.createBitmap(key, [3, 4]); // Attempt to re-create

            assert(secondBitmap === firstBitmap, 'Should return the initially created instance');
            assertEqual(firstBitmap.size, 2, 'Original bitmap should not be modified');
            assert(!firstBitmap.has(3), 'Original bitmap should not contain data from second attempt');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'createBitmap() should throw for invalid key (no prefix)'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            await assertAsyncThrows(
                async () => bitmapIndex.createBitmap('invalidKeyNoPrefix', [1]),
                'createBitmap should throw for key without valid prefix'
            );
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'listBitmaps() should list all non-internal bitmaps when no prefix'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            await bitmapIndex.createBitmap(`${VALID_KEY_PREFIX}listKey1`, [1]); // data/listKey1
            await bitmapIndex.createBitmap(`user/listKey2`, [2]);         // user/listKey2

            const allKeys = await bitmapIndex.listBitmaps(); // No prefix
            assert(Array.isArray(allKeys), 'listBitmaps should return an array');

            assert(allKeys.includes(`${VALID_KEY_PREFIX}listKey1`), 'List should include data/listKey1');
            assert(allKeys.includes(`user/listKey2`), 'List should include user/listKey2');

            // Assert that internal keys created by SynapsD are NOT present
            assert(!allKeys.includes('internal/gc/deleted'), 'List should NOT include internal/gc/deleted');
            assert(!allKeys.includes('internal/action/created'), 'List should NOT include internal/action/created');

            assertEqual(allKeys.length, 2, 'List should contain exactly the 2 created non-internal bitmaps');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'listBitmaps() with prefix'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const prefix = 'custom/';
            await bitmapIndex.createBitmap(`${prefix}itemA`, [1]);
            await bitmapIndex.createBitmap(`${prefix}itemB`, [2]);
            await bitmapIndex.createBitmap(`${VALID_KEY_PREFIX}otherItem`, [3]); // Different prefix

            const prefixedKeys = await bitmapIndex.listBitmaps(prefix);
            assertEqual(prefixedKeys.length, 2, 'Should list 2 keys with the specified prefix');
            assert(prefixedKeys.includes(`${prefix}itemA`), 'Prefixed list missing itemA');
            assert(prefixedKeys.includes(`${prefix}itemB`), 'Prefixed list missing itemB');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getBitmap() should retrieve existing bitmap (from dataset if not in cache)'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}getTest1`;
            await bitmapIndex.createBitmap(key, [10, 20]);
            bitmapIndex.cache.delete(key); // Remove from cache to force load from dataset

            const bitmap = await bitmapIndex.getBitmap(key);
            assert(bitmap !== null, 'Bitmap should be retrieved');
            assert(bitmap instanceof Bitmap, 'Retrieved object should be a Bitmap instance');
            assertEqual(bitmap.size, 2, 'Retrieved bitmap size mismatch');
            assert(bitmap.has(10), 'Retrieved bitmap content mismatch');
            assert(bitmapIndex.cache.has(key), 'Bitmap should be in cache after retrieval from dataset');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getBitmap() should return null for non-existent key'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const bitmap = await bitmapIndex.getBitmap(`${VALID_KEY_PREFIX}nonExistentKey`);
            assertEqual(bitmap, null, 'Should return null for non-existent key');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getBitmap() with autoCreateBitmap=true should create if not found'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}getAutoCreate`;
            const bitmap = await bitmapIndex.getBitmap(key, true);
            assert(bitmap !== null, 'Bitmap should be auto-created');
            assert(bitmap instanceof Bitmap, 'Auto-created object should be a Bitmap instance');
            assertEqual(bitmap.size, 0, 'Auto-created bitmap should be empty');
            assert(bitmapIndex.hasBitmap(key), 'Bitmap should exist in store after auto-creation');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getBitmap() with invalid key (no prefix) and autoCreate=false should return null'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const bitmap = await bitmapIndex.getBitmap('badkey', false);
            assertEqual(bitmap, null, 'getBitmap with invalid key and autoCreate=false should return null');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getBitmap() with invalid key (no prefix) and autoCreate=true should throw'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            await assertAsyncThrows(
                async () => bitmapIndex.getBitmap('badkey_autocreate', true),
                'getBitmap with invalid key and autoCreate=true should throw'
            );
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'renameBitmap() should rename an existing bitmap'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const oldKey = `${VALID_KEY_PREFIX}renameOld`;
            const newKey = `${VALID_KEY_PREFIX}renameNew`;
            await bitmapIndex.createBitmap(oldKey, [1, 2, 3]);

            const renamedBitmap = await bitmapIndex.renameBitmap(oldKey, newKey);
            assert(renamedBitmap instanceof Bitmap, 'renameBitmap should return the bitmap');
            assertEqual(renamedBitmap.size, 3, 'Renamed bitmap size mismatch');

            assert(!bitmapIndex.hasBitmap(oldKey), 'Old key should not exist after rename');
            assert(!bitmapIndex.cache.has(oldKey), 'Old key should be removed from cache');
            assert(bitmapIndex.hasBitmap(newKey), 'New key should exist after rename');
            assert(bitmapIndex.cache.has(newKey), 'New key should be in cache');

            const retrievedNew = await bitmapIndex.getBitmap(newKey);
            assertEqual(retrievedNew.size, 3, 'Bitmap retrieved by new key has wrong size');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'renameBitmap() should throw for non-existent oldKey'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            await assertAsyncThrows(
                async () => bitmapIndex.renameBitmap(`${VALID_KEY_PREFIX}nonExistentOld`, `${VALID_KEY_PREFIX}anyNewKey`),
                'renameBitmap should throw if oldKey does not exist'
            );
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'deleteBitmap() should delete an existing bitmap'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}deleteTest`;
            await bitmapIndex.createBitmap(key, [5, 6]);

            const deleteResult = await bitmapIndex.deleteBitmap(key);
            assert(deleteResult, 'deleteBitmap should return true on success');
            assert(!bitmapIndex.hasBitmap(key), 'Bitmap should not exist after delete');
            assert(!bitmapIndex.cache.has(key), 'Bitmap should be removed from cache after delete');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'hasBitmap() should correctly report existence'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}hasTest`;
            await bitmapIndex.createBitmap(key, [1]);

            assert(bitmapIndex.hasBitmap(key), 'hasBitmap should be true for existing key');
            assert(!bitmapIndex.hasBitmap(`${VALID_KEY_PREFIX}nonExistentHas`), 'hasBitmap should be false for non-existent key');
        } finally {
            await cleanupTestDB(db);
        }
    }
};

runTestSuite('BitmapIndex CRUD Operations (Integrated)', bitmapCrudTestSuite);
