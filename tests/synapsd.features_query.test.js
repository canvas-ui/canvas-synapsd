'use strict';

import SynapsD from '../src/index.js';
import {
    initializeTestDB,
    cleanupTestDB,
    assert,
    assertEqual,
    assertAsyncThrows,
    runTestSuite
} from './helpers.js';

const featuresQueryTestSuite = {
    // --- Feature Management ---
    async 'setDocumentArrayFeatures() should add features to documents'() {
        let db;
        try {
            db = await initializeTestDB();
            const docId1 = await db.insertDocument({ schema: 'BaseDocument', data: { name: 'FeatureDoc1' } });
            const docId2 = await db.insertDocument({ schema: 'BaseDocument', data: { name: 'FeatureDoc2' } });

            await db.setDocumentArrayFeatures([docId1, docId2], ['newFeature1', 'commonFeature']);

            const feat1Bitmap = await db.bitmapIndex.getBitmap('newFeature1');
            const commonBitmap = await db.bitmapIndex.getBitmap('commonFeature');

            assert(feat1Bitmap && feat1Bitmap.has(docId1), 'Doc1 should have newFeature1');
            assert(feat1Bitmap && feat1Bitmap.has(docId2), 'Doc2 should have newFeature1');
            assert(commonBitmap && commonBitmap.has(docId1), 'Doc1 should have commonFeature');
            assert(commonBitmap && commonBitmap.has(docId2), 'Doc2 should have commonFeature');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'unsetDocumentArrayFeatures() should remove features from documents'() {
        let db;
        try {
            db = await initializeTestDB();
            const docId1 = await db.insertDocument({ schema: 'BaseDocument', data: { name: 'UnsetFeatureDoc1' } }, '/', ['featureToUnset', 'featureToKeep']);
            const docId2 = await db.insertDocument({ schema: 'BaseDocument', data: { name: 'UnsetFeatureDoc2' } }, '/', ['featureToUnset']);

            await db.unsetDocumentArrayFeatures([docId1, docId2], ['featureToUnset']);

            const unsetFeatBitmap = await db.bitmapIndex.getBitmap('featureToUnset');
            const keepFeatBitmap = await db.bitmapIndex.getBitmap('featureToKeep');

            assert(unsetFeatBitmap === null || !unsetFeatBitmap.has(docId1), 'Doc1 should not have featureToUnset');
            assert(unsetFeatBitmap === null || !unsetFeatBitmap.has(docId2), 'Doc2 should not have featureToUnset');
            assert(keepFeatBitmap && keepFeatBitmap.has(docId1), 'Doc1 should still have featureToKeep');

        } finally {
            await cleanupTestDB(db);
        }
    },

    // --- Query Methods (Not Implemented) ---
    async 'query() should throw not implemented error'() {
        let db;
        try {
            db = await initializeTestDB();
            await assertAsyncThrows(
                async () => db.query('some query string'),
                'query() method should throw not implemented error'
            );
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'ftsQuery() should throw not implemented error'() {
        let db;
        try {
            db = await initializeTestDB();
            await assertAsyncThrows(
                async () => db.ftsQuery('some fts query'),
                'ftsQuery() method should throw not implemented error'
            );
        } finally {
            await cleanupTestDB(db);
        }
    }
};

runTestSuite('SynapsD Feature Management & Query Placeholders', featuresQueryTestSuite);
