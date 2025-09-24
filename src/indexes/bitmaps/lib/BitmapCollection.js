'use strict';

// Utils
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:bitmap-collection');

// Import BitmapIndex for static method access
import BitmapIndex from '../index.js';

export default class BitmapCollection {

    constructor(name, bitmapIndex, options = {}) {
        if (!name) { throw new Error('BitmapCollection name(prefix) required'); }
        if (!bitmapIndex) { throw new Error('BitmapIndex instance required'); }

        this.name = name;
        this.bitmapIndex = bitmapIndex;
        this.options = options;

        this.keyPrefix = `${name}/`;
        debug(`BitmapCollection "${this.name}" initialized`);
    }

    /**
     * Getters
     */

    get collectionName() { return this.name; }
    get prefix() { return this.keyPrefix; }

    /**
     * Key management
     */

	makeKey(key) {
        // If the input key segment is already '/', it refers to the root of this collection.
        // this.keyPrefix (e.g., 'context/') already correctly represents this root path.
        if (key === '/') {
            debug(`makeKey: segment is '/', returning keyPrefix directly: ${this.keyPrefix}`);
            return this.keyPrefix;
        }

		// Handle negation prefix before other normalizations
		const isNegated = key.startsWith('!');
		let normalizedSegment = isNegated ? key.slice(1) : key;

		// Normalize whitespace and case to ensure consistent keys
		normalizedSegment = String(normalizedSegment)
			.replace(/\s+/g, '_')
			.toLowerCase()
			// Remove/sanitize disallowed characters. Preserve '/', '.', '-', '_'
			.replace(/[^a-z0-9_\-./]/g, '_')
			.replace(/_+/g, '_');

        if (normalizedSegment === '') {
            return this.keyPrefix;
        }

        // Prepend '!' if it was originally negated
        if (isNegated) { normalizedSegment = '!' + normalizedSegment; }

        const constructedKey = `${this.keyPrefix}${normalizedSegment}`;
        return BitmapIndex.normalizeKey(constructedKey);
    }

    /**
     * Core operations
     */

    createBitmap(key, oidArrayOrBitmap, options = {}) {
        return this.bitmapIndex.createBitmap(this.makeKey(key), oidArrayOrBitmap, options);
    }

    listBitmaps() {
        return this.bitmapIndex.listBitmaps(this.keyPrefix);
    }

    getBitmap(key, autoCreateBitmap) {
        return this.bitmapIndex.getBitmap(this.makeKey(key), autoCreateBitmap);
    }

    renameBitmap(oldKey, newKey) {
        return this.bitmapIndex.renameBitmap(
            this.makeKey(oldKey),
            this.makeKey(newKey),
        );
    }

    deleteBitmap(key) {
        return this.bitmapIndex.deleteBitmap(this.makeKey(key));
    }

    hasBitmap(key) {
        return this.bitmapIndex.hasBitmap(this.makeKey(key));
    }


    /**
     * Bitmap index operations
     */

    tick(key, ids) {
        return this.bitmapIndex.tick(this.makeKey(key), ids);
    }

    untick(key, ids) {
        return this.bitmapIndex.untick(this.makeKey(key), ids);
    }

    tickMany(keys, ids) {
        const fullKeys = keys.map(key => this.makeKey(key));
        return this.bitmapIndex.tickMany(fullKeys, ids);
    }

    untickMany(keys, ids) {
        const fullKeys = keys.map(key => this.makeKey(key));
        return this.bitmapIndex.untickMany(fullKeys, ids);
    }

    /**
     * Collection-specific operations
     */

    applyToMany(sourceKey, targetKeys) {
        return this.bitmapIndex.applyToMany(
            this.makeKey(sourceKey),
            targetKeys.map(key => this.makeKey(key)),
        );
    }

    subtractFromMany(sourceKey, targetKeys) {
        return this.bitmapIndex.subtractFromMany(
            this.makeKey(sourceKey),
            targetKeys.map(key => this.makeKey(key)),
        );
    }

    AND(keyArray) {
        return this.bitmapIndex.AND(keyArray.map(key => this.makeKey(key)));
    }

    OR(keyArray) {
        return this.bitmapIndex.OR(keyArray.map(key => this.makeKey(key)));
    }

    XOR(keyArray) {
        return this.bitmapIndex.XOR(keyArray.map(key => this.makeKey(key)));
    }

}
