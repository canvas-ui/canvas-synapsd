'use strict';

// Utils
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:collection');

export default class Collection {

    // We can create a collection based on a feature bitmap
    // as a convenience method to work with lets say browser tabs
    // But we can do the same with multiple features (e.g., a tabs and files)
    // and with context bitmaps
    // and even document key prefixes (even though, we do not use compound
    // keys for documents)
    // Before I loose time here, lets make the MVP usable :)

    constructor(name, dataset, options = {}) {
        if (!name) { throw new Error('Collection name required'); }
        if (!dataset) { throw new Error('Dataset required'); }

        this.name = name;
        this.db = dataset;
        this.options = options;

        debug(`Data Collection "${this.name}" initialized`);
    }

    /**
     * Getters
     */

    get collectionName() {
        return this.collectionName;
    }

    get db() {
        return this.db;
    }

    get options() {
        return this.options;
    }

    /**
     * Collection methods
     */

}
