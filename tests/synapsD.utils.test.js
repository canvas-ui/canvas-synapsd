'use strict';

import SynapsD from '../src/index.js';
import {
    initializeTestDB,
    cleanupTestDB,
    assert,
    assertEqual,
    runTestSuite,
    TEST_DB_PATH,
} from './helpers.js';
import fs from 'fs';
import path from 'path';

const DUMP_DIR = path.join(TEST_DB_PATH, 'dump_output');

function cleanupDumpDir() {
    if (fs.existsSync(DUMP_DIR)) {
        fs.rmSync(DUMP_DIR, { recursive: true, force: true });
    }
}

const utilsTestSuite = {
    async beforeEach() {
        cleanupDumpDir();
        fs.mkdirSync(DUMP_DIR, { recursive: true });
    },

    async afterEach() {
        cleanupDumpDir();
    },

    async 'dumpDocuments() should dump all documents to specified directory'() {
        let db;
        try {
            db = await initializeTestDB();
            await this.beforeEach();

            const docId1 = await db.insertDocument({ schema: 'BaseDocument', data: { title: 'DumpDoc1', content: 'Content1' } });
            const docId2 = await db.insertDocument({ schema: 'Note', data: { text: 'NoteDump1', category: 'A' } }); // Assuming 'Note' schema exists

            await db.dumpDocuments(DUMP_DIR);

            const baseDocDir = path.join(DUMP_DIR, 'BaseDocument');
            const noteDocDir = path.join(DUMP_DIR, 'Note');

            assert(fs.existsSync(baseDocDir), 'BaseDocument schema directory should exist after dump');
            assert(fs.existsSync(noteDocDir), 'Note schema directory should exist after dump');

            const doc1File = path.join(baseDocDir, `${docId1}.json`);
            const doc2File = path.join(noteDocDir, `${docId2}.json`);

            assert(fs.existsSync(doc1File), `Dumped file ${doc1File} should exist`);
            assert(fs.existsSync(doc2File), `Dumped file ${doc2File} should exist`);

            const dumpedDoc1Content = JSON.parse(fs.readFileSync(doc1File, 'utf-8'));
            const dumpedDoc2Content = JSON.parse(fs.readFileSync(doc2File, 'utf-8'));

            assertEqual(dumpedDoc1Content.data.title, 'DumpDoc1', 'Dumped Doc1 title mismatch');
            assertEqual(dumpedDoc2Content.data.text, 'NoteDump1', 'Dumped Note1 text mismatch');

        } finally {
            await this.afterEach();
            await cleanupTestDB(db);
        }
    },

    async 'dumpDocuments() with context and feature filters'() {
        let db;
        try {
            db = await initializeTestDB();
            await this.beforeEach();

            const docId1 = await db.insertDocument({ schema: 'BaseDocument', data: { title: 'FilterDump1' } }, '/ctxFilter', ['featFilter']);
            /*const docId2 =*/ await db.insertDocument({ schema: 'BaseDocument', data: { title: 'FilterDump2NoMatch' } }, '/otherCtx', ['featFilter']);
            /*const docId3 =*/ await db.insertDocument({ schema: 'BaseDocument', data: { title: 'FilterDump3NoMatch' } }, '/ctxFilter', ['otherFeat']);

            await db.dumpDocuments(DUMP_DIR, '/ctxFilter', ['featFilter']);

            const baseDocDir = path.join(DUMP_DIR, 'BaseDocument');
            assert(fs.existsSync(baseDocDir), 'BaseDocument schema directory should exist for filtered dump');

            const doc1File = path.join(baseDocDir, `${docId1}.json`);
            assert(fs.existsSync(doc1File), 'Only docId1 matching filter should be dumped');

            // Check that other files are NOT there
            const filesInDir = fs.readdirSync(baseDocDir);
            assertEqual(filesInDir.length, 1, 'Only one file should be in BaseDocument dir for filtered dump');

        } finally {
            await this.afterEach();
            await cleanupTestDB(db);
        }
    },

    async 'dumpBitmaps() should run without error (placeholder)'() {
        let db;
        try {
            db = await initializeTestDB();
            await this.beforeEach();
            // As it's a placeholder, just ensure it doesn't throw an error.
            // If it were to be implemented, we'd check for file output.
            await db.dumpBitmaps(DUMP_DIR, ['someBitmapKey']); // Pass some dummy key
            // No explicit assertion needed if it completes without throwing.
            console.log('dumpBitmaps called without error (as expected for a placeholder).');
        } catch (error) {
            // This catch is to fail the test if it *does* throw unexpectedly.
            throw new Error(`dumpBitmaps placeholder threw an error: ${error.message}`);
        } finally {
            await this.afterEach();
            await cleanupTestDB(db);
        }
    },
};

// Modify runTestSuite to handle beforeEach/afterEach if defined on the suite object
async function runCustomTestSuite(suiteName, suite) {
    console.log(`\\n--- Running test suite: ${suiteName} ---\\n`);
    let passed = 0;
    let failed = 0;
    const testNames = Object.keys(suite).filter(key => typeof suite[key] === 'function' && key !== 'beforeEach' && key !== 'afterEach');

    for (const testName of testNames) {
        console.log(`\\n[TEST] ${suiteName} - ${testName}`);
        try {
            if (suite.beforeEach) {await suite.beforeEach();}
            await suite[testName]();
            if (suite.afterEach) {await suite.afterEach();}
            console.log(`[PASS] ${testName}`);
            passed++;
        } catch (error) {
            console.error(`[FAIL] ${testName}`);
            console.error(error);
            failed++;
            // Ensure afterEach runs even if test fails
            if (suite.afterEach) {
                try { await suite.afterEach(); } catch (e) { console.error('Error in afterEach after a test failure:', e); }
            }
        }
    }

    console.log(`\\n--- Suite ${suiteName} Summary ---`);
    console.log(`Total tests: ${testNames.length}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log('-----------------------------------\\n');
    return failed === 0;
}

runCustomTestSuite('SynapsD Utils', utilsTestSuite);
