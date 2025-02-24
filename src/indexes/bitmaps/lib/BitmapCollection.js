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
        this.keyPrefix = `collection/${name}/`;

        debug(`BitmapCollection "${this.name}" initialized`);
    }

    /**
     * Key management
     */

    makeKey(key) {
        return `${this.keyPrefix}${key}`;
    }

    /**
     * Core operations
     */

    getBitmap(key, autoCreate = false) {
        return this.bitmapIndex.getBitmap(this.makeKey(key), autoCreate);
    }

    saveBitmap(key, bitmap) {
        return this.bitmapIndex.saveBitmap(this.makeKey(key), bitmap);
    }

    deleteBitmap(key) {
        return this.bitmapIndex.deleteBitmap(this.makeKey(key));
    }

    renameBitmap(oldKey, newKey) {
        return this.bitmapIndex.renameBitmap(
            this.makeKey(oldKey),
            this.makeKey(newKey)
        );
    }

    /**
     * Collection operations
     */

    async listBitmaps() {
        // Use LMDB's range query directly with the collection prefix
        const keys = [];
        for await (const key of this.bitmapIndex.store.getKeys({
            start: this.keyPrefix,
            end: this.keyPrefix + '\uffff'
        })) {
            keys.push(key);
        }
        return keys;
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
            targetKeys.map(key => this.makeKey(key))
        );
    }

    subtractFromMany(sourceKey, targetKeys) {
        return this.bitmapIndex.subtractFromMany(
            this.makeKey(sourceKey),
            targetKeys.map(key => this.makeKey(key))
        );
    }

    /**
     * Context tree operations
     */

    mergeUp(sourceKey, targetKey) {
        const sourceBitmap = this.getBitmap(sourceKey);
        if (!sourceBitmap) return null;

        // Apply source bitmap to all parent layers in targetKey
        const targetParts = targetKey.split('/');
        const targetKeys = [];
        let currentKey = '';

        for (const part of targetParts) {
            currentKey = currentKey ? `${currentKey}/${part}` : part;
            targetKeys.push(currentKey);
        }

        return this.applyToMany(sourceKey, targetKeys);
    }

    moveNode(sourceKey, targetKey) {
        // First apply the bitmap up the targetKey
        this.mergeUp(sourceKey, targetKey);

        // Then subtract it from the sourceKey components
        const sourceParts = sourceKey.split('/');
        const sourceKeys = [];
        let currentKey = '';

        for (const part of sourceParts) {
            currentKey = currentKey ? `${currentKey}/${part}` : part;
            sourceKeys.push(currentKey);
        }

        return this.subtractFromMany(sourceKey, sourceKeys);
    }

    // Create a bitmap in this collection
    createBitmap(name) {
        const key = this.keyPrefix + name;
        return this.bitmapIndex.createBitmap(key);
    }
}
