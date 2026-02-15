'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:context-tree');

// Modules
import TreeNode from './lib/TreeNode.js';
import LayerIndex from './lib/LayerIndex.js';

// ULID/UUID detection: starts with 'layer/' or looks like a raw ID (26-char ULID or UUID with dashes)
const looksLikeId = (s) => typeof s === 'string' && (s.startsWith('layer/') || /^[0-9A-Z]{26}$/.test(s) || s.includes('-'));

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
     * ============================================================================
     * Getters / Setters
     * ============================================================================
     */

    get layers() {
        if (!this.#initialized) { throw new Error('ContextTree not initialized'); }
        return this.#layerIndex.listLayers();
    }

    get paths() {
        return this.#buildPathArray();
    }

    getLayer(name) {
        if (!this.#initialized) { throw new Error('ContextTree not initialized'); }
        if (!name) { return undefined; }
        return this.#layerIndex.getLayerByName(name);
    }

    getLayerById(id) {
        if (!this.#initialized) { throw new Error('ContextTree not initialized'); }
        if (!id) { return undefined; }
        return this.#layerIndex.getLayerByID(id);
    }

    getLayerForPath(path) {
        const normalizedPath = this.#normalizePath(path);
        debug(`Getting layer for normalized path "${normalizedPath}"`);
        try {
            const nodes = this.#getNodesForPath(normalizedPath);
            if (!nodes || nodes.length === 0) {
                return null; // Should not happen if root always exists
            }
            // The last node in the array corresponds to the final segment of the path
            const finalNode = nodes[nodes.length - 1];
            return finalNode.payload; // Return the Layer object
        } catch (error) {
            debug(`Failed to get layer for path "${normalizedPath}": ${error.message}`);
            return null; // Return null if path resolution failed
        }
    }

    /**
     * ============================================================================
     * Layer methods
     * ============================================================================
     */

    async listLayers() {
        if (!this.#initialized) { throw new Error('ContextTree not initialized'); }
        const keys = await this.#layerIndex.listLayers(); // ['layer/<uuid>', ...]
        const result = [];
        for (const key of keys) {
            try {
                const layer = this.#layerIndex.getLayerByID(key);
                if (layer) { result.push(layer); }
            } catch (e) {
                debug(`listLayers: failed to reconstruct layer ${key}: ${e.message}`);
            }
        }
        return result;
    }

    async renameLayer(nameOrId, newName) {
        if (!this.#initialized) { throw new Error('ContextTree not initialized'); }
        if (!newName) { throw new Error('New name required'); }
        // Accept both ID and name. Prefer ID if it looks like one.
        let currentName = nameOrId;
        if (looksLikeId(nameOrId)) {
            const layer = this.getLayerById(nameOrId);
            if (!layer) { throw new Error(`Layer not found with ID: ${nameOrId}`); }
            currentName = layer.name;
        }

        // Bitmaps are keyed by ULID, not by name. No bitmap rename needed - O(1) rename!
        const layer = await this.#layerIndex.renameLayer(String(currentName), String(newName));
        // Persist updated tree JSON to reflect renamed layer names
        await this.recalculateTree();
        return layer;
    }

    async updateLayer(nameOrId, updates = {}) {
        if (!this.#initialized) { throw new Error('ContextTree not initialized'); }
        let targetName = nameOrId;
        if (looksLikeId(nameOrId)) {
            const layer = this.getLayerById(nameOrId);
            if (!layer) { throw new Error(`Layer not found with ID: ${nameOrId}`); }
            targetName = layer.name;
        }
        const layer = await this.#layerIndex.updateLayer(String(targetName), { ...updates });
        return layer;
    }

    async deleteLayer(nameOrId) {
        if (!this.#initialized) { throw new Error('ContextTree not initialized'); }
        let layer = null;
        if (looksLikeId(nameOrId)) {
            layer = this.getLayerById(nameOrId);
        } else {
            layer = this.getLayer(String(nameOrId));
        }
        if (!layer) { throw new Error(`Layer not found: ${nameOrId}`); }

        // Clean up the associated bitmap (keyed by ULID)
        if (this.#db && this.#db.contextBitmapCollection) {
            try {
                debug(`Cleaning up bitmap for layer ${layer.name} (ID: ${layer.id})`);
                await this.#db.contextBitmapCollection.deleteBitmap(layer.id);
                debug(`Successfully deleted bitmap for layer ${layer.name}`);
            } catch (error) {
                debug(`Warning: Failed to delete bitmap for layer ${layer.name}: ${error.message}`);
            }
        }

        await this.#layerIndex.removeLayer(layer);
        // Rebuild tree to drop references to the deleted layer
        await this.recalculateTree();
        return true;
    }

    async lockLayer(nameOrId, lockBy) {
        if (!this.#initialized) { throw new Error('ContextTree not initialized'); }
        if (!lockBy) { throw new Error('Locking layer requires a lockBy parameter'); }
        const layer = looksLikeId(nameOrId)
            ? this.getLayerById(nameOrId)
            : this.getLayer(String(nameOrId));
        if (!layer) { throw new Error(`Layer not found: ${nameOrId}`); }
        layer.lock(lockBy);
        await this.#layerIndex.persistLayer(layer);
        return true;
    }

    async unlockLayer(nameOrId, lockBy) {
        if (!this.#initialized) { throw new Error('ContextTree not initialized'); }
        if (!lockBy) { throw new Error('Unlocking layer requires a lockBy parameter'); }
        const layer = looksLikeId(nameOrId)
            ? this.getLayerById(nameOrId)
            : this.getLayer(String(nameOrId));
        if (!layer) { throw new Error(`Layer not found: ${nameOrId}`); }
        layer.unlock(lockBy);
        await this.#layerIndex.persistLayer(layer);
        return true;
    }

    async mergeLayer(layerId, layerArray) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        try {
            const sourceLayer = this.getLayer(layerId) || this.getLayerById(layerId);
            if (!sourceLayer) {
                return { data: null, count: 0, error: `Source layer "${layerId}" not found.` };
            }

            const targetLayers = Array.isArray(layerArray) ? layerArray : [layerArray];
            const targetIds = [];

            for (const targetId of targetLayers) {
                const targetLayer = this.getLayer(targetId) || this.getLayerById(targetId);
                if (!targetLayer) {
                    debug(`Target layer "${targetId}" not found, skipping.`);
                    continue;
                }
                targetIds.push(targetLayer.id);
            }

            if (targetIds.length === 0) {
                return { data: [], count: 0, error: 'No valid target layers found.' };
            }

            const affected = await this.#db.contextBitmapCollection.mergeBitmap(sourceLayer.id, targetIds);
            this.emit('tree.layer.merged', {
                source: sourceLayer.name,
                targets: targetNames,
                affected
            });
            return { data: affected, count: affected.length, error: null };
        } catch (error) {
            debug(`Error merging layer "${layerId}": ${error.message}`);
            return { data: null, count: 0, error: error.message };
        }
    }

    async subtractLayer(layerId, layerArray) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        try {
            const sourceLayer = this.getLayer(layerId) || this.getLayerById(layerId);
            if (!sourceLayer) {
                return { data: null, count: 0, error: `Source layer "${layerId}" not found.` };
            }

            const targetLayers = Array.isArray(layerArray) ? layerArray : [layerArray];
            const targetIds = [];

            for (const targetId of targetLayers) {
                const targetLayer = this.getLayer(targetId) || this.getLayerById(targetId);
                if (!targetLayer) {
                    debug(`Target layer "${targetId}" not found, skipping.`);
                    continue;
                }
                targetIds.push(targetLayer.id);
            }

            if (targetIds.length === 0) {
                return { data: [], count: 0, error: 'No valid target layers found.' };
            }

            const affected = await this.#db.contextBitmapCollection.subtractBitmap(sourceLayer.id, targetIds);
            this.emit('tree.layer.subtracted', {
                source: sourceLayer.name,
                targets: targetNames,
                affected
            });
            return { data: affected, count: affected.length, error: null };
        } catch (error) {
            debug(`Error subtracting layer "${layerId}": ${error.message}`);
            return { data: null, count: 0, error: error.message };
        }
    }

    /**
     * ============================================================================
     * Path methods
     * ============================================================================
     */

    async insertPath(path = '/', nodeOrOptions, autoCreateLayers = true, insertOptions = {}) {
        // Back-compat overload:
        // - insertPath(path)
        // - insertPath(path, node)
        // - insertPath(path, node, autoCreateLayers)
        // - insertPath(path, { leafType: 'canvas' })
        // - insertPath(path, node, autoCreateLayers, { leafType: 'canvas' })
        let node = nodeOrOptions;
        if (nodeOrOptions && typeof nodeOrOptions === 'object' && !(nodeOrOptions instanceof TreeNode)) {
            insertOptions = nodeOrOptions;
            node = null;
        }

        const leafType = insertOptions?.leafType || 'context';
        const normalizedPath = this.#normalizePath(path);
        debug(`Inserting normalized path "${normalizedPath}" (original: "${path}") into the context tree`);

        try {
            if (normalizedPath === '/' && !node) {
                return {
                    data: [this.rootLayer.id],
                    count: 1,
                    error: null,
                };
            }

            if (this.pathExists(normalizedPath)) {
                debug(`Normalized path "${normalizedPath}" already exists, skipping`);
                return {
                    data: this.pathToLayerIds(normalizedPath),
                    count: this.pathToLayerIds(normalizedPath).length,
                    error: null,
                };
            }

            let currentNode = this.root;
            let child;
            const layerIds = [];
            const createdLayers = [];

            const layerNames = normalizedPath.split('/').filter(Boolean);
            for (const layerName of layerNames) {
                let layer = this.#layerIndex.getLayerByName(layerName);
                if (!layer) {
                    debug(`Layer "${layerName}" not found in layerIndex`);
                    if (autoCreateLayers) {
                        const isLeaf = layerName === layerNames[layerNames.length - 1];
                        const desiredType = isLeaf ? leafType : 'context';
                        debug(`Creating layer "${layerName}"`);
                        layer = await this.#layerIndex.createLayer(layerName, { type: desiredType });
                        createdLayers.push(layer);
                    } else {
                        return {
                            data: [],
                            count: 0,
                            error: `Layer "${layerName}" not found at path "${normalizedPath}" and autoCreateLayers is disabled`,
                        };
                    }
                }
                // If the leaf already exists but the caller requested a different leafType,
                // we allow a safe "upgrade" from context->canvas (Canvas currently adds no behavior).
                const isLeaf = layerName === layerNames[layerNames.length - 1];
                if (isLeaf && leafType && layer.type !== leafType) {
                    if (layer.type === 'context' && leafType === 'canvas') {
                        debug(`Upgrading leaf layer "${layer.name}" from type "${layer.type}" to "${leafType}"`);
                        layer.type = leafType;
                        await this.#layerIndex.persistLayer(layer);
                    } else {
                        return {
                            data: [],
                            count: 0,
                            error: `Leaf layer "${layerName}" exists with type "${layer.type}", cannot use as type "${leafType}"`,
                        };
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
                currentNode.addChild(node);
                debug(`Attached provided node ${node.id} (${node.payload.name}) to path "${normalizedPath}"`);
            }

            await this.#saveTreeToDataStore();
            debug(`Path "${normalizedPath}" inserted successfully.`);

            this.emit('tree.path.inserted', {
                path: normalizedPath,
                layerIds,
                createdLayers: createdLayers.map(layer => ({
                    id: layer.id,
                    name: layer.name,
                    type: layer.type,
                })),
            });

            return {
                data: layerIds,
                count: layerIds.length,
                error: null,
            };
        } catch (error) {
            debug(`Error inserting path "${normalizedPath}": ${error.message}`);
            return {
                data: [],
                count: 0,
                error: error.message,
            };
        }
    }

    async movePath(pathFrom, pathTo, recursive = false) {
        const normalizedPathFrom = this.#normalizePath(pathFrom);
        const normalizedPathTo = this.#normalizePath(pathTo);
        debug(`Moving normalized path "${normalizedPathFrom}" under "${normalizedPathTo}"${recursive ? ' recursively' : ''}`);

        try {
            let sourceNodes, destNodes, nodeToMove, sourceParentNode, destNode;

            try {
                sourceNodes = this.#getNodesForPath(normalizedPathFrom);
                if (sourceNodes.length < 2) {
                    throw new Error('Cannot move the root path itself.');
                }
                nodeToMove = sourceNodes[sourceNodes.length - 1];
                sourceParentNode = sourceNodes[sourceNodes.length - 2];

                destNodes = this.#getNodesForPath(normalizedPathTo);
                destNode = destNodes[destNodes.length - 1];

            } catch (error) {
                return {
                    data: null,
                    count: 0,
                    error: `Move failed: ${error.message}`,
                };
            }

            const layer = nodeToMove.payload;

            // Precondition: Cannot move a locked layer
            if (layer.isLocked) {
                return {
                    data: null,
                    count: 0,
                    error: `Cannot move path "${normalizedPathFrom}": Layer "${layer.name}" (ID: ${layer.id}) is locked.`,
                };
            }

            // Check if destination already contains the node. If so, skip adding, but still remove from source.
            const alreadyExistsAtDest = destNode.hasChild(nodeToMove.id);
            if (alreadyExistsAtDest) {
                debug(`Node ${nodeToMove.id} (${layer.name}) already exists under destination ${destNode.id}. Skipping add step.`);
            } else {
                // Perform the attachment
                debug(`Attaching node ${nodeToMove.id} to ${destNode.id}`);
                destNode.addChild(nodeToMove);
            }

            // Always remove from the original parent
            debug(`Removing node ${nodeToMove.id} from ${sourceParentNode.id}`);
            sourceParentNode.removeChild(nodeToMove.id);

            await this.#saveTreeToDataStore();

            // Emit event
            this.emit('tree.path.moved', {
                pathFrom: normalizedPathFrom,
                pathTo: normalizedPathTo,
                recursive,
                layerId: layer.id,
                layerName: layer.name,
                layerType: layer.type,
                timestamp: new Date().toISOString(),
            });

            debug(`Path "${normalizedPathFrom}" successfully moved under "${normalizedPathTo}".`);
            return {
                data: {
                    pathFrom: normalizedPathFrom,
                    pathTo: normalizedPathTo,
                    layerId: layer.id,
                    layerName: layer.name,
                },
                count: 1,
                error: null,
            };
        } catch (error) {
            debug(`Error moving path "${normalizedPathFrom}" to "${normalizedPathTo}": ${error.message}`);
            return {
                data: null,
                count: 0,
                error: error.message,
            };
        }
    }

    async copyPath(pathFrom, pathTo, recursive = false) {
        const normalizedPathFrom = this.#normalizePath(pathFrom);
        const normalizedPathTo = this.#normalizePath(pathTo);
        debug(`Copying normalized path "${normalizedPathFrom}" under "${normalizedPathTo}"${recursive ? ' recursively' : ''}`);

        let sourceNode, destParentNode;

        try {
            const sourceNodes = this.#getNodesForPath(normalizedPathFrom);
            if (sourceNodes.length < 1) {throw new Error('Source path does not resolve to any nodes.');} // Should not happen if root exists
            sourceNode = sourceNodes[sourceNodes.length - 1];

            // Get the destination parent node
            const destParentNodes = this.#getNodesForPath(normalizedPathTo);
            if (destParentNodes.length < 1) {throw new Error('Destination path does not resolve to any nodes.');}
            destParentNode = destParentNodes[destParentNodes.length - 1];

        } catch (error) {
            debug(`Copy operation failed during path resolution: ${error.message}`);
            // Re-throw or return false
            throw new Error(`Copy failed: ${error.message}`);
            // return false;
        }

        if (!sourceNode || !destParentNode) {
            debug('Copy failed: Source or destination node not found after resolution.');
            return false; // Or throw
        }

        const layer = sourceNode.payload;

        // Create a new TreeNode instance for the copy
        // It shares the layer payload but is a distinct node in the tree structure
        const targetNode = new TreeNode(layer.id, layer);

        // Add the new node under the destination parent
        if (!destParentNode.hasChild(targetNode.id)) {
            destParentNode.addChild(targetNode);
            debug(`Added node ${targetNode.id} (${layer.name}) under ${destParentNode.id} (${destParentNode.payload?.name || 'root'})`);
        } else {
            debug(`Node ${targetNode.id} (${layer.name}) already exists under destination ${destParentNode.id}. Skipping add.`);
            // If needed for recursion, update targetNode to the existing instance
            // targetNode = destParentNode.getChild(targetNode.id);
        }

        // --- Recursive Call Logic ---
        if (recursive && sourceNode.hasChildren) {
            // Construct the full path where the node was copied TO (for the next level's destination)
            const fullCopiedPath = normalizedPathTo === '/' ? `/${layer.name}` : `${normalizedPathTo}/${layer.name}`;

            for (const child of sourceNode.children.values()) {
                const childLayer = child.payload;
                if (!childLayer || !childLayer.name) {
                    debug(`Skipping copy of child with invalid payload under ${sourceNode.id}`);
                    continue;
                }
                // Construct the source path for the child
                const childName = childLayer.name; // Already normalized
                const sourceChildPath = normalizedPathFrom === '/' ? `/${childName}` : `${normalizedPathFrom}/${childName}`;

                // Recursive call - await ensures sequential processing if needed
                try {
                    await this.copyPath(sourceChildPath, fullCopiedPath, true);
                } catch(error) {
                    debug(`Recursive copy failed for child ${sourceChildPath} to ${fullCopiedPath}: ${error.message}`);
                    // Decide whether to continue copying siblings or stop
                    // For now, let's log and continue
                }
            }
        }

        // Save the tree state AFTER the top-level call and all its recursion completes
        // Note: This means saves only happen at the end of the initial call, not after each recursive step.
        await this.#saveTreeToDataStore();

        // Emit an event with the normalized source and destination paths
        this.emit('tree.path.copied', {
            pathFrom: normalizedPathFrom,
            pathTo: normalizedPathTo,
            recursive,
            layerId: layer.id,
            layerName: layer.name,
            layerType: layer.type,
            timestamp: new Date().toISOString(),
        });

        debug(`Path "${normalizedPathFrom}" successfully copied under "${normalizedPathTo}".`);
        return true;
    }

    async removePath(path, recursive = false) {
        const normalizedPath = this.#normalizePath(path);
        debug(`Removing normalized path "${normalizedPath}"${recursive ? ' recursively' : ''}`);

        try {
            let nodeToRemove, parentNode;
            try {
                const nodesToRemove = this.#getNodesForPath(normalizedPath);
                nodeToRemove = nodesToRemove[nodesToRemove.length - 1];

                // Get parent using the normalized path
                const parentPath = this.#getParentPath(normalizedPath);
                const parentNodes = this.#getNodesForPath(parentPath);
                parentNode = parentNodes[parentNodes.length - 1];
            } catch (error) {
                return {
                    data: null,
                    count: 0,
                    error: `Unable to remove path, error resolving path or parent path: ${error.message}`,
                };
            }

            if (!nodeToRemove || !parentNode) {
                return {
                    data: null,
                    count: 0,
                    error: `Unable to remove path, node or parent node not found after resolution: "${normalizedPath}"`,
                };
            }

            const layer = nodeToRemove.payload;
            const childrenCount = nodeToRemove.children.size;

            // If non-recursive and node has children, move them to parent
            if (!recursive && nodeToRemove.hasChildren) {
                for (const child of nodeToRemove.children.values()) {
                    parentNode.addChild(child);
                }
            }

            parentNode.removeChild(nodeToRemove.id);
            await this.#saveTreeToDataStore();

            // Emit an event with path and removal details
            this.emit('tree.path.removed', {
                path: normalizedPath,
                recursive,
                layerId: layer.id,
                layerName: layer.name,
                layerType: layer.type,
                hadChildren: childrenCount > 0,
                childrenCount,
            });

            return {
                data: {
                    path: normalizedPath,
                    layerId: layer.id,
                    layerName: layer.name,
                    hadChildren: childrenCount > 0,
                    childrenCount,
                },
                count: 1,
                error: null,
            };
        } catch (error) {
            debug(`Error removing path "${normalizedPath}": ${error.message}`);
            return {
                data: null,
                count: 0,
                error: error.message,
            };
        }
    }

    async lockPath(path, lockBy) {
        const normalizedPath = this.#normalizePath(path);
        if (!lockBy) {
            return {
                data: null,
                count: 0,
                error: 'Locking path requires a lockBy context',
            };
        }
        debug(`Locking normalized path "${normalizedPath}" by context "${lockBy}"`);

        try {
            const nodes = this.#getNodesForPath(normalizedPath);
            let changed = false;
            const lockedLayerIds = [];

            // Operate only on nodes representing actual path segments (skip root at index 0)
            for (const node of nodes.slice(1)) {
                const layer = node.payload;
                // --- DEBUG LOGGING ---
                debug(`Checking layer ${layer.id} (${layer.name}). LockedBy: ${JSON.stringify(layer.lockedBy)}. Checking for context: ${lockBy}`);
                // --- END DEBUG ---
                if (!layer.isLockedBy(lockBy)) { // Check if NOT already locked by this context
                    debug(`--> Layer ${layer.id} (${layer.name}) NOT locked by ${lockBy}. Locking now.`);
                    layer.lock(lockBy);
                    await this.#layerIndex.persistLayer(layer);
                    changed = true; // <-- Set to true only if a change was made
                    lockedLayerIds.push(layer.id);
                    debug(`Layer ${layer.id} (${layer.name}) locked by ${lockBy}`);
                } else {
                    debug(`--> Layer ${layer.id} (${layer.name}) IS ALREADY locked by ${lockBy}. Skipping.`);
                }
            }

            if (changed) { // <-- Event emitted only if changed === true
                this.emit('tree.path.locked', { path: normalizedPath, lockBy, timestamp: new Date().toISOString() });
            }

            return {
                data: {
                    path: normalizedPath,
                    lockBy,
                    layerIds: lockedLayerIds,
                },
                count: lockedLayerIds.length,
                error: null,
            };
        } catch (error) {
            debug(`Error locking path "${normalizedPath}": ${error.message}`);
            return {
                data: null,
                count: 0,
                error: error.message,
            };
        }
    }

    async unlockPath(path, lockBy) {
        const normalizedPath = this.#normalizePath(path);
        if (!lockBy) {
            return {
                data: null,
                count: 0,
                error: 'Unlocking path requires a lockBy context',
            };
        }
        debug(`Unlocking normalized path "${normalizedPath}" by context "${lockBy}"`);

        try {
            const nodes = this.#getNodesForPath(normalizedPath); // Use normalized
            const stillLockedIds = [];
            const unlockedLayerIds = [];
            let changed = false;

            // Operate only on nodes representing actual path segments (skip root at index 0)
            for (const node of nodes.slice(1)) {
                const layer = node.payload;
                if (layer.isLockedBy(lockBy)) {
                    layer.unlock(lockBy); // Returns true if still locked by others, false if now fully unlocked
                    await this.#layerIndex.persistLayer(layer);
                    changed = true;
                    unlockedLayerIds.push(layer.id);
                    debug(`Layer ${layer.id} (${layer.name}) unlocked by ${lockBy}`);
                }
                // Check the final state after unlock
                if (layer.isLocked) {
                    stillLockedIds.push(layer.id);
                }
            }

            if (changed) {
                this.emit('tree.path.unlocked', { path: normalizedPath, lockBy, stillLockedIds, timestamp: new Date().toISOString() });
            }

            return {
                data: {
                    path: normalizedPath,
                    lockBy,
                    unlockedLayerIds,
                    stillLockedIds,
                },
                count: unlockedLayerIds.length,
                error: null,
            };
        } catch (error) {
            debug(`Error unlocking path "${normalizedPath}": ${error.message}`);
            return {
                data: null,
                count: 0,
                error: error.message,
            };
        }
    }

    /**
     * ============================================================================
     * Document methods
     * ============================================================================
     */

    async insertDocument(document, contextSpec = '/', featureBitmapArray = []) {
        const normalizedContextSpec = this.#normalizePath(contextSpec);
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        // Await the async DB call
        const resultId = await this.#db.insertDocument(document, normalizedContextSpec, featureBitmapArray);
        // Assuming insertDocument returns the generated ID
        if (resultId) {
            // Use the returned ID for the event
            const layerNames = this.#pathToLayerNames(normalizedContextSpec);
            this.emit('tree.document.inserted', {
                documentId: resultId,
                contextSpec: normalizedContextSpec,
                layerNames,
                timestamp: new Date().toISOString(),
            });
        }
        return resultId; // Return the generated ID
    }

    async insertDocumentArray(docArray, contextSpec = '/', featureBitmapArray = []) {
        const normalizedContextSpec = this.#normalizePath(contextSpec);
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        // Await the async DB call
        const results = await this.#db.insertDocumentArray(docArray, normalizedContextSpec, featureBitmapArray);
        // Assuming insertDocumentArray returns generated IDs or success status
        if (results) { // Adjust condition based on actual return
            // Need to know what `results` contains to get IDs accurately
            // Assuming results might be an array of IDs corresponding to docArray
            const documentIds = Array.isArray(results) ? results : docArray.map((doc, index) => results[index] || doc.id); // Placeholder logic
            const layerNames = this.#pathToLayerNames(normalizedContextSpec);
            this.emit('tree.document.inserted.batch', {
                documentIds,
                contextSpec: normalizedContextSpec,
                layerNames,
                timestamp: new Date().toISOString(),
            });
        }
        return results;
    }

    async updateDocument(document, contextSpec = null, featureBitmapArray = []) {
        const normalizedContextSpec = this.#normalizePath(contextSpec);
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        const result = await this.#db.updateDocument(document, normalizedContextSpec, featureBitmapArray);
        if (result && document.id) { // Check document.id as it MUST be provided for update
            const layerNames = this.#pathToLayerNames(normalizedContextSpec);
            this.emit('tree.document.updated', {
                documentId: document.id, // Use the ID passed in
                contextSpec: normalizedContextSpec,
                layerNames,
                timestamp: new Date().toISOString(),
            });
        }
        return result;
    }

    async updateDocumentArray(docArray, contextSpec = null, featureBitmapArray = []) {
        const normalizedContextSpec = this.#normalizePath(contextSpec);
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        // Await the async DB call
        const results = await this.#db.updateDocumentArray(docArray, normalizedContextSpec, featureBitmapArray);
        if (results) { // Adjust condition
            const documentIds = docArray.map(doc => doc.id); // IDs must be in input array
            const layerNames = this.#pathToLayerNames(normalizedContextSpec);
            this.emit('tree.document.updated.batch', {
                documentIds,
                contextSpec: normalizedContextSpec,
                layerNames,
                timestamp: new Date().toISOString(),
            });
        }
        return results;
    }

    async removeDocument(documentId, contextSpec = null, featureBitmapArray = []) {
        const normalizedContextSpec = this.#normalizePath(contextSpec);
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        // Await the async DB call
        const result = await this.#db.removeDocument(documentId, normalizedContextSpec, featureBitmapArray);

        if (result) {
            const layerNames = this.#pathToLayerNames(normalizedContextSpec);
            this.emit('tree.document.removed', {
                documentId, // Use the ID passed in
                contextSpec: normalizedContextSpec,
                layerNames,
                timestamp: new Date().toISOString(),
            });
        }

        // Return the result from the underlying DB method.
        return result;
    }

    async removeDocumentArray(docIdArray, contextSpec = null, featureBitmapArray = []) {
        const normalizedContextSpec = this.#normalizePath(contextSpec);
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        // Await the async DB call
        const results = await this.#db.removeDocumentArray(docIdArray, normalizedContextSpec, featureBitmapArray);
        if (results) { // Adjust condition
            const layerNames = this.#pathToLayerNames(normalizedContextSpec);
            this.emit('tree.document.removed.batch', {
                documentIds: docIdArray, // Use the IDs passed in
                contextSpec: normalizedContextSpec,
                layerNames,
                timestamp: new Date().toISOString(),
            });
        }
        return results;
    }

    async deleteDocument(documentId) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        // Await the async DB call
        const result = await this.#db.deleteDocument(documentId);
        if (result) { // Adjust condition
            this.emit('tree.document.deleted', {
                documentId, // Use the ID passed in
                timestamp: new Date().toISOString(),
            });
        }
        return result;
    }

    async deleteDocumentArray(docIdArray) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        // Await the async DB call
        const results = await this.#db.deleteDocumentArray(docIdArray);
        if (results) { // Adjust condition
            this.emit('tree.document.deleted.batch', {
                documentIds: docIdArray, // Use the IDs passed in
                timestamp: new Date().toISOString(),
            });
        }
        return results;
    }

    /**
     * ============================================================================
     * Find / Query methods
     * ============================================================================
     */

    async query(queryString, contextSpec = null, featureBitmapArray = [], filterArray = [], options = { parse: true }) {
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return await this.#db.query(queryString , contextSpec, featureBitmapArray, filterArray, options);
    }

    async findDocuments(contextSpec = null, featureBitmapArray = [], filterArray = [], options = { parse: true }) {
        const normalizedContextSpec = this.#normalizePath(contextSpec);
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        // findDocuments doesn't modify, typically no event needed unless logging access
        return await this.#db.findDocuments(normalizedContextSpec, featureBitmapArray, filterArray, options);
    }

    hasDocument(id, contextSpec = '/', featureBitmapArray = []) {
        const normalizedContextSpec = this.#normalizePath(contextSpec);
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.hasDocument(id, normalizedContextSpec, featureBitmapArray);
    }

    hasDocumentByChecksum(checksum, contextSpec = null, featureBitmapArray = []) {
        const normalizedContextSpec = this.#normalizePath(contextSpec);
        if (!this.#db) { throw new Error('Database instance not passed to ContextTree, functionality not available'); }
        return this.#db.hasDocumentByChecksum(checksum, normalizedContextSpec, featureBitmapArray);
    }

    /**
     * ============================================================================
     * Utils and Private Methods
     * ============================================================================
     */

    /**
     * Merge a layer with layers above it (uses mergeLayer internally)
     */
    async mergeUp(path) {
        const normalizedPath = this.#normalizePath(path);
        debug(`mergeUp: ${normalizedPath}`);
        try {
            const nodes = this.#getNodesForPath(normalizedPath);
            if (!nodes || nodes.length < 2) {
                return { data: null, count: 0, error: `Unable to merge layer up, node not found at path "${normalizedPath}".` };
            }

            const layerNames = nodes.slice(1).map(n => n.payload.name);
            if (layerNames.length < 2) { return { data: [], count: 0, error: null }; }

            const source = layerNames[layerNames.length - 1];
            const targets = layerNames.slice(0, layerNames.length - 1);

            const result = await this.mergeLayer(source, targets);
            if (result.error) { return result; }

            this.emit('tree.layer.merged.up', { path: normalizedPath, source, targets, affected: result.data });
            return result;
        } catch (error) {
            debug(`Error merging layer up at path "${normalizedPath}": ${error.message}`);
            return { data: null, count: 0, error: error.message };
        }
    }

    /**
     * Merge ancestors down to current layer (uses mergeLayer internally)
     */
    async mergeDown(path) {
        const normalizedPath = this.#normalizePath(path);
        debug(`mergeDown: ${normalizedPath}`);
        try {
            const nodes = this.#getNodesForPath(normalizedPath);
            if (!nodes || nodes.length < 2) {
                return { data: null, count: 0, error: `Unable to merge layer down, node not found at path "${normalizedPath}".` };
            }

            const layerNames = nodes.slice(1).map(n => n.payload.name);
            if (layerNames.length < 2) { return { data: [], count: 0, error: null }; }

            const target = layerNames[layerNames.length - 1];
            const sources = layerNames.slice(0, layerNames.length - 1);

            const affected = [];
            for (const source of sources) {
                const result = await this.mergeLayer(source, [target]);
                if (!result.error && result.data) {
                    affected.push(...result.data);
                }
            }

            this.emit('tree.layer.merged.down', { path: normalizedPath, target, sources, affected });
            return { data: affected, count: affected.length, error: null };
        } catch (error) {
            debug(`Error merging layer down at path "${normalizedPath}": ${error.message}`);
            return { data: null, count: 0, error: error.message };
        }
    }

    /**
     * Subtract current layer bitmap from its ancestors (uses subtractLayer internally)
     */
    async subtractUp(path) {
        const normalizedPath = this.#normalizePath(path);
        debug(`subtractUp: ${normalizedPath}`);
        try {
            const nodes = this.#getNodesForPath(normalizedPath);
            if (!nodes || nodes.length < 2) {
                return { data: null, count: 0, error: `Unable to subtract layer up, node not found at path "${normalizedPath}".` };
            }

            const layerNames = nodes.slice(1).map(n => n.payload.name);
            if (layerNames.length < 2) { return { data: [], count: 0, error: null }; }

            const source = layerNames[layerNames.length - 1];
            const targets = layerNames.slice(0, layerNames.length - 1);

            const result = await this.subtractLayer(source, targets);
            if (result.error) { return result; }

            this.emit('tree.layer.subtracted.up', { path: normalizedPath, source, targets, affected: result.data });
            return result;
        } catch (error) {
            debug(`Error subtracting layer up at path "${normalizedPath}": ${error.message}`);
            return { data: null, count: 0, error: error.message };
        }
    }

    /**
     * Subtract ancestors from current layer (uses subtractLayer internally)
     */
    async subtractDown(path) {
        const normalizedPath = this.#normalizePath(path);
        debug(`subtractDown: ${normalizedPath}`);
        try {
            const nodes = this.#getNodesForPath(normalizedPath);
            if (!nodes || nodes.length < 2) {
                return { data: null, count: 0, error: `Unable to subtract layer down, node not found at path "${normalizedPath}".` };
            }

            const layerNames = nodes.slice(1).map(n => n.payload.name);
            if (layerNames.length < 2) { return { data: [], count: 0, error: null }; }

            const target = layerNames[layerNames.length - 1];
            const sources = layerNames.slice(0, layerNames.length - 1);

            const affected = [];
            for (const source of sources) {
                const result = await this.subtractLayer(source, [target]);
                if (!result.error && result.data) {
                    affected.push(...result.data);
                }
            }

            this.emit('tree.layer.subtracted.down', { path: normalizedPath, target, sources, affected });
            return { data: affected, count: affected.length, error: null };
        } catch (error) {
            debug(`Error subtracting layer down at path "${normalizedPath}": ${error.message}`);
            return { data: null, count: 0, error: error.message };
        }
    }

    pathExists(path) {
        const normalizedPath = this.#normalizePath(path);
        try {
            this.#getNodesForPath(normalizedPath);
            return true;
        } catch (error) {
            // #getNodesForPath throws if path is invalid or doesn't exist
            debug(`Path existence check failed for normalized path "${normalizedPath}": ${error.message}`);
            return false;
        }
    }

    pathToLayerIds(path) {
        const normalizedPath = this.#normalizePath(path);
        try {
            const nodes = this.#getNodesForPath(normalizedPath);
            // Exclude the root node's ID unless the path is exactly "/"
            return nodes.slice(1).map(node => node.id); // node.id is the layer ID
        } catch (error) {
            debug(`Failed to convert normalized path "${normalizedPath}" to layer IDs: ${error.message}`);
            return []; // Return empty array if path is invalid
        }
    }

    /**
     * Resolve an array of layer names to their ULID-based IDs.
     * Used by SynapsD to key bitmaps by ULID instead of name.
     * @param {Array<string>} layerNames - Array of layer names
     * @returns {Array<string>} Array of layer IDs (skips '/' root and unresolvable names)
     */
    resolveLayerIds(layerNames) {
        const ids = [];
        for (const name of layerNames) {
            if (name === '/') { continue; } // Skip root for bitmap operations
            const layer = this.#layerIndex.getLayerByName(name);
            if (layer) { ids.push(layer.id); }
        }
        return ids;
    }

    buildJsonTree(node = this.root) {
        const buildTree = (currentNode) => {
            const children = currentNode.getSortedChildren()
                .filter((child) => child instanceof TreeNode)
                .map((child) => (child.hasChildren ? buildTree(child) : createLayerInfo(child.payload)));

            let layer = this.#layerIndex.getLayerByID(currentNode.id);
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
                children,
            };
        };

        return buildTree(node);
    }

    async recalculateTree() {
        debug('Recalculating tree after layer changes');
        // Create a copy of the current tree without deleted layers
        const newRoot = new TreeNode(this.rootLayer.id, this.rootLayer);

        const rebuildTree = (oldNode, newParent) => {
            for (const child of oldNode.getSortedChildren()) {
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
        await this.#saveTreeToDataStore();

        // Emit a recalculation event
        this.emit('tree.recalculated', {
            timestamp: new Date().toISOString(),
        });
    }

    #getParentPath(path) {
        // This should operate on an already normalized path
        const normalizedPath = this.#normalizePath(path); // Ensure it's normalized
        return normalizedPath.split('/').slice(0, -1).join('/') || '/';
    }

    #buildPathArray(sort = true) {
        const paths = [];
        // Traversal uses node.payload.name which is assumed to be normalized (by LayerIndex/BaseLayer)
        const traverseTree = (node, parentPath) => {
            // Construct path segments using the (already normalized) layer name
            const currentSegment = node.payload.name;
            const path = !parentPath || parentPath === '/' ? `/${currentSegment}` : `${parentPath}/${currentSegment}`;

            // Handle root case where name is '/'
            const displayPath = (path === '//' || path === '/') ? '/' : path;

            if (node.children.size > 0) {
                paths.push(displayPath); // Add intermediate paths too
            for (const child of node.getSortedChildren()) {
                traverseTree(child, displayPath); // Pass the constructed path
            }
            } else {
                paths.push(displayPath); // Add leaf paths
            }
        };
        // Start traversal from root node, parent path is initially empty
        traverseTree(this.root, '');
        // Remove potential duplicates and the root path if added separately by logic
        const uniquePaths = [...new Set(paths)].filter(p => p !== '/');
        // Add root path explicitly
        uniquePaths.unshift('/');

        return uniquePaths; // Already sorted during tree traversal
    }

    #buildTreeFromJson(rootNodeData) {
        if (!rootNodeData || !rootNodeData.id || rootNodeData.name === undefined) {
            debug('Invalid or missing root node data for buildTreeFromJson.');
            return null;
        }

        const buildNodeRecursive = (nodeData) => {
            if (!nodeData || !nodeData.id || nodeData.name === undefined) {
                debug('Skipping invalid node data during tree build:', nodeData);
                return null;
            }

            // Stored JSON uses display names; compare using normalized form.
            const storedName = nodeData.name;
            let layer = this.#layerIndex.getLayerByName(storedName);

            if (!layer) {
                // This case implies inconsistency between stored tree and LayerIndex init
                console.warn(`Layer '${normalizedName}' (ID: ${nodeData.id}) not found in LayerIndex map during tree build. Attempting direct fetch/reconstruction.`);
                layer = this.#layerIndex.getLayerByID(nodeData.id); // Fetches and reconstructs
                if (!layer) {
                    // If still not found, something is wrong. Skip this node.
                    console.error(`Failed to find or reconstruct layer '${normalizedName}' (ID: ${nodeData.id}) during tree build. Skipping node.`);
                    return null;
                    // Alternatively, throw new Error(`...`);
                }
                // If reconstructed, ensure its name matches what we expected
                if (this.#layerIndex.normalizeLayerName(layer.name) !== this.#layerIndex.normalizeLayerName(storedName)) {
                    console.error(`Name mismatch after direct fetch for layer ID ${layer.id}: Expected '${storedName}', got '${layer.name}'. Skipping node.`);
                    return null;
                }

            } else {
                // Verify the ID from the map instance matches the stored tree data
                if (layer.id !== nodeData.id) {
                    console.error(`ID mismatch for layer '${storedName}': Map has ${layer.id}, JSON has ${nodeData.id}. Using instance from map.`);
                    // Continue, trusting the instance from the map
                }
            }

            // Create TreeNode using the definitive Layer instance
            const treeNode = new TreeNode(layer.id, layer);

            // Recursively build children
            if (nodeData.children && Array.isArray(nodeData.children)) {
                for (const childData of nodeData.children) {
                    const childNode = buildNodeRecursive(childData);
                    if (childNode) { // Only add if child was successfully built
                        treeNode.addChild(childNode);
                    }
                }
            }
            return treeNode;
        };

        // Start building from the root data
        return buildNodeRecursive(rootNodeData);
    }

    async #saveTreeToDataStore() {
        debug('Saving in-memory context tree to database');
        const data = this.buildJsonTree();
        try {
            await this.#dataStore.put('tree', data);
            debug('Tree saved successfully.');

            // Emit a save event
            this.emit('tree.saved', {
                timestamp: new Date().toISOString(),
            });

            return true;
        } catch (error) {
            debug(`Error saving tree to database: ${error.message}`);

            // Emit an error event
            this.emit('tree.error', {
                operation: 'save',
                error: error.message,
            });

            throw error;
        }
    }

    #loadTreeFromDataStore() {
        debug('Loading tree from the data store...');
        const jsonTreeData = this.#dataStore.get('tree');
        if (!jsonTreeData) {
            debug('No persistent Tree data found in the data store, using default initial tree.');
            // Ensure this.root is the default initialized root (should be set earlier in initialize())
            if (!this.root || this.root.id !== this.rootLayer.id) {
                this.root = new TreeNode(this.rootLayer.id, this.rootLayer);
                debug('Initialized with default root node as persistent data was missing.');
            }
            return false; // Indicate load was skipped
        }

        debug('Found persistent Tree data in the data store, re-building tree...');
        const loadedRootNode = this.#buildTreeFromJson(jsonTreeData);

        if (!loadedRootNode) {
            debug('Failed to build tree from persistent data. Using default initial tree.');
            // Ensure this.root is the default initialized root
            if (!this.root || this.root.id !== this.rootLayer.id) {
                this.root = new TreeNode(this.rootLayer.id, this.rootLayer);
                debug('Initialized with default root node due to build failure.');
            }
            return false; // Indicate load failed
        }

        this.root = loadedRootNode; // Assign the successfully built tree

        // Emit a load event
        this.emit('tree.loaded', {
            timestamp: new Date().toISOString(),
        });

        return true;
    }

    #getNodesForPath(path) {
        if (path === '/' || !path) {
            return [this.root]; // Root path only has the root node
        }

        const layerNames = path.split('/').filter(Boolean);
        if (layerNames.length === 0 && path !== '/') {
            throw new Error(`Invalid path format: "${path}"`);
        }

        const nodes = [];
        let currentNode = this.root;
        nodes.push(currentNode); // Include root node

        for (const layerName of layerNames) {
            const layer = this.#layerIndex.getLayerByName(layerName); // LayerIndex normalizes name
            if (!layer) {
                throw new Error(`Layer "${layerName}" not found in index for path "${path}"`);
            }

            const child = currentNode.getChild(layer.id);
            if (!child) {
                // This case means the layer exists in the index but is not present at this specific path in the tree structure.
                throw new Error(`Path segment "${layerName}" (Layer ID: ${layer.id}) does not exist at this location in the tree: "${path}"`);
            }

            nodes.push(child);
            currentNode = child;
        }

        return nodes;
    }

    #pathToLayerNames(path) {
        if (!path || path === '/') {
            return [];
        }

        // Handle array input - process each path independently and flatten results
        if (Array.isArray(path)) {
            const allLayerNames = new Set();
            for (const p of path) {
                const layerNames = this.#pathToLayerNames(p);
                layerNames.forEach(name => allLayerNames.add(name));
            }
            return Array.from(allLayerNames);
        }

        try {
            const nodes = this.#getNodesForPath(path);
            // Skip the root node (index 0) and map others to payload.name
            return nodes.slice(1).map(node => node.payload.name);
        } catch (error) {
            // If path doesn't resolve in the *current* tree, return empty or log?
            // This might happen if contextSpec refers to layers not yet in the tree structure,
            // even if valid for the DB operation itself.
            debug(`Could not resolve path "${path}" to layer names for event: ${error.message}`);
            return []; // Return empty array for safety
        }
    }

    #normalizePath(path) {
        if (path === null || path === undefined) {
            // Decide handling: return null, '/', or throw error? Returning '/' seems safest for contextSpec defaults.
            return '/';
        }

        // Handle array input - normalize each path independently
        if (Array.isArray(path)) {
            return path.map(p => this.#normalizePath(p));
        }

        let normalized = String(path).trim();
        if (!normalized) {
            return '/'; // Treat empty string as root
        }

        // Ensure it starts with a single slash if not already root
        if (normalized !== '/' && !normalized.startsWith('/')) {
            normalized = '/' + normalized;
        }
        // Remove trailing slash unless it's the root path
        if (normalized !== '/' && normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1);
        }

        // Collapse multiple slashes
        normalized = normalized.replace(/\/+/g, '/');

        // Split, process segments, rejoin
        const segments = normalized.split('/');
        const normalizedSegments = segments.map(segment => {
            if (segment === '') {return '';} // Keep empty segments from split('/')
            // Consumer apps may URL-encode paths; we accept both raw and encoded segments.
            try { segment = decodeURIComponent(segment); } catch (_) { /* ignore */ }

            // Keep UTF-8 + spaces; sanitize the same way layers do.
            return this.#layerIndex.sanitizeLayerName(segment);
        });

        // Rejoin, handling potential empty segments if original was just '/' or '//'
        normalized = normalizedSegments.join('/');
        if (normalized === '') {return '/';} // If all segments were removed or empty

        // Final check for root representation
        if (normalized === '/') {return '/';}
        // Ensure starting slash if lost during join/map (e.g., path was '/foo')
        if (!normalized.startsWith('/')) {normalized = '/' + normalized;}

        return normalized;
    }
}

export default ContextTree;
