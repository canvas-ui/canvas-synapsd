'use strict';

// Utils
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:bitmap-collection');

export default class BitmapCollection {

    constructor(name, bitmapIndex, options = {}) {
        if (!name) { throw new Error('BitmapCollection name required'); }
        if (!bitmapIndex) { throw new Error('BitmapIndex instance required'); }

        this.name = name;
        this.bitmapIndex = bitmapIndex;
        this.keyPrefix = `${name}/`;

        debug(`BitmapCollection "${this.name}" initialized`);
    }

    /**
     * Key management
     */

    makeKey(key) {
        // Remove "!"" prefix (used for negation)
        let normalizedKey = key.startsWith('!') ? key.slice(1) : key;

        // Remove trailing slashes
        normalizedKey = normalizedKey.endsWith('/') ? normalizedKey.slice(0, -1) : normalizedKey;

        // Return full key
        return `${this.keyPrefix}${normalizedKey}`;
    }

    /**
     * Core operations
     */

    createBitmap(key, oidArrayOrBitmap) {
        return this.bitmapIndex.createBitmap(this.makeKey(key), oidArrayOrBitmap);
    }

    getBitmap(key, autoCreate) {
        return this.bitmapIndex.getBitmap(this.makeKey(key), autoCreate);
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

    async listBitmaps() {
        const keys = [];
        for await (const key of this.bitmapIndex.store.getKeys({
            start: this.keyPrefix,
            end: this.keyPrefix + '\uffff',
        })) { keys.push(key); }

        return keys;
    }


    /**
     * Bitmap index operations
     */

    async tickMany(keys, ids) {
        const fullKeys = keys.map(key => this.makeKey(key));
        return this.bitmapIndex.tickMany(fullKeys, ids);
    }

    async untickMany(keys, ids) {
        const fullKeys = keys.map(key => this.makeKey(key));
        return this.bitmapIndex.untickMany(fullKeys, ids);
    }

    /**
     * Collection-specific operations
     */

    async applyToMany(sourceKey, targetKeys) {
        return this.bitmapIndex.applyToMany(
            this.makeKey(sourceKey),
            targetKeys.map(key => this.makeKey(key)),
        );
    }

    async subtractFromMany(sourceKey, targetKeys) {
        return this.bitmapIndex.subtractFromMany(
            this.makeKey(sourceKey),
            targetKeys.map(key => this.makeKey(key)),
        );
    }

}
