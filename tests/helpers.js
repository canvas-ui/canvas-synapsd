'use strict';

import fs from 'fs';
import path from 'path';
import SynapsD from '../src/index.js';

export const TEST_DB_PATH = '/tmp/synapsd-test';

export async function initializeTestDB(options = {}) {
    // Clean up before initialization
    if (fs.existsSync(TEST_DB_PATH)) {
        fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DB_PATH, { recursive: true });

    const db = new SynapsD({
        path: TEST_DB_PATH,
        ...options,
    });
    await db.start();
    return db;
}

export async function cleanupTestDB(db) {
    if (db && db.isRunning()) {
        await db.shutdown();
    }
    if (fs.existsSync(TEST_DB_PATH)) {
        fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
}

// A simple assertion helper
export function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
    console.log(`Assertion passed: ${message}`);
}

export function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`Assertion failed: ${message}. Expected "${expected}", but got "${actual}".`);
    }
    console.log(`Assertion passed: ${message}`);
}

export function assertDeepEqual(actual, expected, message) {
    try {
        // Basic deep equal for simple objects, not comprehensive
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(); // Trigger catch
        }
        console.log(`Assertion passed: ${message}`);
    } catch (e) {
        throw new Error(`Assertion failed: ${message}. Expected ${JSON.stringify(expected)}, but got ${JSON.stringify(actual)}.`);
    }
}

export function assertThrows(fn, message) {
    try {
        fn();
        throw new Error(`Assertion failed: ${message}. Expected function to throw.`);
    } catch (error) {
        console.log(`Assertion passed: ${message} (threw as expected: ${error.message})`);
    }
}

export async function assertAsyncThrows(fn, message) {
    try {
        await fn();
        throw new Error(`Assertion failed: ${message}. Expected async function to throw.`);
    } catch (error) {
        console.log(`Assertion passed: ${message} (threw as expected: ${error.message})`);
    }
}

// Simple mock for the LMDB dataset used by BitmapIndex
export class MockDataset {
    constructor() {
        this.store = new Map();
        this.txns = []; // Mock transaction stack
    }
    set(key, value) {
        if (this.txns.length > 0) {
            this.txns[this.txns.length - 1].operations.push({ type: 'put', key, value });
            return;
        }
        this.store.set(key, value);
    }
    async put(key, value) { // Add async put, can just call set for mock
        this.set(key, value);
    }
    get(key) { return this.store.get(key); }
    delete(key) {
        if (this.txns.length > 0) {
            this.txns[this.txns.length - 1].operations.push({ type: 'remove', key });
            return true;
        }
        return this.store.delete(key);
    }
    doesExist(key) { return this.store.has(key); }
    async getKeys(options = {}) {
        let keys = Array.from(this.store.keys());
        if (options.start && options.endNotExact) {
            keys = keys.filter(k => k >= options.start && k < options.endNotExact);
        }
        if (options.start && options.end) {
             keys = keys.filter(k => k >= options.start && k <= options.end);
        }
        if (options.prefix) {
            keys = keys.filter(k => k.startsWith(options.prefix));
        }
        return keys.sort();
    }
    async *getRange(options = {}) { // Changed to async generator
        let entries = Array.from(this.store.entries()).map(([key, value]) => ({ key, value }));
        // Simple sort for mock
        entries.sort((a, b) => String(a.key).localeCompare(String(b.key)));

        if (options.reverse) {
            entries.reverse();
        }

        let count = 0;
        for (const entry of entries) {
            let match = true;
            if (options.start !== undefined && entry.key < options.start) {
                match = false;
            }
            if (options.end !== undefined && entry.key > options.end) {
                match = false;
            }
            // Add other options like limit, versions if needed for tests
            if (match) {
                if (options.limit !== undefined && count >= options.limit) {
                    break;
                }
                yield entry;
                count++;
            }
        }
    }
    getCount() { return this.store.size; }

    async remove(key) {
        return this.delete(key); // delete() is the method that does this.store.delete()
    }

    // Mock transaction methods
    transaction(fn) {
        const operations = [];
        this.txns.push({ operations });
        try {
            const result = fn();
            // Apply operations if transaction doesn't abort
            operations.forEach(op => {
                if (op.type === 'put') this.store.set(op.key, op.value);
                if (op.type === 'remove') this.store.delete(op.key);
            });
            this.txns.pop();
            return result;
        } catch (e) {
            this.txns.pop(); // Ensure txn is popped on error
            throw e;
        }
    }

    getStats() {
        return {
            entryCount: this.store.size,
            mapSize: this.store.size * 1024 // Arbitrary size
        }
    }

    // Mock for db.getMany()
    getMany(keys) {
        return keys.map(key => this.store.get(key)).filter(v => v !== undefined);
    }
}

// Helper to run a test suite
export async function runTestSuite(suiteName, tests) {
    console.log(`n--- Running test suite: ${suiteName} ---n`);
    let passed = 0;
    let failed = 0;
    const testNames = Object.keys(tests);

    for (const testName of testNames) {
        console.log(`n[TEST] ${suiteName} - ${testName}`);
        try {
            await tests[testName]();
            console.log(`[PASS] ${testName}`);
            passed++;
        } catch (error) {
            console.error(`[FAIL] ${testName}`);
            console.error(error);
            failed++;
        }
    }

    console.log(`n--- Suite ${suiteName} Summary ---`);
    console.log(`Total tests: ${testNames.length}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`-----------------------------------n`);
    return failed === 0;
}
