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
export default class ContextTree extends EventEmitter {

    #root = null; // Root TreeNode
    #layerIndex = null; // LayerIndex instance
    #bitmapIndex = null; // Reference to BitmapIndex

    constructor(options = {}) {
        super(options.eventEmitterOptions || {});

        if (!options.bitmapIndex) { throw new Error('ContextTree requires bitmapIndex option'); }
        if (!options.layerDataset) { throw new Error('ContextTree requires layerDataset option'); }
        if (!options.treeDataset) { throw new Error('ContextTree requires treeDataset option'); }

        this.#bitmapIndex = options.bitmapIndex;
        this.#layerDataset = options.layerDataset;
        this.#treeDataset = options.treeDataset;

        // Optional datasets
        this.documents = options.documentDataset;
        this.metadata = options.metadataDataset;

        this.options = options; // Store other options

        debug('Initializing context tree...');

        // 1. Load existing layers into memory cache
        this.#loadLayersFromDataset();

        // 2. Ensure root layer exists
        let rootLayer = this.#layersByName.get('/');
        if (!rootLayer) {
            debug('Root layer not found, creating...');
            rootLayer = this.createLayer({ name: '/', type: 'universe', locked: true });
            if (!rootLayer) {
                throw new Error('Failed to create mandatory root layer!');
            }
        }
        this.#root = new TreeNode(rootLayer.id, rootLayer); // Create root TreeNode
        debug(`Root node using layer ID "${rootLayer.id}"`);

        // 3. Load tree structure from dataset
        if (this.#loadTreeStructure()) {
            debug('Context tree structure loaded from dataset.');
        } else {
            debug('Context tree structure not found, using default root node.');
            // Save initial root-only structure
            this.#saveTreeStructure();
        }

        debug(`ContextTree initialized`);

        // Optional: Log the loaded tree structure
        // debug(JSON.stringify(this.buildJsonTree(), null, 2));

        this.emit('tree:ready');
    }

    // --- Persistence ---

    #loadLayersFromDataset() {
        debug('Loading layers from dataset...');
        this.#layersByName.clear();
        this.#layersById.clear();
        // Assuming layerDataset stores layer objects keyed by their ID
        // Adjust iteration based on actual LMDB wrapper interface
        for (const layer of this.#layerDataset.getRange({ values: true })) {
            // Re-instantiate Layer objects? Or assume stored value is sufficient?
            // For now, assume stored value IS the layer object.
            if (layer && layer.id && layer.name) {
                this.#layersByName.set(layer.name, layer);
                this.#layersById.set(layer.id, layer);
            } else {
                debug('Warning: Invalid layer data found in dataset:', layer);
            }
        }
        debug(`Loaded ${this.#layersByName.size} layers into cache.`);
    }

    #saveTreeStructure() {
        debug('Saving tree structure...');
        try {
            const serializedTree = this.#serializeNode(this.#root);
            this.#treeDataset.put('root', serializedTree);
            debug('Tree structure saved.');
            return true;
        } catch (error) {
            debug('Error saving tree structure:', error);
            return false;
        }
    }

    #loadTreeStructure() {
        debug('Loading tree structure...');
        try {
            const serializedTree = this.#treeDataset.get('root');
            if (!serializedTree) {
                debug('No saved tree structure found.');
                return false;
            }
            this.#root = this.#deserializeNode(serializedTree);
             debug('Tree structure loaded successfully.');
            return true;
        } catch (error) {
            debug('Error loading tree structure:', error);
            // Reset to default root if loading fails
             let rootLayer = this.#layersByName.get('/');
             this.#root = new TreeNode(rootLayer.id, rootLayer);
            return false;
        }
    }

    // --- Serialization Helpers (Basic Example) ---

    #serializeNode(node) {
        // Simple serialization: only store layer ID and children IDs
        const children = [];
        for (const child of node.children.values()) {
            children.push(this.#serializeNode(child));
        }
        return {
            id: node.id, // Layer ID
            c: children // Children
        };
    }

    #deserializeNode(data) {
        const layer = this.#layersById.get(data.id);
        if (!layer) {
            throw new Error(`Cannot deserialize node: Layer with ID ${data.id} not found.`);
        }
        const node = new TreeNode(layer.id, layer);
        if (data.c && data.c.length > 0) {
            for (const childData of data.c) {
                node.addChild(this.#deserializeNode(childData));
            }
        }
        return node;
    }

    /**
     * Getters
     */

    get layers() {}
    get paths() {
        // Use the existing helper
        return this.#buildPathArray();
    }
    get pathArray() { }

    /**
     * Builds a serializable JSON representation of the tree structure.
     * @returns {object} JSON representation of the tree.
     */
    get jsonTree() {
        return this.#buildJsonNode(this.#root);
    }

    // --- Helper for jsonTree ---
    #buildJsonNode(node) {
        if (!node) return null;

        const children = {};
        if (node.hasChildren) {
            // Sort children by name for consistent output
            const sortedChildren = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
            for (const child of sortedChildren) {
                children[child.name] = this.#buildJsonNode(child);
            }
        }

        return {
            // Include relevant layer info
            _id: node.id,
            _type: node.payload?.type,
            // _locked: node.payload?.locked,
            ...(Object.keys(children).length > 0 && { children: children })
        };
    }

    /**
     * Tree methods
     */

    /**
     * Ensures a path exists in the tree, creating layers and nodes as needed.
     * Persists the updated tree structure.
     * @param {string} path - Path string (e.g., "/foo/bar").
     * @returns {TreeNode | null} The TreeNode corresponding to the final component of the path, or null if creation failed.
     */
    insertPath(path) {
        debug(`Ensuring path exists: "${path}"`);
        if (path === '/') {
            return this.#root;
        }

        const components = path.replace(/^\/+|\/+$/g, '').split('/').filter(c => c !== '');
        if (components.length === 0) {
            return this.#root; // Should technically not happen due to initial checks
        }

        let currentNode = this.#root;
        let createdNewNode = false;

        for (const component of components) {
            let layer = this.getLayerByName(component);

            // Create layer if it doesn't exist
            if (!layer) {
                debug(`Layer "${component}" not found for path "${path}", creating...`);
                layer = this.createLayer({ name: component, type: 'context' }); // Default to 'context' type?
                if (!layer) {
                     debug(`Failed to create layer "${component}" for path "${path}"`);
                    return null; // Stop if layer creation fails
                }
            }

            // Find or create the child TreeNode
            let childNode = currentNode.getChild(layer.id);
            if (!childNode) {
                debug(`TreeNode for layer "${component}" (ID: ${layer.id}) not found under parent "${currentNode.name}", creating...`);
                childNode = new TreeNode(layer.id, layer);
                currentNode.addChild(childNode);
                createdNewNode = true; // Mark that the tree structure changed
            }

            // Move to the next node in the path
            currentNode = childNode;
        }

        // Save the tree structure if any new nodes were added
        if (createdNewNode) {
            this.#saveTreeStructure();
        }

        debug(`Path "${path}" ensured, final node layer: "${currentNode.name}"`);
        return currentNode; // Return the final node in the path
    }

    /**
     * Finds a TreeNode by its path string.
     * @param {string} path - Path string (e.g., "/foo/bar").
     * @returns {TreeNode | null} The TreeNode if found, otherwise null.
     */
    getNodeByPath(path) {
        if (path === '/') {
            return this.#root;
        }
        const components = path.replace(/^\/+|\/+$/g, '').split('/').filter(c => c !== '');
        if (components.length === 0) {
            return this.#root;
        }

        let currentNode = this.#root;
        for (const component of components) {
            const layer = this.getLayerByName(component);
            if (!layer) {
                return null; // Layer doesn't exist, so node can't exist
            }
            const childNode = currentNode.getChild(layer.id);
            if (!childNode) {
                return null; // Node doesn't exist in the tree structure
            }
            currentNode = childNode;
        }
        return currentNode;
    }

    /**
     * Resolves a path string into an array of context bitmap keys (context/<uuid>).
     * Ensures the path and layers exist if createIfNeeded is true.
     * @param {string} pathString - The path string.
     * @param {boolean} [createIfNeeded=true] - Whether to create nodes/layers.
     * @returns {Promise<string[]>} Array of context bitmap keys.
     */
    async getContextKeysForPath(pathString, createIfNeeded = true) {
        if (!pathString || typeof pathString !== 'string' || pathString === '/') {
            // Root path or invalid path has no keys
            return [];
        }

        const components = pathString.replace(/^\/+|\/+$/g, '').split('/').filter(c => c !== '');
        if (components.length === 0) {
            return []; // Should not happen if check above is correct
        }

        const nodesInPath = []; // Will store the nodes along the path
        let currentNode = this.#root;
        let structureChanged = false;

        for (const component of components) {
            let layer = this.getLayerByName(component);

            if (!layer) {
                // Layer doesn't exist
                if (!createIfNeeded) {
                    debug(`getContextKeysForPath: Layer "${component}" not found for path "${pathString}" and createIfNeeded=false.`);
                    return []; // Path doesn't exist
                }
                // Create the layer
                layer = this.createLayer({ name: component, type: 'context' });
                if (!layer) {
                    debug(`getContextKeysForPath: Failed to create layer "${component}" for path "${pathString}".`);
                    return []; // Layer creation failed
                }
            }

            // Check if node exists under the current parent
            let childNode = currentNode.getChild(layer.id);

            if (!childNode) {
                // Node doesn't exist
                if (!createIfNeeded) {
                    debug(`getContextKeysForPath: TreeNode for layer "${component}" not found in structure for path "${pathString}" and createIfNeeded=false.`);
                    return []; // Path doesn't exist in the tree structure
                }
                // Create the TreeNode
                debug(`getContextKeysForPath: Creating TreeNode for layer "${component}" (ID: ${layer.id}) under parent "${currentNode.name}".`);
                childNode = new TreeNode(layer.id, layer);
                currentNode.addChild(childNode);
                structureChanged = true;
            }

            // Add the found/created node to our list and proceed
            nodesInPath.push(childNode);
            currentNode = childNode;
        }

        // If the structure changed, save it
        if (structureChanged) {
            this.#saveTreeStructure();
        }

        // Map the collected nodes (nodesInPath) to their context keys
        const keys = nodesInPath.map(node => `context/${node.id}`);

        return keys;
    }

    copyPath(pathFrom, pathTo, recursive = false) {}

    movePath(pathFrom, pathTo, recursive = false) {}

    removePath(path, recursive = false) {}

    pathExists(path) {}

    mergeUp(layerPath, fullPath) {}

    mergeDown(layerPath, fullPath) {}

    /**
     * Layer methods
     */

    createLayer(options = {}) {
        let layerName;
        if (typeof options === 'string') {
            layerName = options;
            options = { name: layerName };
        } else {
            layerName = options.name;
        }

        if (!layerName) {
            throw new Error('Layer name is required to create a layer.');
        }

        debug(`Attempting to create layer with options: ${JSON.stringify(options)}`);

        // TODO: Add validation for layer types (LAYER_TYPES constant from old LayerIndex)
        // if (options.type && !LAYER_TYPES.includes(options.type)) {
        //     throw new Error(`Invalid layer type: ${options.type}`);
        // }

        // Check if layer already exists by name
        if (this.#layersByName.has(layerName)) {
            debug(`Layer with name "${layerName}" already exists.`);
            // TODO: Handle update logic if needed (like in old createLayer)
            return this.#layersByName.get(layerName); // Return existing layer
        }

        // Create a new Layer instance (using BaseLayer for now)
        // Generate UUID if not provided
        options.id = options.id || crypto.randomUUID();
        options.name = layerName; // Ensure name is set
        const layer = new Layer(options); // Assumes BaseLayer constructor works like this

        if (!layer || !layer.id) {
            throw new Error(`Failed to instantiate layer with options ${JSON.stringify(options)}`);
        }

        // Persist and cache
        try {
            // TODO: Should check if layer is persistent (e.g., not built-in) before saving?
            this.#layerDataset.put(layer.id, layer); // Store layer object keyed by ID
            this.#layersById.set(layer.id, layer);
            this.#layersByName.set(layer.name, layer);
            debug(`Layer "${layer.name}" (ID: ${layer.id}) created successfully.`);
            this.emit('layer:created', layer);
            return layer;
        } catch (error) {
            debug(`Error persisting/caching layer "${layer.name}":`, error);
            // Clean up cache if persistence failed?
            this.#layersById.delete(layer.id);
            this.#layersByName.delete(layer.name);
            throw new Error(`Failed to save layer "${layer.name}": ${error.message}`);
        }
    }

    getLayer(name) { }

    getLayerById(id) {
        // Primarily uses cache, could fall back to dataset lookup if needed
        return this.#layersById.get(id) || null;
    }

    getLayerByName(name) {
        // Primarily uses cache, could fall back to dataset scan if needed (less efficient)
        return this.#layersByName.get(name) || null;
    }

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
        traverseTree(this.#root);
        return sort ? paths.sort() : paths;
    }

    /**
     * Gets the root TreeNode.
     * @returns {TreeNode}
     */
    getRootNode() {
        return this.#root;
    }

    /**
     * Gets the Layer object for the root node.
     * @returns {Layer | null}
     */
    getRootLayer() {
        return this.#root ? this.#root.payload : null;
    }

    /**
     * Gets the ID (UUID) of the root layer.
     * @returns {string | null}
     */
    getRootLayerId() {
        return this.#root ? this.#root.id : null;
    }

}
