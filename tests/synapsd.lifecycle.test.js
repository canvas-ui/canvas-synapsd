'use strict';

import SynapsD from '../src/index.js';
import {
    TEST_DB_PATH,
    initializeTestDB,
    cleanupTestDB,
    assert,
    assertEqual,
    runTestSuite
} from './helpers.js';
import TimestampIndex from '../src/indexes/inverted/Timestamp.js';
import fs from 'fs';

const lifecycleTestSuite = {
    async 'start() should initialize components and set status to running'() {
        let db;
        try {
            // Initialize SynapsD manually to test start() separately
            if (fs.existsSync(TEST_DB_PATH)) {
                fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
            }
            fs.mkdirSync(TEST_DB_PATH, { recursive: true });
            db = new SynapsD({ path: TEST_DB_PATH });

            assertEqual(db.status, 'initializing', 'Status should be initializing before start');

            let startedEventEmitted = false;
            db.on('started', () => { startedEventEmitted = true; });

            await db.start();

            assertEqual(db.status, 'running', 'Status should be running after start');
            assert(db.actionBitmaps.created, 'actionBitmaps.created should be initialized');
            assert(db.actionBitmaps.updated, 'actionBitmaps.updated should be initialized');
            assert(db.actionBitmaps.deleted, 'actionBitmaps.deleted should be initialized');
            assert(db._SynapsD__timestampIndex instanceof TimestampIndex, 'timestampIndex should be initialized');
            assert(db.tree._ContextTree__initialized, 'ContextTree should be initialized'); // Check private flag
            assert(startedEventEmitted, 'started event should be emitted');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'shutdown() should set status and emit events'() {
        let db;
        try {
            db = await initializeTestDB(); // Starts the DB
            assertEqual(db.status, 'running', 'DB should be running initially');

            let beforeShutdownEmitted = false;
            let shutdownEmitted = false;
            db.on('beforeShutdown', () => { beforeShutdownEmitted = true; });
            db.on('shutdown', () => { shutdownEmitted = true; });

            await db.shutdown();

            assertEqual(db.status, 'shutdown', 'Status should be shutdown');
            assert(beforeShutdownEmitted, 'beforeShutdown event should be emitted');
            assert(shutdownEmitted, 'shutdown event should be emitted');

        } finally {
            // cleanupTestDB will try to shutdown again if running, which is fine.
            // If we manually shut down, it won't do anything.
            await cleanupTestDB(db);
        }
    },

    async 'isRunning() should reflect current status'() {
        let db;
        try {
            // Manual setup to control start/stop
            if (fs.existsSync(TEST_DB_PATH)) {
                fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
            }
            fs.mkdirSync(TEST_DB_PATH, { recursive: true });
            db = new SynapsD({ path: TEST_DB_PATH });

            assertEqual(db.isRunning(), false, 'isRunning() should be false when status is initializing');

            await db.start();
            assertEqual(db.isRunning(), true, 'isRunning() should be true when status is running');

            await db.shutdown();
            assertEqual(db.isRunning(), false, 'isRunning() should be false when status is shutdown');

        } finally {
            await cleanupTestDB(db);
        }
    },

    async 'restart() should stop and start the database'() {
        let db;
        try {
            db = await initializeTestDB(); // Starts the DB
            assertEqual(db.status, 'running', 'DB should be running initially');

            // Spy on start/shutdown
            let shutdownCalled = false;
            let startCalled = false;
            const originalShutdown = db.shutdown.bind(db);
            const originalStart = db.start.bind(db);

            db.shutdown = async () => {
                shutdownCalled = true;
                // Call original to actually shut down for subsequent start
                await originalShutdown();
            };
            db.start = async () => {
                startCalled = true;
                await originalStart();
            };

            await db.restart();

            assert(shutdownCalled, 'shutdown should be called during restart');
            assert(startCalled, 'start should be called during restart');
            assertEqual(db.status, 'running', 'Status should be running after restart');

        } finally {
            await cleanupTestDB(db);
        }
    }
};

runTestSuite('SynapsD Lifecycle', lifecycleTestSuite);
