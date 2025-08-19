'use strict';

import ChecksumIndex from '../src/indexes/inverted/Checksum.js';
import {
    MockDataset, // Using the mock dataset from helpers
    assert,
    assertEqual,
    assertAsyncThrows, // If get is async
    runTestSuite,
} from './helpers.js';

const checksumIndexTestSuite = {
    async 'constructor should initialize with a dataset'() {
        const dataset = new MockDataset();
        const checksumIndex = new ChecksumIndex(dataset);
        assert(checksumIndex.dataset === dataset, 'Dataset should be set on instance');
    },

    'constructor should throw if dataset is not provided'() {
        let didThrow = false;
        try {
            new ChecksumIndex(null);
        } catch (e) {
            didThrow = true;
            console.log(`Assertion passed: ChecksumIndex constructor threw as expected: ${e.message}`);
        }
        assert(didThrow, 'ChecksumIndex constructor should throw if dataset is missing');
    },

    // --- insert() and get() ---
    async 'insert() should store ID for a single checksum string'() {
        const dataset = new MockDataset();
        const checksumIndex = new ChecksumIndex(dataset);
        const checksum = 'cs123';
        const id = 1001;

        checksumIndex.insert(checksum, id);
        assertEqual(await checksumIndex.get(checksum), id, 'get() should retrieve the correct ID for checksum');
    },

    async 'insert() should handle checksum as an array (inserting ID for each)'() {
        const dataset = new MockDataset();
        const checksumIndex = new ChecksumIndex(dataset);
        const checksums = ['csA', 'csB'];
        const id = 1002;

        checksumIndex.insert(checksums, id);
        assertEqual(await checksumIndex.get('csA'), id, 'ID for csA mismatch');
        assertEqual(await checksumIndex.get('csB'), id, 'ID for csB mismatch');
    },

    async 'insertArray() should store ID for an array of checksum strings'() {
        const dataset = new MockDataset();
        const checksumIndex = new ChecksumIndex(dataset);
        const checksumArray = ['csArr1', 'csArr2', 'csArr3'];
        const id = 1003;

        checksumIndex.insertArray(checksumArray, id);
        assertEqual(await checksumIndex.get('csArr1'), id, 'ID for csArr1 mismatch after insertArray');
        assertEqual(await checksumIndex.get('csArr2'), id, 'ID for csArr2 mismatch after insertArray');
        assertEqual(await checksumIndex.get('csArr3'), id, 'ID for csArr3 mismatch after insertArray');
    },

    async 'get() should return undefined for non-existent checksum'() {
        const dataset = new MockDataset();
        const checksumIndex = new ChecksumIndex(dataset);
        assertEqual(await checksumIndex.get('nonExistentCs'), undefined, 'get() should return undefined for non-existent checksum');
    },

    // --- Alias methods for get ---
    async 'getId() should work as an alias for get()'() {
        const dataset = new MockDataset();
        const checksumIndex = new ChecksumIndex(dataset);
        const checksum = 'csGetId';
        const id = 1004;
        checksumIndex.insert(checksum, id);
        assertEqual(await checksumIndex.getId(checksum), id, 'getId() failed');
    },

    async 'checksumToId() should work as an alias for get()'() {
        const dataset = new MockDataset();
        const checksumIndex = new ChecksumIndex(dataset);
        const checksum = 'csToId';
        const id = 1005;
        checksumIndex.insert(checksum, id);
        assertEqual(await checksumIndex.checksumToId(checksum), id, 'checksumToId() failed');
    },

    async 'checksumStringToId() should work as an alias for get()'() {
        const dataset = new MockDataset();
        const checksumIndex = new ChecksumIndex(dataset);
        const checksum = 'csStringToId';
        const id = 1006;
        checksumIndex.insert(checksum, id);
        assertEqual(await checksumIndex.checksumStringToId(checksum), id, 'checksumStringToId() failed');
    },

    // --- delete() and deleteArray() ---
    async 'delete() should remove a checksum entry'() {
        const dataset = new MockDataset();
        const checksumIndex = new ChecksumIndex(dataset);
        const checksum = 'csDelete';
        const id = 1007;
        checksumIndex.insert(checksum, id);
        assert(await checksumIndex.get(checksum) === id, 'Checksum should exist before delete');

        checksumIndex.delete(checksum);
        assertEqual(await checksumIndex.get(checksum), undefined, 'Checksum should be undefined after delete');
    },

    async 'deleteArray() should remove multiple checksum entries'() {
        const dataset = new MockDataset();
        const checksumIndex = new ChecksumIndex(dataset);
        const checksums = ['csDelArr1', 'csDelArr2'];
        const id = 1008;
        checksumIndex.insertArray(checksums, id);
        assert(await checksumIndex.get('csDelArr1') === id, 'csDelArr1 should exist before deleteArray');

        checksumIndex.deleteArray(checksums);
        assertEqual(await checksumIndex.get('csDelArr1'), undefined, 'csDelArr1 should be undefined after deleteArray');
        assertEqual(await checksumIndex.get('csDelArr2'), undefined, 'csDelArr2 should be undefined after deleteArray');
    },

    // --- getCount() ---
    'getCount() should return the number of checksum entries'() {
        const dataset = new MockDataset();
        const checksumIndex = new ChecksumIndex(dataset);
        checksumIndex.insert('csCount1', 1);
        checksumIndex.insert('csCount2', 2);
        assertEqual(checksumIndex.getCount(), 2, 'getCount() mismatch');
        checksumIndex.delete('csCount1');
        assertEqual(checksumIndex.getCount(), 1, 'getCount() mismatch after delete');
    },
};

runTestSuite('ChecksumIndex Class', checksumIndexTestSuite);
