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
    // keys for documents) - Before I loose time here, lets make the MVP usable
    // by avoiding the implementation for now :)

    constructor(name, dataset, options = {}) {
        if (!name) { throw new Error('Collection name required'); }
        if (!dataset) { throw new Error('Dataset required'); }

        this.name = name;
        this.dataset = dataset;
        this.options = options;

        // this.contextArray =  options.contextArray || [];
        // this.featureArray = options.featureArray || [];

        debug(`Data Collection "${this.name}" initialized with options: ${JSON.stringify(this.options)}`);
    }

    /**
     * Getters
     */

    get collectionName() {
        return this.collectionName;
    }

    get dataset() {
        return this.dataset;
    }

    get options() {
        return this.options;
    }

    /**
     * Key management
     */

    makeKey(key) {
        // Remove "!"" prefix (used for negation)
        let normalizedKey = key.startsWith('!') ? key.slice(1) : key;

        // Convert path to posix
        normalizedKey = normalizedKey.replace(/\\/g, '/');

        // Remove trailing slashes
        normalizedKey = normalizedKey.endsWith('/') ? normalizedKey.slice(0, -1) : normalizedKey;

        // Return full key (collection name / key)
        return `${this.name}/${normalizedKey}`;
    }

    /**
     * Collection methods
     */

    insertDocument(key, document) {
        return this.dataset.put(this.makeKey(key), document);
    }

    getDocument(key) {
        return this.dataset.getDocument(this.makeKey(key));
    }

    deleteDocument(key) {
        return this.dataset.remove(this.makeKey(key));
    }

    hasDocument(key) {
        return this.dataset.doesExist(this.makeKey(key));
    }

    async listDocuments() {
        const keys = [];
        for await (const key of this.dataset.getKeys({
            start: this.name,
            end: this.name + '\uffff',
        })) { keys.push(key); }

        return keys;
    }


}
