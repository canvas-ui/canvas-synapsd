'use strict';

// Utils
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:bitmap-collection');

// Core
import Collection from '../../core/Collection';

export default class BitmapCollection extends Collection {

    constructor(name, dataset, options = {}) {
        if (!name) { throw new Error('BitmapCollection name required'); }
        if (!dataset) { throw new Error('dataset instance required'); }

        // Bitmap specific options
        if (!options.bitmapManager) { throw new Error('bitmapManager instance required'); }
        this.bitmapIndex = options.bitmapManager;

        // Initialize
        super(name, dataset, options);
    }


    /**
     * Core operations
     */

    createBitmap(key, oidArrayOrBitmap) {
        return this.bitmapIndex.createBitmap(super.makeKey(key), oidArrayOrBitmap);
    }

    getBitmap(key, autoCreate) {
        return this.bitmapIndex.getBitmap(super.makeKey(key), autoCreate);
    }

    renameBitmap(oldKey, newKey) {
        return this.bitmapIndex.renameBitmap(
            super.makeKey(oldKey),
            super.makeKey(newKey),
        );
    }

    deleteBitmap(key) {
        return this.bitmapIndex.deleteBitmap(super.makeKey(key));
    }

    hasBitmap(key) {
        return this.bitmapIndex.hasBitmap(super.makeKey(key));
    }

    listBitmaps() {
        return super.listDocuments();
    }


    /**
     * Bitmap index operations
     */

    async tickMany(keys, ids) {
        const fullKeys = keys.map(key => super.makeKey(key));
        return this.bitmapIndex.tickMany(fullKeys, ids);
    }

    async untickMany(keys, ids) {
        const fullKeys = keys.map(key => super.makeKey(key));
        return this.bitmapIndex.untickMany(fullKeys, ids);
    }

    /**
     * Collection-specific operations
     */

    async applyToMany(sourceKey, targetKeys) {
        return this.bitmapIndex.applyToMany(
            super.makeKey(sourceKey),
            targetKeys.map(key => super.makeKey(key)),
        );
    }

    async subtractFromMany(sourceKey, targetKeys) {
        return this.bitmapIndex.subtractFromMany(
            super.makeKey(sourceKey),
            targetKeys.map(key => super.makeKey(key)),
        );
    }

}
