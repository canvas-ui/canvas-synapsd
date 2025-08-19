'use strict';

import SynapsD from '../src/index.js';
import {
    TEST_DB_PATH,
    initializeTestDB,
    cleanupTestDB,
    assert,
    assertEqual,
    assertThrows,
    runTestSuite,
} from './helpers.js';
import BitmapIndex from '../src/indexes/bitmaps/index.js';
import ChecksumIndex from '../src/indexes/inverted/Checksum.js';
import ContextTree from '../src/views/tree/index.js';

const constructorTestSuite = {
    async 'should initialize with default options and correct path'() {
        let db;
        try {
            db = await initializeTestDB();
            assert(db instanceof SynapsD, 'db should be an instance of SynapsD');
            assertEqual(db.rootPath, TEST_DB_PATH, 'db.rootPath should be the test path');
            assertEqual(db.status, 'running', 'db.status should be \'running\' after start');
        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'should throw an error if path is not provided'() {
        assertThrows(() => {
            new SynapsD({});
        }, 'SynapsD constructor should throw if path is missing');
    },

    async 'should initialize core components'() {
        let db;
        try {
            db = await initializeTestDB();
            assert(db.documents, 'db.documents should exist');
            assert(db.metadata, 'db.metadata should exist');
            assert(db.bitmapIndex instanceof BitmapIndex, 'db.bitmapIndex should be an instance of BitmapIndex');
            assert(db.contextBitmapCollection, 'db.contextBitmapCollection should exist');
            assert(db.contextBitmapCollection.collectionName === 'context', 'contextBitmapCollection name should be context');
            assert(db._SynapsD__checksumIndex instanceof ChecksumIndex, 'db.checksumIndex should be an instance of ChecksumIndex'); // Accessing private field for test
            assert(db.tree instanceof ContextTree, 'db.tree should be an instance of ContextTree');

            // Check if datasets are created (LMDB specific)
            assert(db.documents.name === 'documents', 'documents dataset name check');
            assert(db.metadata.name === 'metadata', 'metadata dataset name check');
            assert(db._SynapsD__internalStore.name === 'internal', 'internal dataset name check');
            assert(db._SynapsD__bitmapStore.name === 'bitmaps', 'bitmaps dataset name check');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'getters should return correct initial values'() {
        let db;
        try {
            // Initialize without starting to check initial status
            if (require('fs').existsSync(TEST_DB_PATH)) {
                require('fs').rmSync(TEST_DB_PATH, { recursive: true, force: true });
            }
            require('fs').mkdirSync(TEST_DB_PATH, { recursive: true });
            db = new SynapsD({ path: TEST_DB_PATH });

            assertEqual(db.rootPath, TEST_DB_PATH, 'rootPath getter');
            assertEqual(db.status, 'initializing', 'initial status getter');

            // Now start and check status again
            await db.start();
            assertEqual(db.status, 'running', 'status getter after start');

        } finally {
            await cleanupTestDB(db);
        }
    },
};

runTestSuite('SynapsD Constructor & Basic Getters', constructorTestSuite);
