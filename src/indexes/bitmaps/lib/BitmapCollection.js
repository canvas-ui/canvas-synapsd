'use strict';

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

    makeKey(name) {
        return `${this.collectionName}/${name}`;
    }

    /**
     * Core operations
     */

    getBitmap(name, autoCreate = false) {
        return this.manager.getBitmap(this.makeKey(name), autoCreate);
    }

    saveBitmap(name, bitmap) {
        return this.manager.saveBitmap(this.makeKey(name), bitmap);
    }

    deleteBitmap(name) {
        return this.manager.deleteBitmap(this.makeKey(name));
    }

    renameBitmap(oldName, newName) {
        return this.manager.renameBitmap(
            this.makeKey(oldName),
            this.makeKey(newName)
        );
    }

    /**
     * Collection operations
     */

    listBitmaps() {
        return this.manager.listBitmaps(this.collectionName + '/');
    }

    tickMany(names, ids) {
        const keys = names.map(name => this.makeKey(name));
        return this.manager.tickMany(keys, ids);
    }

    untickMany(names, ids) {
        const keys = names.map(name => this.makeKey(name));
        return this.manager.untickMany(keys, ids);
    }

    /**
     * Bitmap operations
     */

    AND(names) {
        const keys = names.map(name => this.makeKey(name));
        return this.manager.AND(keys);
    }

    OR(names) {
        const keys = names.map(name => this.makeKey(name));
        return this.manager.OR(keys);
    }

    NOT(sourceName, targetName) {
        return this.manager.NOT(
            this.makeKey(sourceName),
            this.makeKey(targetName)
        );
    }

    /**
     * Collection-specific operations
     */

    applyToMany(sourceName, targetNames) {
        return this.manager.applyToMany(
            this.makeKey(sourceName),
            targetNames.map(name => this.makeKey(name))
        );
    }

    subtractFromMany(sourceName, targetNames) {
        return this.manager.subtractFromMany(
            this.makeKey(sourceName),
            targetNames.map(name => this.makeKey(name))
        );
    }

    /**
     * Context tree operations
     */

    mergeUp(sourcePath, targetPath) {
        const sourceBitmap = this.getBitmap(sourcePath);
        if (!sourceBitmap) return null;

        // Apply source bitmap to all parent layers in target path
        const targetParts = targetPath.split('/');
        const targetNames = [];
        let currentPath = '';

        for (const part of targetParts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            targetNames.push(currentPath);
        }

        return this.applyToMany(sourcePath, targetNames);
    }

    moveNode(sourcePath, targetPath) {
        // First apply the bitmap up the target path
        this.mergeUp(sourcePath, targetPath);

        // Then subtract it from the source path components
        const sourceParts = sourcePath.split('/');
        const sourceNames = [];
        let currentPath = '';

        for (const part of sourceParts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            sourceNames.push(currentPath);
        }

        return this.subtractFromMany(sourcePath, sourceNames);
    }
}
