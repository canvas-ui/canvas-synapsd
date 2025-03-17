'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:tree-manager');

// Libs
import Tree from './lib/Tree.js';

// TODO: Add tree versioning
// TODO: Finish this implementation (proxy the Tree class to trigger save on updates)
class TreeManager extends EventEmitter {
    #treeIndexStore;
    #layerIndexStore;
    #tree;

    constructor(options = {}) {
        super(); // EventEmitter

        this.#treeIndexStore = options.treeIndexStore;
        this.#layerIndexStore = options.layerIndexStore;

        this.#tree = new Tree({
            treeIndexStore: this.#treeIndexStore,
            layerIndexStore: this.#layerIndexStore,
        });
    }

    createContextTree() {
        return this.#tree;
    }

    deleteContextTree(id) {
        throw new Error('Not implemented');
    }

    saveContextTree(id) {
        throw new Error('Not implemented');
    }

    loadContextTree(id) {
        throw new Error('Not implemented');
    }

    nextContextTreeVersion(id) {
        throw new Error('Not implemented');
    }

    previousContextTreeVersion(id) {
        throw new Error('Not implemented');
    }

    listContextTreeVersions(id) {
        throw new Error('Not implemented');
    }
}

export default TreeManager;
