'use strict';

import BitmapIndex from '../src/indexes/bitmaps/index.js';
import BitmapCollection from '../src/indexes/bitmaps/lib/BitmapCollection.js';
import {
    initializeTestDB,
    cleanupTestDB,
    assert,
    assertEqual,
    assertThrows,
    runTestSuite
} from './helpers.js';

const collectionManagementTestSuite = {
    async 'constructor should initialize with a dataset (via SynapsD)'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;

            assert(typeof bitmapIndex.dataset === 'object' && bitmapIndex.dataset !== null, 'BitmapIndex.dataset should be an object');
            assertEqual(bitmapIndex.dataset.name, 'bitmaps', 'BitmapIndex.dataset should be the one named \'bitmaps\' from SynapsD');
            assert(bitmapIndex.cache instanceof Map, 'Cache should be a Map by default');
            assert(bitmapIndex.collections instanceof Map, 'Collections map should be initialized');
        } finally {
            await cleanupTestDB(db);
        }
    },

    'constructor should throw if dataset is not provided'() {
        assertThrows(() => {
            new BitmapIndex();
        }, 'BitmapIndex constructor should throw if dataset is missing');
    },

    async 'createCollection() should create and store a BitmapCollection'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const collectionName = 'userCollection';
            const collection = bitmapIndex.createCollection(collectionName, { option1: true });

            assert(collection instanceof BitmapCollection, 'Should return a BitmapCollection instance');
            assertEqual(collection.collectionName, collectionName, 'Collection name mismatch');
            assertEqual(bitmapIndex.collections.get(collectionName), collection, 'Collection should be stored in the collections map');
            assert(collection.bitmapIndex === bitmapIndex, 'Collection should have a reference to the BitmapIndex');
            assert(collection.options.option1 === true, 'Collection options mismatch');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getCollection() should retrieve an existing collection'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const collectionName = 'dataCollection';
            const createdCollection = bitmapIndex.createCollection(collectionName);
            const retrievedCollection = bitmapIndex.getCollection(collectionName);
            assertEqual(retrievedCollection, createdCollection, 'Retrieved collection should be the same as created');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getCollection() should return undefined for non-existent collection'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const retrievedCollection = bitmapIndex.getCollection('nonExistent');
            assertEqual(retrievedCollection, undefined, 'Should return undefined for non-existent collection');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'listCollections() should return an array of all collections'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const coll1 = bitmapIndex.createCollection('customCollection1');
            const coll2 = bitmapIndex.createCollection('customCollection2');

            const collectionsList = bitmapIndex.listCollections();
            assert(Array.isArray(collectionsList), 'listCollections should return an array');
            assertEqual(collectionsList.length, 3, 'Should list all created collections including defaults');
            assert(collectionsList.some(c => c === coll1), 'Collections list should include customCollection1');
            assert(collectionsList.some(c => c === coll2), 'Collections list should include customCollection2');
            assert(collectionsList.some(c => c.collectionName === 'context'), 'Collections list should include default context collection');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'listCollections() should return default collections if no others created'() {
        let db;
        try {
            db = await initializeTestDB();
            const bitmapIndex = db.bitmapIndex;
            const collectionsList = bitmapIndex.listCollections();
            assertEqual(collectionsList.length, 1, 'Should return 1 (default context) if no other collections created');
            assertEqual(collectionsList[0].collectionName, 'context', 'Default collection should be context');
        } finally {
            await cleanupTestDB(db);
        }
    }
};

runTestSuite('BitmapIndex Collection Management (Integrated)', collectionManagementTestSuite);
