'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:tree');

// Libs
import TreeNode from './TreeNode.js';
import LayerIndex from '../layers/index.js';
import { v4 as uuidv4 } from 'uuid';

class Tree extends EventEmitter {
    constructor(options = {}) {
        super();

        if (!options.treeIndexStore) {
            throw new Error('Tree index not provided');
        }
        if (!options.layerIndexStore) {
            throw new Error('Layer index not provided');
        }

        // Database stores for tree and layers
        this.dbtree = options.treeIndexStore;
        this.dblayers = new LayerIndex(options.layerIndexStore, options.rootLayerOptions);

        this.showHidden = false;

        debug('Initializing context tree');

        this.rootLayer = this.dblayers.getLayerByName('/');
        if (!this.rootLayer) {
            throw new Error('Root layer not found in the layer index');
        }

        this.root = new TreeNode(this.rootLayer.id, this.rootLayer);
        debug(
            `Root node created with layer ID "${this.rootLayer.id}", name "${this.rootLayer.name}" of type "${this.rootLayer.type}"`,
        );

        if (this.load()) {
            debug('Context tree loaded from database');
        } else {
            debug('Context tree not found in database, using vanilla root node');
        }

        debug('Context tree initialized');
        debug(JSON.stringify(this.buildJsonTree(), null, 2));

        this.emit('tree:ready');
    }

    // =======================================================================
    // Getters
    // =======================================================================

    /**
     * Get all paths in the tree
     * @returns {Array} - Array of paths
     */
    get paths() {
        return this.#buildPathArray();
    }

    /**
     * Get the layer index
     * @returns {Object} - Layer index
     */
    get layers() {
        return this.dblayers;
    }

    /**
     * Get JSON representation of the tree
     * @returns {Object} - JSON tree
     */
    get jsonTree() {
        return this.buildJsonTree();
    }

    // =======================================================================
    // Path Operations
    // =======================================================================

    /**
     * Check if a path exists in the tree
     * @param {string} path - Path to check
     * @returns {boolean} - True if path exists
     */
    pathExists(path) {
        return this.getNode(path) ? true : false;
    }

    /**
     * Insert a path into the tree
     * @param {string} path - Path to insert
     * @param {Object} node - Optional node to insert at the path
     * @param {boolean} autoCreateLayers - Whether to automatically create layers
     * @returns {Array} - Array of layer IDs created
     */
    insertPath(path = '/', node, autoCreateLayers = true) {
        debug(`Inserting path "${path}" to the context tree`);
        if (path === '/' && !node) {
            return [];
        }

        let currentNode = this.root;
        let child;
        const layerIds = [];
        const createdLayers = [];

        const layerNames = path.split('/').filter(Boolean);
        for (const layerName of layerNames) {
            let layer = this.dblayers.getLayerByName(layerName);
            if (this.dblayers.isInternalLayerName(layerName)) {
                throw new Error(`Layer "${layerName}" is internal and can not be used in the tree`);
            }

            if (!layer) {
                if (autoCreateLayers) {
                    layer = this.dblayers.createLayer(layerName);
                    createdLayers.push(layer);
                } else {
                    debug(`Layer "${layerName}" not found at path "${path} and autoCreateLayers is disabled"`);
                    return [];
                }
            }

            layerIds.push(layer.id);

            child = currentNode.getChild(layer.id);
            if (!child) {
                child = new TreeNode(layer.id, this.dblayers.getLayerByID(layer.id));
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

        this.save();
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

    /**
     * Move a path in the tree
     * @param {string} pathFrom - Source path
     * @param {string} pathTo - Destination path
     * @param {boolean} recursive - Whether to move recursively
     * @returns {boolean} - True if successful
     */
    movePath(pathFrom, pathTo, recursive = false) {
        debug(`Moving layer from "${pathFrom}" to "${pathTo}"${recursive ? ' recursively' : ''}`);

        const node = this.getNode(pathFrom);
        if (!node) {
            debug('Unable to move layer, source node not found');
            return false;
        }

        const parentPath = this.#getParentPath(pathFrom);
        const parentNode = this.getNode(parentPath);
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
        this.save();

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

    /**
     * Copy a path in the tree
     * @param {string} pathFrom - Source path
     * @param {string} pathTo - Destination path
     * @param {boolean} recursive - Whether to copy recursively
     * @returns {boolean} - True if successful
     */
    copyPath(pathFrom, pathTo, recursive = false) {
        debug(`Copying layer from "${pathFrom}" to "${pathTo}"${recursive ? ' recursively' : ''}`);

        const sourceNode = this.getNode(pathFrom);
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

        this.save();

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
    removePath(path, recursive = false) {
        debug(`Removing path "${path}"${recursive ? ' recursively' : ''}`);

        const node = this.getNode(path);
        if (!node) {
            debug(`Unable to remove layer, source node not found at path "${path}"`);
            return false;
        }

        const parentPath = this.#getParentPath(path);
        const parentNode = this.getNode(parentPath);
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
        this.save();

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
    mergeUp(path) {
        debug(`[PLACEHOLDER] Merging layer at "${path}" with layers above it`);
        // TODO: Implement bitmap merging logic

        const node = this.getNode(path);
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
    mergeDown(path) {
        debug(`[PLACEHOLDER] Merging layer at "${path}" with layers below it`);
        // TODO: Implement bitmap merging logic

        const node = this.getNode(path);
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

    // =======================================================================
    // Layer Management
    // =======================================================================

    /**
     * Rename a layer
     * @param {string} name - Current layer name
     * @param {string} newName - New layer name
     * @returns {boolean} - True if successful
     */
    renameLayer(name, newName) {
        debug(`Renaming layer "${name}" to "${newName}"`);
        const result = this.dblayers.renameLayer(name, newName);

        if (result) {
            const layer = this.dblayers.getLayerByName(newName);
            this.emit('tree:layer:renamed', {
                oldName: name,
                newName,
                layerId: layer.id
            });
        }

        return result;
    }

    /**
     * Update a layer's properties
     * @param {string} name - Layer name
     * @param {Object} options - Layer properties
     * @returns {boolean} - True if successful
     */
    updateLayer(name, options) {
        debug(`Updating layer "${name}" with options: ${JSON.stringify(options)}`);
        const result = this.dblayers.updateLayer(name, options);

        if (result) {
            const layer = this.dblayers.getLayerByName(name);
            this.emit('tree:layer:updated', {
                name,
                layerId: layer.id,
                updates: options
            });
        }

        return result;
    }

    /**
     * Delete a layer from the database
     * @param {string} layerName - Layer name
     * @returns {boolean} - True if successful
     */
    deleteLayer(layerName) {
        debug(`Deleting layer "${layerName}" from database`);

        const layer = this.dblayers.getLayerByName(layerName);
        if (!layer) {
            return false;
        }

        const layerId = layer.id;

        // This requires a full tree recalculation
        const success = this.dblayers.removeLayerByName(layerName);
        if (success) {
            this.recalculateTree();

            this.emit('tree:layer:deleted', {
                name: layerName,
                layerId
            });
        }

        return success;
    }

    /**
     * Create a new layer with the given properties
     * @param {Object} options - Layer properties
     * @returns {Object} - Created layer
     */
    createLayer(options = {}) {
        debug(`Creating layer with options: ${JSON.stringify(options)}`);

        // Generate a UUID if not provided
        if (!options.id) {
            options.id = uuidv4();
        }

        // Set default type if not provided
        if (!options.type) {
            options.type = 'context';
        }

        // Create the layer in the layer index
        const layer = this.dblayers.createLayer(options);

        if (!layer) {
            throw new Error(`Failed to create layer with options: ${JSON.stringify(options)}`);
        }

        debug(`Layer created: ${layer.name} (${layer.id})`);

        // Emit a layer created event
        this.emit('tree:layer:created', {
            id: layer.id,
            name: layer.name,
            type: layer.type,
            options
        });

        return layer;
    }

    /**
     * Get a layer by name
     * @param {string} name - Layer name
     * @returns {Object} - Layer object or null if not found
     */
    getLayer(name) {
        return this.dblayers.getLayerByName(name);
    }

    /**
     * Get a layer by ID
     * @param {string} id - Layer ID
     * @returns {Object} - Layer object or null if not found
     */
    getLayerById(id) {
        return this.dblayers.getLayerByID(id);
    }

    // =======================================================================
    // JSON Serialization
    // =======================================================================

    /**
     * Save the tree to JSON
     * @returns {boolean} - True if successful
     */
    save() {
        debug('Saving in-memory tree to database');
        const data = this.#buildJsonIndexTree();
        try {
            this.dbtree.set('tree', data);
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

    /**
     * Load the tree from JSON
     * @returns {boolean} - True if successful
     */
    load() {
        debug('Loading JSON Tree from database...');
        const json = this.dbtree.get('tree');
        if (!json) {
            debug('No persistent JSON data found');
            return false;
        }

        this.root = this.#buildTreeFromJson(json);

        // Emit a load event
        this.emit('tree:loaded', {
            timestamp: new Date().toISOString()
        });

        return true;
    }

    /**
     * Clear the tree and reset to root
     */
    clear() {
        debug('Clearing context tree');
        this.root = new TreeNode(this.rootLayer.id, this.rootLayer);
        this.save();

        // Emit a clear event
        this.emit('tree:cleared', {
            timestamp: new Date().toISOString()
        });
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

            return createLayerInfo(this.dblayers.getLayerByID(currentNode.id) || this.rootLayer, children);
        };

        const createLayerInfo = (payload, children = []) => {
            // Normalize the name to avoid issues with paths
            const normalizedName = payload.name === '/' ? '' : payload.name;

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

    /**
     * Recalculate the tree after layer deletion
     */
    recalculateTree() {
        debug('Recalculating tree after layer changes');
        // Create a copy of the current tree without deleted layers
        const newRoot = new TreeNode(this.rootLayer.id, this.rootLayer);

        const rebuildTree = (oldNode, newParent) => {
            for (const child of oldNode.children.values()) {
                const layer = this.dblayers.getLayerByID(child.id);
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

    // =======================================================================
    // Node Operations
    // =======================================================================

    /**
     * Get a node by path
     * @param {string} path - Path to node
     * @returns {Object} - Node or false if not found
     */
    getNode(path) {
        if (path === '/' || !path) {
            return this.root;
        }
        const layerNames = path.split('/').filter(Boolean);
        let currentNode = this.root;

        for (const layerName of layerNames) {
            const layer = this.dblayers.getLayerByName(layerName);
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

    // =======================================================================
    // Private Methods
    // =======================================================================

    /**
     * Get parent path
     * @param {string} path - Child path
     * @returns {string} - Parent path
     */
    #getParentPath(path) {
        return path.split('/').slice(0, -1).join('/') || '/';
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

            layer = this.dblayers.getLayerByID(nodeData.id);
            if ((!layer && !nodeData.name) || (!layer && !autoCreateLayers)) {
                throw new Error(`Unable to find layer by ID "${nodeData.id}", can not create a tree node`);
            }

            if (!layer && autoCreateLayers) {
                layer = this.dblayers.createLayer(nodeData.name);
            }

            node = new TreeNode(layer.id, this.dblayers.getLayerByID(layer.id));
            for (const childData of nodeData.children) {
                const childNode = buildTree(childData);
                node.addChild(childNode);
            }

            return node;
        };

        return buildTree(rootNode);
    }

    /**
     * Build a JSON index tree
     * @param {Object} node - Root node
     * @returns {Object} - JSON index tree
     */
    #buildJsonIndexTree(node = this.root) {
        const buildTree = (currentNode) => {
            const children = Array.from(currentNode.children.values())
                .filter((child) => child instanceof TreeNode)
                .map((child) =>
                    child.hasChildren
                        ? buildTree(child)
                        : {
                              id: child.id,
                              children: [],
                          },
                );

            return {
                id: currentNode.id,
                children: children,
            };
        };

        return buildTree(node);
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

export default Tree;
