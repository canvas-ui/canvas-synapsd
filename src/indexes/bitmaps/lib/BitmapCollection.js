'use strict';

// Utils
import debug from 'debug';
const log = debug('canvas-synapsd:bitmapCollection');

export default class BitmapCollection {

    constructor(collectionName, bitmapManager, options = {}) {
        if (!collectionName) { throw new Error('BitmapCollection name required'); }
        if (!bitmapManager) { throw new Error('BitmapManager instance required'); }

        this.collectionName = collectionName;
        this.manager = bitmapManager;
        this.rangeMin = options.rangeMin || 0;
        this.rangeMax = options.rangeMax || 2147483647;

        log(`BitmapCollection "${this.collectionName}" initialized with range ${this.rangeMin} - ${this.rangeMax}`);
    }

    /**
     * Key management
     */

    makeKey(key) {
        return `${this.collectionName}/${key}`;
    }

    /**
     * Core operations
     */

    getBitmap(key, autoCreate = false) {
        return this.manager.getBitmap(this.makeKey(key), autoCreate);
    }

    saveBitmap(key, bitmap) {
        return this.manager.saveBitmap(this.makeKey(key), bitmap);
    }

    deleteBitmap(key) {
        return this.manager.deleteBitmap(this.makeKey(key));
    }

    renameBitmap(oldKey, newKey) {
        return this.manager.renameBitmap(
            this.makeKey(oldKey),
            this.makeKey(newKey)
        );
    }

    /**
     * Collection operations
     */

    listBitmaps() {
        return this.manager.listBitmaps(this.collectionName + '/');
    }

    tickMany(keys, ids) {
        const fullKeys = keys.map(key => this.makeKey(key));
        return this.manager.tickMany(fullKeys, ids);
    }

    untickMany(keys, ids) {
        const fullKeys = keys.map(key => this.makeKey(key));
        return this.manager.untickMany(fullKeys, ids);
    }

    /**
     * Collection-specific operations
     */

    applyToMany(sourceKey, targetKeys) {
        return this.manager.applyToMany(
            this.makeKey(sourceKey),
            targetKeys.map(key => this.makeKey(key))
        );
    }

    subtractFromMany(sourceKey, targetKeys) {
        return this.manager.subtractFromMany(
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
}
