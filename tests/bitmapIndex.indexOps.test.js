'use strict';

import Bitmap from '../src/indexes/bitmaps/lib/Bitmap.js';
import {
    initializeTestDB,
    cleanupTestDB,
    assert,
    assertEqual,
    assertAsyncThrows,
    runTestSuite
} from './helpers.js';

const VALID_KEY_PREFIX = 'data/';
const ANOTHER_VALID_PREFIX = 'user/';

const bitmapIndexOpsTestSuite = {
    async 'tick() should add OID to a new bitmap (auto-create)'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}tickNew`;
            const oid = 100;

            const bitmap = await bitmapIndex.tick(key, oid);
            assert(bitmap instanceof Bitmap, 'tick should return a Bitmap instance');
            assertEqual(bitmap.size, 1, 'Bitmap size should be 1');
            assert(bitmap.has(oid), 'Bitmap should contain the ticked OID');
            assert(bitmapIndex.hasBitmap(key), 'Bitmap should exist in store after tick');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'tick() should add OIDs to an existing bitmap'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}tickExisting`;
            await bitmapIndex.createBitmap(key, [1]); // Pre-existing

            await bitmapIndex.tick(key, 2);
            const bitmap = await bitmapIndex.tick(key, [3, 4]);

            assertEqual(bitmap.size, 4, 'Bitmap size incorrect after multiple ticks');
            assert([1, 2, 3, 4].every(oid => bitmap.has(oid)), 'Bitmap missing OIDs after multiple ticks');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'tick() should filter invalid OIDs'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}tickInvalidOids`;
            // 'abc' is invalid, 0 and -5 are invalid as per current filtering in BitmapIndex.tick
            const bitmap = await bitmapIndex.tick(key, [1, 'abc', 2, 0, -5, 3]);
            assertEqual(bitmap.size, 3, 'Bitmap should only contain valid OIDs');
            assert([1, 2, 3].every(oid => bitmap.has(oid)), 'Bitmap has incorrect OIDs after filtering');
            assert(!bitmap.has('abc') && !bitmap.has(0) && !bitmap.has(-5), 'Bitmap should not contain invalid OIDs');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'untick() should remove OID from bitmap'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}untickSingle`;
            await bitmapIndex.tick(key, [10, 20, 30]);

            const bitmap = await bitmapIndex.untick(key, 20);
            assertEqual(bitmap.size, 2, 'Bitmap size incorrect after untick');
            assert(!bitmap.has(20), 'Bitmap should not contain unticked OID');
            assert(bitmap.has(10) && bitmap.has(30), 'Bitmap should still contain other OIDs');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'untick() should remove array of OIDs'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}untickArray`;
            await bitmapIndex.tick(key, [1, 2, 3, 4, 5]);

            const bitmap = await bitmapIndex.untick(key, [2, 4, 6]); // 6 is not present
            assertEqual(bitmap.size, 3, 'Bitmap size incorrect after unticking array');
            assert([1, 3, 5].every(oid => bitmap.has(oid)), 'Bitmap content mismatch after unticking array');
            assert(!bitmap.has(2) && !bitmap.has(4), 'Unticked OIDs should be removed');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'untick() should delete bitmap if it becomes empty'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}untickEmpty`;
            await bitmapIndex.tick(key, [7]);

            const bitmap = await bitmapIndex.untick(key, 7);
            assertEqual(bitmap, null, 'untick should return null if bitmap is deleted');
            assert(!bitmapIndex.hasBitmap(key), 'Bitmap should be deleted from store if empty after untick');
            assert(!bitmapIndex.cache.has(key), 'Bitmap should be removed from cache if deleted');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'untick() on non-existent bitmap should return null and not throw'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key = `${VALID_KEY_PREFIX}untickNonExistent`;
            const result = await bitmapIndex.untick(key, [1,2,3]);
            assertEqual(result, null, 'Unticking a non-existent bitmap key should return null');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'tickMany() should add OIDs to multiple bitmaps'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key1 = `${VALID_KEY_PREFIX}tickMany1`;
            const key2 = `${ANOTHER_VALID_PREFIX}tickMany2`;
            const oids = [50, 60];

            const affectedKeys = await bitmapIndex.tickMany([key1, key2], oids);
            assert(Array.isArray(affectedKeys), 'tickMany should return an array of keys');
            assertEqual(affectedKeys.length, 2, 'tickMany should report 2 affected keys');
            assert(affectedKeys.includes(key1) && affectedKeys.includes(key2), 'Affected keys list mismatch');

            const bmp1 = await bitmapIndex.getBitmap(key1);
            const bmp2 = await bitmapIndex.getBitmap(key2);
            assert(bmp1 && oids.every(oid => bmp1.has(oid)), 'Bitmap 1 missing OIDs from tickMany');
            assert(bmp2 && oids.every(oid => bmp2.has(oid)), 'Bitmap 2 missing OIDs from tickMany');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'untickMany() should remove OIDs from multiple bitmaps and delete if empty'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const key1 = `${VALID_KEY_PREFIX}untickMany1`; // Will become empty
            const key2 = `${ANOTHER_VALID_PREFIX}untickMany2`; // Will remain
            const key3 = `${VALID_KEY_PREFIX}untickManyNonExistent`; // Does not exist

            await bitmapIndex.tick(key1, [70, 80]);
            await bitmapIndex.tick(key2, [70, 80, 90]);

            const affectedKeys = await bitmapIndex.untickMany([key1, key2, key3], [70, 80]);
            assertEqual(affectedKeys.length, 2, 'untickMany affected keys count mismatch (key3 should be skipped)');
            assert(affectedKeys.includes(key1) && affectedKeys.includes(key2), 'Affected keys list incorrect for untickMany');

            assert(!bitmapIndex.hasBitmap(key1), 'Bitmap 1 should be deleted after untickMany makes it empty');
            const bmp2 = await bitmapIndex.getBitmap(key2);
            assert(bmp2 !== null, 'Bitmap 2 should still exist');
            assertEqual(bmp2.size, 1, 'Bitmap 2 size incorrect');
            assert(bmp2.has(90) && !bmp2.has(70) && !bmp2.has(80), 'Bitmap 2 content incorrect');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'untickAll() should remove OIDs from all relevant bitmaps'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const keyA = `${VALID_KEY_PREFIX}untickAll_A`;
            const keyB = `${ANOTHER_VALID_PREFIX}untickAll_B`;
            const keyC = `${VALID_KEY_PREFIX}untickAll_C_NoTargetOid`; // Won't have the target OID

            const targetOid = 101;
            const otherOid = 102;

            await bitmapIndex.tick(keyA, [targetOid, otherOid]);
            await bitmapIndex.tick(keyB, [targetOid]);
            await bitmapIndex.tick(keyC, [otherOid]);
            // Also consider internal bitmaps like 'internal/action/created' etc.
            // For this test, we focus on user-created ones.

            // Modify listBitmaps to only return our test keys for a focused test on untickAll
            // This is a bit hacky but helps to avoid unticking system bitmaps unintentionally in this test setup
            const originalListBitmaps = bitmapIndex.listBitmaps.bind(bitmapIndex);
            bitmapIndex.listBitmaps = async () => [keyA, keyB, keyC, 'internal/action/created'];
            // Add a well-known internal key to see if it's handled gracefully (it should skip if oid not present)
            await db.actionBitmaps.created.add(targetOid); // ensure one internal has it

            const affectedKeys = await bitmapIndex.untickAll([targetOid]);

            // Restore original method
            bitmapIndex.listBitmaps = originalListBitmaps;

            const bmpA = await bitmapIndex.getBitmap(keyA);
            const bmpB = await bitmapIndex.getBitmap(keyB); // Should be null as it became empty
            const bmpC = await bitmapIndex.getBitmap(keyC);

            assert(bmpA && !bmpA.has(targetOid) && bmpA.has(otherOid), 'KeyA did not correctly untick targetOid');
            assertEqual(bmpB, null, 'KeyB should have been deleted as it became empty');
            assert(bmpC && bmpC.has(otherOid), 'KeyC should be unaffected as it did not contain targetOid');

            const internalCreatedBmpAfterUntick = await bitmapIndex.getBitmap('internal/action/created');
            assertEqual(internalCreatedBmpAfterUntick, null, 'Internal bitmap should have been deleted as it became empty after untickAll');

            // Check affectedKeys. It should include keys that were modified/deleted.
            assert(affectedKeys.includes(keyA), 'affectedKeys should include keyA');
            assert(affectedKeys.includes(keyB), 'affectedKeys should include keyB (as it was deleted)');
            assert(!affectedKeys.includes(keyC), 'affectedKeys should NOT include keyC');
            assert(affectedKeys.includes('internal/action/created'), 'affectedKeys should include internal bitmap');

        } finally {
            await cleanupTestDB(db);
        }
    }
};

runTestSuite('BitmapIndex Index Operations (Integrated)', bitmapIndexOpsTestSuite);
