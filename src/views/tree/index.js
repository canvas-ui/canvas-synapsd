'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import debugInstance from 'debug';
const debug = debugInstance('synapsd:context-tree');

// Node.js Crypto for UUIDs
import crypto from 'crypto';

// Modules
import TreeNode from './lib/TreeNode.js';
import LayerIndex from './lib/LayerIndex.js';

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
class ContextTree extends EventEmitter {

    // Data store
    #dataStore = null; // Single data store for layers and the persistent tree structure
    #showHiddenLayers;

    // Runtime state
    #initialized = false;

    #db = null;
    #layerIndex;

    constructor(options = {}) {
        super(options.eventEmitterOptions || {});

        if (!options.dataStore) { throw new Error('ContextTree requires a dataStore reference'); }
        this.#dataStore = options.dataStore;


        // Initialize the layer index class
        this.#layerIndex = new LayerIndex(this.#dataStore, options);
        if (options.db) {
            this.#db = options.db;
        }

        // Options
        this.#showHiddenLayers = options.showHiddenLayers || false;

        // Root node
        this.rootLayer = null;
        this.root = null;
    }

    async initialize() {
        debug('Initializing context tree...');
        await this.#layerIndex.initializeIndex();

        // Root layer is always created by the layer index(as a built-in layer)
        // TODO: We should probably move the logic here
        const rootLayer = this.#layerIndex.getLayerByName('/');
        if (!rootLayer) { throw new Error('Root layer not found'); }

        // Root node
        this.rootLayer = rootLayer;
        this.root = new TreeNode(rootLayer.id, rootLayer);

        // Load the tree from the data store
        await this.#loadTreeFromDataStore();

        debug('Context tree initialized');
        debug(JSON.stringify(this.buildJsonTree(), null, 2));

        this.#initialized = true;
    }

    /**
     * Getters
     */

    get layers() {
        if (!this.#initialized) { throw new Error('ContextTree not initialized'); }
        return this.#layerIndex.listLayers();
    }

    get paths() {
        return this.#buildPathArray();
    }

    /**
     * Path Operations
     */

    /**
     * Check if a path exists in the tree
     * @param {string} path - Path to check
     * @returns {boolean} - True if path exists
     */
    pathExists(path) {
        return this.#getNode(path) ? true : false;
    }

    /**
     * Convert a path to an array of layer IDs
     * @param {string} path - Path to convert
     * @returns {Array} - Array of layer IDs
     */
    pathToLayerIds(path) {
        const layerIds = [];
        const layerNames = path.split('/').filter(Boolean);
        for (const layerName of layerNames) {
            const layer = this.#layerIndex.getLayerByName(layerName);
            if (layer) { layerIds.push(layer.id); }
        }
        return layerIds;
    }

    async insertPath(path = '/', node, autoCreateLayers = true) {
        debug(`Inserting path "${path}" into the context tree`);
        if (path === '/' && !node) {
            return [this.rootLayer.id];
        }

        if (this.pathExists(path)) {
            debug(`Path "${path}" already exists, skipping`);
            return this.pathToLayerIds(path);
        }

        let currentNode = this.root;
        let child;
        const layerIds = [];
        const createdLayers = [];

        const layerNames = path.split('/').filter(Boolean);
        for (const layerName of layerNames) {
            let layer = this.#layerIndex.getLayerByName(layerName);
            if (!layer) {
                debug(`Layer "${layerName}" not found in layerIndex`);
                if (autoCreateLayers) {
                    debug(`Creating layer "${layerName}"`);
                    layer = await this.#layerIndex.createLayer(layerName);
                    createdLayers.push(layer);
                } else {
                    debug(`Layer "${layerName}" not found at path "${path} and autoCreateLayers is disabled"`);
                    return [];
                }
            }

            layerIds.push(layer.id);
            child = currentNode.getChild(layer.id);

            if (!child) {
                child = new TreeNode(layer.id, layer);
                currentNode.addChild(child);
            }

            currentNode = child;
        }

        if (node) {
            child = currentNode.getChild(node.id);
            if (child && child instanceof TreeNode) {
                currentNode.addChild(child);
            }
        }

        await this.#saveTreeToDataStore();
        debug(`Path "${path}" inserted successfully.`);

        // Emit an event with the path and created layers
        this.emit('tree:path:inserted', {
            path,
            layerIds,
            createdLayers: createdLayers.map(layer => ({
                id: layer.id,
                name: layer.name,
                type: layer.type
            }))
        });

        return layerIds;
    }

    async movePath(pathFrom, pathTo, recursive = false) {
        debug(`Moving layer from "${pathFrom}" to "${pathTo}"${recursive ? ' recursively' : ''}`);

        const node = this.#getNode(pathFrom);
        if (!node) {
            debug('Unable to move layer, source node not found');
            return false;
        }

        const parentPath = this.#getParentPath(pathFrom);
        const parentNode = this.#getNode(parentPath);
        if (!parentNode) {
            return false;
        }

        const layer = node.payload;

        if (recursive) {
            // Check if destination contains source
            if (pathTo.includes(layer.name)) {
                throw new Error(`Destination path "${pathTo}" includes "${layer.name}"`);
            }

            // For recursive move, we move the entire subtree
            if (!this.insertPath(pathTo, node)) {
                debug(`Unable to move layer "${layer.name}" into path "${pathTo}"`);
                return false;
            }
        } else {
            // For non-recursive move, we create a new node and transfer children
            const targetNode = new TreeNode(layer.id, layer);

            if (!this.insertPath(pathTo, targetNode)) {
                debug(`Unable to move layer "${layer.name}" to path "${pathTo}"`);
                return false;
            }

            // If node has children, move them to parent
            if (node.hasChildren && !recursive) {
                for (const child of node.children.values()) {
                    parentNode.addChild(child);
                }
            }
        }

        // Remove node from its old location
        parentNode.removeChild(node.id);
        await this.#saveTreeToDataStore();

        // Emit an event with the source and destination paths
        this.emit('tree:path:moved', {
            pathFrom,
            pathTo,
            recursive,
            layerId: layer.id,
            layerName: layer.name,
            layerType: layer.type
        });

        return true;
    }

    async copyPath(pathFrom, pathTo, recursive = false) {
        debug(`Copying layer from "${pathFrom}" to "${pathTo}"${recursive ? ' recursively' : ''}`);

        const sourceNode = this.#getNode(pathFrom);
        if (!sourceNode) {
            debug(`Unable to copy layer, source node not found at path "${pathFrom}"`);
            return false;
        }

        // Create a copy of the source node
        const layer = sourceNode.payload;
        const targetNode = new TreeNode(layer.id, layer);

        if (!this.insertPath(pathTo, targetNode)) {
            debug(`Unable to copy layer "${layer.name}" to path "${pathTo}"`);
            return false;
        }

        // If recursive and source node has children, copy them too
        if (recursive && sourceNode.hasChildren) {
            const pathToWithLayer = pathTo === '/' ? `/${layer.name}` : `${pathTo}/${layer.name}`;

            for (const child of sourceNode.children.values()) {
                const childPath = pathFrom === '/' ? `/${child.name}` : `${pathFrom}/${child.name}`;
                this.copyPath(childPath, pathToWithLayer, true);
            }
        }

        await this.#saveTreeToDataStore();

        // Emit an event with the source and destination paths
        this.emit('tree:path:copied', {
            pathFrom,
            pathTo,
            recursive,
            layerId: layer.id,
            layerName: layer.name,
            layerType: layer.type
        });

        return true;
    }

    /**
     * Remove a path from the tree
     * @param {string} path - Path to remove
     * @param {boolean} recursive - Whether to remove recursively
     * @returns {boolean} - True if successful
     */
    async removePath(path, recursive = false) {
        debug(`Removing path "${path}"${recursive ? ' recursively' : ''}`);

        const node = this.#getNode(path);
        if (!node) {
            debug(`Unable to remove layer, source node not found at path "${path}"`);
            return false;
        }

        const parentPath = this.#getParentPath(path);
        const parentNode = this.#getNode(parentPath);
        if (!parentNode) {
            throw new Error(`Unable to remove layer, parent node not found at path "${parentPath}"`);
        }

        const layer = node.payload;
        const childrenCount = node.children.size;

        // If non-recursive and node has children, move them to parent
        if (!recursive && node.hasChildren) {
            for (const child of node.children.values()) {
                parentNode.addChild(child);
            }
        }

        parentNode.removeChild(node.id);
        await this.#saveTreeToDataStore();

        // Emit an event with path and removal details
        this.emit('tree:path:removed', {
            path,
            recursive,
            layerId: layer.id,
            layerName: layer.name,
            layerType: layer.type,
            hadChildren: childrenCount > 0,
            childrenCount
        });

        return true;
    }

    /**
     * Merge a layer with layers above it (placeholder)
     * @param {string} path - Path to merge
     * @returns {boolean} - True if successful
     */
    async mergeUp(path) {
        debug(`[PLACEHOLDER] Merging layer at "${path}" with layers above it`);
        // TODO: Implement bitmap merging logic

        const node = this.#getNode(path);
        if (!node) {
            debug(`Unable to merge layer, node not found at path "${path}"`);
            return false;
        }

        // Emit an event for the merge operation
        this.emit('tree:layer:merged:up', {
            path,
            layerId: node.id,
            layerName: node.name
        });

        return true;
    }

    /**
     * Merge a layer with layers below it (placeholder)
     * @param {string} path - Path to merge
     * @returns {boolean} - True if successful
     */
    async mergeDown(path) {
        debug(`[PLACEHOLDER] Merging layer at "${path}" with layers below it`);
        // TODO: Implement bitmap merging logic

        const node = this.#getNode(path);
        if (!node) {
            debug(`Unable to merge layer, node not found at path "${path}"`);
            return false;
        }

        // Emit an event for the merge operation
        this.emit('tree:layer:merged:down', {
            path,
            layerId: node.id,
            layerName: node.name
        });

        return true;
    }

    /**
     * Document CRUD (convenience) wrapper methods for the db backend
     */

    insertDocument(document, contextSpec = '/', featureBitmapArray = []) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.insertDocument(document, contextSpec, featureBitmapArray);
    }

    insertDocumentArray(docArray, contextSpec = '/', featureBitmapArray = []) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.insertDocumentArray(docArray, contextSpec, featureBitmapArray);
    }

    hasDocument(id, contextSpec = '/', featureBitmapArray = []) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.hasDocument(id, contextSpec, featureBitmapArray);
    }

    hasDocumentByChecksum(checksum, contextSpec = null, featureBitmapArray = []) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.hasDocumentByChecksum(checksum, contextSpec, featureBitmapArray);
    }

    listDocuments(contextSpec = null, featureBitmapArray = [], filterArray = [], options = { limit: null }) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.listDocuments(contextSpec, featureBitmapArray, filterArray, options);
    }

    updateDocument(document, contextSpec = null, featureBitmapArray = []) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.updateDocument(document, contextSpec, featureBitmapArray);
    }

    updateDocumentArray(docArray, contextSpec = null, featureBitmapArray = []) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.updateDocumentArray(docArray, contextSpec, featureBitmapArray);
    }

    removeDocument(documentId, contextSpec = null, featureBitmapArray = []) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.removeDocument(documentId, contextSpec, featureBitmapArray);
    }

    removeDocumentArray(docIdArray, contextSpec = null, featureBitmapArray = []) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.removeDocumentArray(docIdArray, contextSpec, featureBitmapArray);
    }

    deleteDocument(documentId) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.deleteDocument(documentId);
    }

    deleteDocumentArray(docIdArray) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.deleteDocumentArray(docIdArray);
    }

    getById(id) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.getById(id);
    }

    getByIdArray(idArray) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.getByIdArray(idArray);
    }

    getByChecksumString(checksumString) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.getByChecksumString(checksumString);
    }

    getByChecksumStringArray(checksumStringArray) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.getByChecksumStringArray(checksumStringArray);
    }

    query(query, contextBitmapArray = [], featureBitmapArray = [], filterArray = [], metadataOnly = false) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.query(query, contextBitmapArray, featureBitmapArray, filterArray, metadataOnly);
    }

    ftsQuery(query, contextBitmapArray = [], featureBitmapArray = [], filterArray = [], metadataOnly = false) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.ftsQuery(query, contextBitmapArray, featureBitmapArray, filterArray, metadataOnly);
    }

    /**
     * Node Methods
     */

    /**
     * Get a node by path
     * @param {string} path - Path to node
     * @returns {Object} - Node or false if not found
     */
    #getNode(path) {
        if (path === '/' || !path) {
            return this.root;
        }
        const layerNames = path.split('/').filter(Boolean);
        let currentNode = this.root;

        for (const layerName of layerNames) {
            const layer = this.#layerIndex.getLayerByName(layerName);
            if (!layer) {
                debug(`Layer "${layerName}" not found in index`);
                return false;
            }

            const child = currentNode.getChild(layer.id);
            if (!child) {
                debug(`Target path "${path}" does not exist`);
                return false;
            }

            currentNode = child;
        }

        return currentNode;
    }

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

    /**
     * Build JSON representation of the tree
     * @param {Object} node - Root node
     * @returns {Object} - JSON tree
     */
    buildJsonTree(node = this.root) {
        const buildTree = (currentNode) => {
            const children = Array.from(currentNode.children.values())
                .filter((child) => child instanceof TreeNode)
                .map((child) => (child.hasChildren ? buildTree(child) : createLayerInfo(child.payload)));

            let layer = this.#layerIndex.getLayerByID(currentNode.id)
            if (!layer) { layer = this.rootLayer; }
            return createLayerInfo(layer, children);
        };

        const createLayerInfo = (payload, children = []) => {
            // Normalize the name to avoid issues with paths
            const normalizedName = payload.name === '/' ? '/' : payload.name;

            return {
                id: payload.id,
                type: payload.type,
                name: normalizedName, // Use normalized name
                label: payload.label,
                description: payload.description,
                color: payload.color,
                locked: payload.locked,
                children
            };
        };

        return buildTree(node);
    }

    recalculateTree() {
        debug('Recalculating tree after layer changes');
        // Create a copy of the current tree without deleted layers
        const newRoot = new TreeNode(this.rootLayer.id, this.rootLayer);

        const rebuildTree = (oldNode, newParent) => {
            for (const child of oldNode.children.values()) {
                const layer = this.#layerIndex.getLayerByID(child.id);
                if (layer) {
                    const newChild = new TreeNode(layer.id, layer);
                    newParent.addChild(newChild);

                    if (child.hasChildren) {
                        rebuildTree(child, newChild);
                    }
                }
            }
        };

        rebuildTree(this.root, newRoot);
        this.root = newRoot;
        this.save();

        // Emit a recalculation event
        this.emit('tree:recalculated', {
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Build a tree from JSON
     * @param {Object} rootNode - Root node data
     * @param {boolean} autoCreateLayers - Whether to automatically create layers
     * @returns {Object} - Built tree
     */
    #buildTreeFromJson(rootNode = this.root, autoCreateLayers = true) {
        const buildTree = (nodeData) => {
            let node;
            let layer;

            // Extract the ID without the "layer/" prefix if it exists
            const layerId = nodeData.id.startsWith('layer/') ? nodeData.id : `layer/${nodeData.id}`;

            // Try both formats - with and without the "layer/" prefix
            layer = this.#layerIndex.getLayerByID(layerId) || this.#layerIndex.getLayerByID(nodeData.id);

            if ((!layer && !nodeData.name) || (!layer && !autoCreateLayers)) {
                throw new Error(`Unable to find layer by ID "${nodeData.id}", can not create a tree node`);
            }

            if (!layer && autoCreateLayers) {
                layer = this.#layerIndex.createLayer(nodeData.name);
            }

            // Ensure we have a valid layer before creating TreeNode
            if (!layer) {
                throw new Error(`Failed to get or create layer for ID "${nodeData.id}" and name "${nodeData.name}"`);
            }

            node = new TreeNode(layer.id, layer);
            for (const childData of nodeData.children) {
                const childNode = buildTree(childData);
                node.addChild(childNode);
            }

            return node;
        };

        return buildTree(rootNode);
    }

    /**
     * Data Store Methods
     */

    async #saveTreeToDataStore() {
        debug('Saving in-memory context tree to database');
        const data = this.buildJsonTree();
        try {
            await this.#dataStore.put('tree', data);
            debug('Tree saved successfully.');

            // Emit a save event
            this.emit('tree:saved', {
                timestamp: new Date().toISOString()
            });

            return true;
        } catch (error) {
            debug(`Error saving tree to database: ${error.message}`);

            // Emit an error event
            this.emit('tree:error', {
                operation: 'save',
                error: error.message
            });

            throw error;
        }
    }

    #loadTreeFromDataStore() {
        debug('Loading tree from the data store...');
        const jsonTree = this.#dataStore.get('tree');
        if (!jsonTree) {
            debug('No persistent Tree data found in the data store, creating a new one...');
            return;
        }

        debug('Found persistent Tree data in the data store, re-building tree...');
        this.root = this.#buildTreeFromJson(jsonTree);

        // Emit a load event
        this.emit('tree:loaded', {
            timestamp: new Date().toISOString()
        });

        return true;
    }
}

export default ContextTree;
