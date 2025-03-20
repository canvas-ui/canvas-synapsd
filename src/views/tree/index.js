'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:context-tree');

// Modules
import SchemaRegistry from '../../schemas/SchemaRegistry.js';
import TreeNode from './lib/TreeNode.js';

/**
 * ContextTree
 *
 * Directory-like tree structure where each "directory" resembles a database view
 * constructed out of "context layers" tied to bitmaps. Layers(and therefore bitmaps)
 * are always indexed based on uuids but presented with the name of the layer(or its
 * label if present) as a standard path string.
 *
 * A example tree path "/foo/bar/baz" therefore represents 3 layers:
 * - foo (uuid1)
 * - bar (uuid2)
 * - baz (uuid3)
 *
 * Listing documents for path /foo/bar/baz does a logical AND of all 3 bitmaps.
 * /foo/reports/2024 and /bar/reports/2024 represent the same "reports" layer,
 * a position within the tree filters your documents.
 *
 * This architecture enables a set of very interesting features besides giving you
 * data deduplication out of the box. We can index content wherever its located and
 * present it in an evolving ad-hoc tree structure that suits your current context.
 *
 * Module was originally part of tha canvas _context_ and later _workspace_ module
 * but is now being moved to synapsd as it is conceptually a better fit, esp with the
 * more bitmap-centric methods we're adding(mergeUp/mergeDown etc).
 */
export default class ContextTree extends EventEmitter {

    constructor(options = {}) {
        super(options.eventEmitterOptions);
        this.options = options;

        // Datasets
        this.documents = options.documentDataset;
        this.metadata = options.metadataDataset;

        // Indexes
        this.bitmapIndex = options.bitmapIndex;
        this.layerIndex = options.layerIndex;

        debug(`ContextTree initialized`);
    }

    /**
     * Getters
     */

    get layers() {}
    get paths() { }
    get pathArray() { }
    get jsonTree() {}

    /**
     * Tree methods
     */

    insertPath(path) {}

    copyPath(pathFrom, pathTo, recursive = false) {}

    movePath(pathFrom, pathTo, recursive = false) {}

    removePath(path, recursive = false) {}

    pathExists(path) {}

    mergeUp(layerPath, fullPath) {}

    mergeDown(layerPath, fullPath) {}

    /**
     * Layer methods
     */

    createLayer(options = {}) { }

    getLayer(name) { }

    getLayerById(id) { }

    renameLayer(name, newName) { }

    updateLayer(name, options) { }

    deleteLayer(layerName) { }

    layerNameToID(name) { }

    layerIdToName(id) { }

    /**
     * Document methods
     */

    getDocument() { }

    getDocumentArray() { }

    listDocuments() { }

    insertDocument() { }

    insertDocumentArray() { }

    updateDocument() { }

    updateDocumentArray() { }

    removeDocument() { }

    removeDocumentArray() { }

    deleteDocument() { }

    deleteDocumentArray() { }

    /**
     * Query methods
     */

    query() { }

    ftsQuery() { }

    /**
     * Internal methods
     */

    /**
     * Get parent path
     * @param {string} path - Child path
     * @returns {string} - Parent path
     */
    #getParentPath(path) {
        return path.split('/').slice(0, -1).join('/') || '/';
    }

    /**
     * Build an array of all paths in the tree
     * @param {boolean} sort - Whether to sort the paths
     * @returns {Array} - Array of paths
     */
    #buildPathArray(sort = true) {
        const paths = [];
        const traverseTree = (node, parentPath) => {
            const path = !parentPath || parentPath === '' ? '/' : `${parentPath}/${node.name}`;
            if (node.children.size > 0) {
                for (const child of node.children.values()) {
                    traverseTree(child, path);
                }
            } else {
                paths.push(path.replace(/\/\//g, '/'));
            }
        };
        traverseTree(this.root);
        return sort ? paths.sort() : paths;
    }

}
