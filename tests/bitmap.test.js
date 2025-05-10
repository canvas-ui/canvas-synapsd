'use strict';

import roaring from 'roaring';
const { RoaringBitmap32 } = roaring;
import Bitmap from '../src/indexes/bitmaps/lib/Bitmap.js';
import {
    assert,
    assertEqual,
    assertThrows,
    runTestSuite
} from './helpers.js';

const DEFAULT_KEY = 'test/bitmap';

const bitmapTestSuite = {
    // --- Constructor Tests ---
    'constructor should initialize with OID array and valid key'() {
        const b = new Bitmap([1, 2, 3], { key: DEFAULT_KEY });
        assert(b instanceof Bitmap, 'Should be instance of Bitmap');
        assert(b instanceof RoaringBitmap32, 'Should be instance of RoaringBitmap32');
        assertEqual(b.size, 3, 'Size mismatch with array init');
        assert(b.has(1) && b.has(2) && b.has(3), 'Content mismatch with array init');
        assertEqual(b.key, DEFAULT_KEY, 'Key property not set');
    },

    'constructor should initialize with another RoaringBitmap32 and valid key'() {
        const r = new RoaringBitmap32([10, 20]);
        const b = new Bitmap(r, { key: DEFAULT_KEY });
        assertEqual(b.size, 2, 'Size mismatch with RoaringBitmap32 init');
        assert(b.has(10) && b.has(20), 'Content mismatch with RoaringBitmap32 init');
    },

    'constructor should throw if key is missing or invalid'() {
        assertThrows(() => new Bitmap([1]), 'Should throw if options.key is missing');
        assertThrows(() => new Bitmap([1], {}), 'Should throw if options.key is missing (empty options)');
        assertThrows(() => new Bitmap([1], { key: null }), 'Should throw if key is null');
        assertThrows(() => new Bitmap([1], { key: '   ' }), 'Should throw if key is empty string or whitespace');
        assertThrows(() => new Bitmap([1], { key: 123 }), 'Should throw if key is not a string');
    },

    'constructor should set default rangeMin and rangeMax'() {
        const b = new Bitmap([], { key: DEFAULT_KEY });
        assertEqual(b.rangeMin, 0, 'Default rangeMin incorrect');
        assertEqual(b.rangeMax, 4294967296, 'Default rangeMax incorrect');
    },

    'constructor should set custom rangeMin and rangeMax'() {
        const b = new Bitmap([], { key: DEFAULT_KEY, rangeMin: 100, rangeMax: 200 });
        assertEqual(b.rangeMin, 100, 'Custom rangeMin not set');
        assertEqual(b.rangeMax, 200, 'Custom rangeMax not set');
    },

    // --- addMany / removeMany Tests ---
    'addMany() should add OIDs from an array'() {
        const b = new Bitmap([], { key: DEFAULT_KEY });
        b.addMany([1, 2, 3]);
        assertEqual(b.size, 3, 'addMany from array size error');
        assert(b.has(1) && b.has(3), 'addMany from array content error');
    },

    'addMany() should add OIDs from another RoaringBitmap32'() {
        const b = new Bitmap([1], { key: DEFAULT_KEY });
        const r = new RoaringBitmap32([2, 3]);
        b.addMany(r);
        assertEqual(b.size, 3, 'addMany from RoaringBitmap32 size error');
        assert(b.has(1) && b.has(2) && b.has(3), 'addMany from RoaringBitmap32 content error');
    },

    'addMany() should throw for invalid input type'() {
        const b = new Bitmap([], { key: DEFAULT_KEY });
        assertThrows(() => b.addMany(123), 'addMany should throw for number input');
        assertThrows(() => b.addMany('abc'), 'addMany should throw for string input');
    },

    'removeMany() should remove OIDs from an array'() {
        const b = new Bitmap([1,2,3,4], { key: DEFAULT_KEY });
        b.removeMany([2,4,5]); // 5 is not present
        assertEqual(b.size, 2, 'removeMany from array size error');
        assert(b.has(1) && b.has(3), 'removeMany from array content error');
        assert(!b.has(2) && !b.has(4), 'removeMany should remove specified OIDs');
    },

    'removeMany() should remove OIDs from another RoaringBitmap32'() {
        const b = new Bitmap([1,2,3,4], { key: DEFAULT_KEY });
        const r = new RoaringBitmap32([1,3]);
        b.removeMany(r);
        assertEqual(b.size, 2, 'removeMany from RoaringBitmap32 size error');
        assert(b.has(2) && b.has(4), 'removeMany from RoaringBitmap32 content error');
    },

    // --- Tick/Untick (and internal validation) Tests ---
    'tick() should add valid OID within range'() {
        const b = new Bitmap([], { key: DEFAULT_KEY, rangeMin: 10, rangeMax: 20 });
        b.tick(15);
        assert(b.has(15), 'tick failed to add valid OID');
    },

    'tick() should throw for OID out of range'() {
        const b = new Bitmap([], { key: DEFAULT_KEY, rangeMin: 10, rangeMax: 20 });
        assertThrows(() => b.tick(5), 'tick should throw for OID below rangeMin');
        assertThrows(() => b.tick(25), 'tick should throw for OID above rangeMax');
    },

    'tickArray() should add valid OIDs and throw for out-of-range array'() {
        const b = new Bitmap([], { key: DEFAULT_KEY, rangeMin: 100, rangeMax: 200 });
        b.tickArray([110, 120]);
        assert(b.has(110) && b.has(120), 'tickArray failed for valid array');
        assertThrows(() => b.tickArray([150, 250]), 'tickArray should throw if any OID is out of range');
    },

    'tickBitmap() should add valid bitmap OIDs and throw for out-of-range bitmap'() {
        const b = new Bitmap([], { key: DEFAULT_KEY, rangeMin: 1, rangeMax: 50 });
        const validSource = new RoaringBitmap32([10,20]);
        b.tickBitmap(validSource);
        assert(b.has(10) && b.has(20), 'tickBitmap failed for valid source bitmap');

        const invalidSource = new RoaringBitmap32([40, 60]); // 60 is out of range
        assertThrows(() => b.tickBitmap(invalidSource), 'tickBitmap should throw for out-of-range source bitmap');
    },

    'untick() should remove OID, throw if out of range for validation'() {
        const b = new Bitmap([10, 15, 20], { key: DEFAULT_KEY, rangeMin: 10, rangeMax: 20 });
        b.untick(15);
        assert(!b.has(15), 'untick failed to remove OID');
        assertThrows(() => b.untick(5), 'untick should throw for OID below rangeMin for validation');
    },

    // --- Static Methods ---
    'static create() should create a Bitmap instance'() {
        const b = Bitmap.create([1,2], { key: DEFAULT_KEY, rangeMin:0, rangeMax: 10 });
        assert(b instanceof Bitmap, 'Bitmap.create should return Bitmap instance');
        assertEqual(b.key, DEFAULT_KEY, 'Bitmap.create key mismatch');
        assertEqual(b.size, 2, 'Bitmap.create size mismatch');
        assertThrows(() => Bitmap.create([15], { key: DEFAULT_KEY, rangeMin:0, rangeMax:10}), 'Bitmap.create should validate range');
    },

    'static deserialize() should restore a Bitmap instance'() {
        const original = new Bitmap([5, 10, 15], { key: DEFAULT_KEY, rangeMin: 1, rangeMax: 20 });
        const buffer = original.serialize(true); // portable serialization
        const deserialized = Bitmap.deserialize(buffer, true, { key: DEFAULT_KEY, rangeMin: 1, rangeMax: 20 });

        assert(deserialized instanceof Bitmap, 'Deserialized object not Bitmap instance');
        assertEqual(deserialized.key, original.key, 'Deserialized key mismatch');
        assertEqual(deserialized.size, original.size, 'Deserialized size mismatch');
        assert(deserialized.has(10), 'Deserialized content mismatch');
        assertEqual(deserialized.rangeMin, original.rangeMin, 'Deserialized rangeMin mismatch');
        assertEqual(deserialized.rangeMax, original.rangeMax, 'Deserialized rangeMax mismatch');
    },

    'static validateRange() should validate inputs against range'() {
        Bitmap.validateRange(5, 0, 10); // Should not throw
        assertThrows(() => Bitmap.validateRange(15, 0, 10), 'validateRange should throw for number > max');
        Bitmap.validateRange([1,5,9], 0, 10);
        assertThrows(() => Bitmap.validateRange([1,12], 0, 10), 'validateRange should throw for array element > max');
        const rBmp = new RoaringBitmap32([1,9]);
        Bitmap.validateRange(rBmp, 0, 10);
        const rBmpInvalid = new RoaringBitmap32([1,12]);
        assertThrows(() => Bitmap.validateRange(rBmpInvalid, 0, 10), 'validateRange for RoaringBitmap32 out of range');
        assertThrows(() => Bitmap.validateRange(5, 10, 0), 'validateRange should throw for invalid range min > max');
    },
};

runTestSuite('Bitmap Class', bitmapTestSuite);
