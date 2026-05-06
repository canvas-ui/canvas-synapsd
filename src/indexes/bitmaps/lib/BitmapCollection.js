'use strict';

// Utils
import debugInstance from 'debug';
import { makeBitmapKey } from './keys.js';
const debug = debugInstance('canvas:synapsd:bitmap-collection');

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
        return makeBitmapKey(this.keyPrefix, key);
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

    mergeBitmap(sourceKey, targetKeys) {
        return this.bitmapIndex.mergeBitmap(
            this.makeKey(sourceKey),
            Array.isArray(targetKeys) ? targetKeys.map(key => this.makeKey(key)) : [this.makeKey(targetKeys)],
        );
    }

    subtractBitmap(sourceKey, targetKeys) {
        return this.bitmapIndex.subtractBitmap(
            this.makeKey(sourceKey),
            Array.isArray(targetKeys) ? targetKeys.map(key => this.makeKey(key)) : [this.makeKey(targetKeys)],
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
