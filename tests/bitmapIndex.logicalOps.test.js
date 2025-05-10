'use strict';

import roaring from 'roaring';
const { RoaringBitmap32 } = roaring;
import {
    initializeTestDB,
    cleanupTestDB,
    assert,
    assertEqual,
    assertAsyncThrows,
    runTestSuite
} from './helpers.js';

const KEY_P = 'data/'; // Valid Prefix

const bitmapLogicalOpsTestSuite = {
    async 'applyToMany() should apply source bitmap to target bitmaps'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const sourceKey = `${KEY_P}applySource`;
            const targetKey1 = `${KEY_P}applyTarget1`; // Empty
            const targetKey2 = `${KEY_P}applyTarget2`; // Overlapping
            const targetKey3 = `${KEY_P}applyTarget3`; // Distinct

            await bitmapIndex.createBitmap(sourceKey, [1, 2, 3]);
            await bitmapIndex.createBitmap(targetKey2, [2, 4]);
            await bitmapIndex.createBitmap(targetKey3, [5, 6]);
            // targetKey1 is auto-created by applyToMany if it doesn't exist, as per getBitmap(key, true)

            const affectedKeys = await bitmapIndex.applyToMany(sourceKey, [targetKey1, targetKey2, targetKey3]);

            assertEqual(affectedKeys.length, 3, 'applyToMany should affect 3 keys');
            assert(affectedKeys.includes(targetKey1) && affectedKeys.includes(targetKey2) && affectedKeys.includes(targetKey3), 'Affected keys list mismatch');

            const bmp1 = await bitmapIndex.getBitmap(targetKey1);
            const bmp2 = await bitmapIndex.getBitmap(targetKey2);
            const bmp3 = await bitmapIndex.getBitmap(targetKey3);

            assert(bmp1 && bmp1.has(1) && bmp1.has(2) && bmp1.has(3) && bmp1.size === 3, 'Target1 content/size error');
            assert(bmp2 && [1,2,3,4].every(o=>bmp2.has(o)) && bmp2.size === 4, 'Target2 content/size error after OR');
            assert(bmp3 && [1,2,3,5,6].every(o=>bmp3.has(o)) && bmp3.size === 5, 'Target3 content/size error after OR');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'applyToMany() with non-existent source should not change targets'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const targetKey = `${KEY_P}applyTargetNoSource`;
            await bitmapIndex.createBitmap(targetKey, [10]);

            const affectedKeys = await bitmapIndex.applyToMany(`${KEY_P}nonExistentSource`, [targetKey]);
            assertEqual(affectedKeys.length, 0, 'Should affect 0 keys if source is non-existent');
            const bmp = await bitmapIndex.getBitmap(targetKey);
            assertEqual(bmp.size, 1, 'Target should be unchanged if source non-existent');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'subtractFromMany() should subtract source from targets and delete if empty'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const sourceKey = `${KEY_P}subtractSource`;
            const targetKey1 = `${KEY_P}subtractTarget1`; // Will become empty
            const targetKey2 = `${KEY_P}subtractTarget2`; // Will have remaining
            const targetKey3 = `${KEY_P}subtractTargetNonExistent`; // Will be skipped

            await bitmapIndex.createBitmap(sourceKey, [1, 2, 3]);
            await bitmapIndex.createBitmap(targetKey1, [2, 3]);
            await bitmapIndex.createBitmap(targetKey2, [3, 4, 5]);

            const affectedKeys = await bitmapIndex.subtractFromMany(sourceKey, [targetKey1, targetKey2, targetKey3]);
            assertEqual(affectedKeys.length, 2, 'subtractFromMany affected keys count mismatch');
            assert(affectedKeys.includes(targetKey1) && affectedKeys.includes(targetKey2), 'Affected keys for subtractFromMany incorrect');

            assert(!bitmapIndex.hasBitmap(targetKey1), 'Target1 should be deleted as it became empty');
            const bmp2 = await bitmapIndex.getBitmap(targetKey2);
            assert(bmp2 && bmp2.size === 2 && bmp2.has(4) && bmp2.has(5) && !bmp2.has(3), 'Target2 content/size error');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'AND() operation between multiple bitmaps'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            await bitmapIndex.createBitmap(`${KEY_P}and1`, [1, 2, 3, 4]);
            await bitmapIndex.createBitmap(`${KEY_P}and2`, [3, 4, 5, 6]);
            await bitmapIndex.createBitmap(`${KEY_P}and3`, [1, 3, 5, 7]);

            const result = await bitmapIndex.AND([`${KEY_P}and1`, `${KEY_P}and2`, `${KEY_P}and3`]);
            assert(result.has(3) && result.size === 1, 'AND result should only contain 3');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'AND() with non-existent key should result in empty bitmap'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            await bitmapIndex.createBitmap(`${KEY_P}and_exists`, [1, 2]);
            const result = await bitmapIndex.AND([`${KEY_P}and_exists`, `${KEY_P}and_non_existent`]);
            assert(result.isEmpty, 'AND with a non-existent key should be empty');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'AND() with negation'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            await bitmapIndex.createBitmap(`${KEY_P}and_base`, [1,2,3,4,5]);
            await bitmapIndex.createBitmap(`${KEY_P}and_not_this`, [4,5,6]);

            const result = await bitmapIndex.AND([`${KEY_P}and_base`, `!${KEY_P}and_not_this`]);
            assert(result.size === 3, 'AND with negation size error');
            assert([1,2,3].every(o => result.has(o)), 'AND with negation content error');
            assert(!result.has(4) && !result.has(5), 'AND with negation should not have negated elements');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'OR() operation between multiple bitmaps'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            await bitmapIndex.createBitmap(`${KEY_P}or1`, [1, 2]);
            await bitmapIndex.createBitmap(`${KEY_P}or2`, [2, 3]);
            await bitmapIndex.createBitmap(`${KEY_P}or3`, [4, 5]);
            // Note: OR auto-creates bitmaps if they don't exist (getBitmap(key, true))
            // However, for a clean test, we create them.

            const result = await bitmapIndex.OR([`${KEY_P}or1`, `${KEY_P}or2`, `${KEY_P}or3`]);
            assert(result.size === 5, 'OR result size error');
            assert([1,2,3,4,5].every(o => result.has(o)), 'OR result content error');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'OR() with negation'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            await bitmapIndex.createBitmap(`${KEY_P}or_base`, [1,2]);
            await bitmapIndex.createBitmap(`${KEY_P}or_add`, [3,4]);
            await bitmapIndex.createBitmap(`${KEY_P}or_not_this`, [2,5]); // 2 is in base, 5 is not

            // (base OR add) AND_NOT (not_this) = ([1,2,3,4]) AND_NOT ([2,5]) = [1,3,4]
            const result = await bitmapIndex.OR([`${KEY_P}or_base`, `${KEY_P}or_add`, `!${KEY_P}or_not_this`]);
            assert(result.size === 3, 'OR with negation size error');
            assert([1,3,4].every(o => result.has(o)), 'OR with negation content error');
            assert(!result.has(2) && !result.has(5), 'OR with negation should exclude negated elements');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'XOR() operation between multiple bitmaps'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            await bitmapIndex.createBitmap(`${KEY_P}xor1`, [1, 2, 3]);
            await bitmapIndex.createBitmap(`${KEY_P}xor2`, [3, 4, 5]);
            // Result of xor1 ^ xor2 = [1, 2, 4, 5]
            await bitmapIndex.createBitmap(`${KEY_P}xor3`, [5, 6, 7]);
            // Result of (xor1 ^ xor2) ^ xor3 = [1, 2, 4, 5] ^ [5, 6, 7] = [1, 2, 4, 6, 7]

            const result = await bitmapIndex.XOR([`${KEY_P}xor1`, `${KEY_P}xor2`, `${KEY_P}xor3`]);
            assert(result.size === 5, 'XOR result size error');
            assert([1,2,4,6,7].every(o => result.has(o)), 'XOR result content error');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'XOR() with non-existent key (is skipped)'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            await bitmapIndex.createBitmap(`${KEY_P}xor_A`, [1,2,3]);
            // xor_A ^ non_existent_B = xor_A
            const result = await bitmapIndex.XOR([`${KEY_P}xor_A`, `${KEY_P}non_existent_B`]);
            assertEqual(result.size, 3, 'XOR with one non-existent key size error');
            assert([1,2,3].every(o => result.has(o)), 'XOR with one non-existent key content error');
        } finally {
            await cleanupTestDB(db);
        }
    }
};

runTestSuite('BitmapIndex Logical/Collection Ops (Integrated)', bitmapLogicalOpsTestSuite);
