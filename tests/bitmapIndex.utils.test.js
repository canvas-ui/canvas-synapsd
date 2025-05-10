'use strict';

import BitmapIndex from '../src/indexes/bitmaps/index.js';
import {
    assert,
    assertEqual,
    assertThrows,
    runTestSuite
} from './helpers.js';

const utilsTestSuite = {
    // --- validateKey() ---
    'validateKey() should return true for valid keys with allowed prefixes'() {
        const validPrefixes = ['internal/', 'context/', 'client/', 'server/', 'user/', 'tag/', 'data/', 'nested/', 'custom/'];
        validPrefixes.forEach(prefix => {
            assert(BitmapIndex.validateKey(`${prefix}testKey`), `Should be true for key with prefix: ${prefix}`);
        });
    },

    'validateKey() should return true for valid keys starting with ! and allowed prefix'() {
        assert(BitmapIndex.validateKey('!data/negatedKey'), 'Should be true for negated key with valid prefix');
    },

    'validateKey() should throw for key without any allowed prefix'() {
        assertThrows(() => {
            BitmapIndex.validateKey('myKeyWithoutPrefix');
        }, 'Should throw for key without any allowed prefix');
    },

    'validateKey() should throw for key with only ! and no valid prefix'() {
        assertThrows(() => {
            BitmapIndex.validateKey('!myKeyWithoutPrefix');
        }, 'Should throw for negated key without any allowed prefix');
    },

    'validateKey() should throw for null or undefined key'() {
        assertThrows(() => {
            BitmapIndex.validateKey(null);
        }, 'Should throw for null key');
        assertThrows(() => {
            BitmapIndex.validateKey(undefined);
        }, 'Should throw for undefined key');
    },

    'validateKey() should throw for non-string key'() {
        assertThrows(() => {
            BitmapIndex.validateKey(123);
        }, 'Should throw for numeric key');
        assertThrows(() => {
            BitmapIndex.validateKey({ key: 'data/objKey' });
        }, 'Should throw for object key');
    },

    // --- normalizeKey() ---
    'normalizeKey() should replace backslashes with forward slashes'() {
        assertEqual(BitmapIndex.normalizeKey('data\\path\\to\\key'), 'data/path/to/key', 'Backslashes not replaced');
    },

    'normalizeKey() should remove disallowed special characters'() {
        assertEqual(BitmapIndex.normalizeKey('data/key#With$Special*Chars?'), 'data/keyWithSpecialChars', 'Special chars not removed');
    },

    'normalizeKey() should keep underscores, dashes, and dots'() {
        assertEqual(BitmapIndex.normalizeKey('data/key_with-many.dots'), 'data/key_with-many.dots', 'Allowed special chars (including dot) were removed');
    },

    'normalizeKey() should remove exclamation marks not at the beginning'() {
        assertEqual(BitmapIndex.normalizeKey('data/key!InMiddle'), 'data/keyInMiddle', 'Internal exclamation mark not removed');
        assertEqual(BitmapIndex.normalizeKey('data/keyWithEnding!'), 'data/keyWithEnding', 'Ending exclamation mark not removed');
    },

    'normalizeKey() should correctly handle leading exclamation marks and internal ones'() {
        // The method now correctly handles a single leading '!' for negation
        // and removes other '!' as disallowed characters.
        assertEqual(BitmapIndex.normalizeKey('!!data/doubleEx'), '!data/doubleEx', 'Double leading exclamation should result in one leading ! and sanitized content');
        assertEqual(BitmapIndex.normalizeKey('!data/normalNegated'), '!data/normalNegated', 'Normal negated key altered correctly');
        assertEqual(BitmapIndex.normalizeKey('data/!internalExclamation'), 'data/internalExclamation', 'Internal exclamation not removed');
    },

    'normalizeKey() should handle mixed special characters and slashes'() {
        assertEqual(BitmapIndex.normalizeKey('user\\\\path#With$/!mixed\\\\chars'), 'user/pathWith/mixed/chars', 'Mixed normalization failed');
    },

    'normalizeKey() with null or undefined should return null'() {
        assertEqual(BitmapIndex.normalizeKey(null), null, 'normalizeKey(null) should be null');
        assertEqual(BitmapIndex.normalizeKey(undefined), null, 'normalizeKey(undefined) should be null');
    },

    'normalizeKey() should throw for non-string input (if not null/undefined)'() {
        assertThrows(() => {
            BitmapIndex.normalizeKey(12345);
        }, 'Should throw for numeric input to normalizeKey');
        assertThrows(() => {
            BitmapIndex.normalizeKey({ path: 'data/some' });
        }, 'Should throw for object input to normalizeKey');
    }
};

runTestSuite('BitmapIndex Utils (validateKey, normalizeKey)', utilsTestSuite);
