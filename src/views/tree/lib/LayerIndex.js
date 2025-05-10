'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:context-tree:layer-index');

// Modules
import SchemaRegistry from '../../../schemas/SchemaRegistry.js';
const RootLayer = SchemaRegistry.getSchema('internal/layers/universe');

/**
 * Layer Index
 */
class LayerIndex extends EventEmitter {

    #store;
    #nameToLayerMap = new Map();
    #initialized = false;

    constructor(dataStore, options = {}) {
        super(options.eventEmitterOptions || {}); // EventEmitter

        if (!dataStore) { throw new Error('A LayerIndex dataStore reference required'); }
        this.#store = dataStore;
    }

    /**
     * Private utility to normalize layer names for consistent lookups and storage.
     * Currently uses lowercase.
     * @param {string} name - The layer name.
     * @returns {string} - The normalized layer name.
     */
    #normalizeLayerName(name) {
        // Return '/' as is, lowercase others
        return name === '/' ? name : String(name).toLowerCase();
    }

    async initializeIndex() {
        if (this.#initialized) { return; }
        debug(`Initializing layer index..`);

        // Initialize name to layer map (using LMBDs get() sync method)
        await this.#initNameToLayerMap();

        // Set initialized flag
        this.#initialized = true;

        // Initialize built-in layers
        await this.#initBuiltInLayers();

        debug(`Layer index initialized with ${this.#nameToLayerMap.size} layer(s)`);
        debug('Layer list:', await this.listLayers());

    }

    /**
     * Getters / Base methods
     */

    getLayerByID(id) {
        if (!id) { throw new Error('Layer ID is required'); }

        // Normalize the ID - ensure it has the "layer/" prefix
        const normalizedId = id.startsWith('layer/') ? id : `layer/${id}`;

        debug(`Getting layer ID ${normalizedId} from store..`);
        const layerData = this.#store.get(normalizedId);

        if (!layerData) {
            debug(`Layer data not found for ID ${normalizedId}`);
            return undefined; // Or null
        }

        // Reconstruct the Layer instance from the raw data
        try {
            // Determine the correct Layer class based on the stored type
            const layerType = layerData.type || 'context'; // Default to 'context' if type is missing?
            const schemaName = `internal/layers/${layerType}`;
            if (!SchemaRegistry.hasSchema(schemaName)) {
                 console.error(`Cannot reconstruct layer ID ${normalizedId}: No schema registered for type "${layerType}" (schema: ${schemaName}).`);
                 throw new Error(`Schema not found for layer type "${layerType}"`);
            }

            const LayerClass = SchemaRegistry.getSchema(schemaName);
            if (!LayerClass || typeof LayerClass.fromJSON !== 'function') {
                 console.error(`Cannot reconstruct layer ID ${normalizedId}: Schema ${schemaName} exists but is invalid or lacks a static fromJSON method.`);
                 throw new Error(`Invalid schema class for layer type "${layerType}"`);
            }

             return LayerClass.fromJSON(layerData); // Use static method from the correct class
        } catch (error) {
            debug(`Error reconstructing layer instance for ID ${normalizedId}: ${error.message}`);
            console.error(`Failed to reconstruct layer from data:`, layerData);
            // Throwing might be safer.
            throw new Error(`Failed to reconstruct layer instance for ID ${normalizedId}`);
            // return layerData; // Less safe
        }
    }

    getLayerByName(name) {
        if (!name) { throw new Error('Layer name is required'); }
        if (!this.#initialized) {
            throw new Error('Layer index not initialized');
        }
        const normalizedName = this.#normalizeLayerName(name);
        return this.#nameToLayerMap.get(normalizedName);
    }

    hasLayer(id) { return this.hasLayerID(id); }

    hasLayerID(id) {
        // Normalize the ID - ensure it has the "layer/" prefix
        const normalizedId = id.startsWith('layer/') ? id : `layer/${id}`;
        return this.#store.doesExist(normalizedId);
    }

    hasLayerName(name) {
        if (!this.#initialized) {
            throw new Error('Layer index not initialized');
        }
        const normalizedName = this.#normalizeLayerName(name);
        return this.#nameToLayerMap.has(normalizedName);
    }

    nameToID(name) {
        if (!this.#initialized) {
            throw new Error('Layer index not initialized');
        }

        const layer = this.getLayerByName(name);
        return layer.id;
    }

    idToName(id) {
        if (!this.#initialized) {
            throw new Error('Layer index not initialized');
        }

        const layer = this.getLayerByID(id);
        return layer.name;
    }

    isInternalLayerName(name) {
        // Consider normalizing name here if needed for comparison
        // const normalizedName = this.#normalizeLayerName(name);
        // const layer = this.getLayerByName(normalizedName); // Use normalized lookup
        return false //layer && builtInLayers.find((layer) => layer.name === normalizedName);
    }

    isInternalLayerID(id) {
        //const layer = this.getLayerByID(id);
        return false //layer && builtInLayers.find((layer) => layer.id === id);
    }

    /**
     * CRUD Ops
     */

    async listLayers() {
        // If prefix provided, use range query
        const results = [];
        const prefix = 'layer/'
        for await (const key of this.#store.getKeys({
            start: prefix,
            end: prefix + '\uffff',
        })) { results.push(key); }

        return results;
    }

    async createLayer(name, options = {
        type: 'context'
    }) {
        if (!this.#initialized) { throw new Error('Layer index not initialized'); }
        const normalizedName = this.#normalizeLayerName(name);
        debug(`Creating layer "${normalizedName}" (original: "${name}") with options ${JSON.stringify(options)}`);

        // Check if layer type is valid
        if (options.type && !SchemaRegistry.hasSchema(`internal/layers/${options.type}`)) {
            throw new Error(`Invalid layer type: ${options.type}`);
        }

        // Check if layer already exists using the original name (hasLayerName normalizes internally)
        if (this.hasLayerName(name)) {
            debug(`Layer "${normalizedName}" already exists, returning existing or updating..`);
            // If update is needed, use normalized name to fetch
            // return this.updateLayer(normalizedName, options);
            // For now, just return the existing layer if found
             return this.getLayerByName(name); // getLayerByName normalizes internally
        }

        const LayerSchema = SchemaRegistry.getSchema(`internal/layers/${options.type}`);
        // Pass the *normalized* name to the schema constructor
        const layer = new LayerSchema(normalizedName, options);
        if (!layer) { throw new Error(`Failed to create layer with options ${options}`); }

        await this.#dbStoreLayer(layer);
        return layer;
    }

    async updateLayer(name, options) {
        // Use normalized lookup
        const layer = this.getLayerByName(name); // Normalizes internally

        if (!layer) { throw new Error(`Layer not found: ${name}`); }
        if (layer.locked) {
            throw new Error('Layer is locked');
        }
        // Unset the id from options to avoid overwriting existing layers by accident
        delete options.id;

        Object.assign(layer, options);
        await this.#dbStoreLayer(layer);
        return layer;
    }

    async renameLayer(name, newName) {
        const normalizedName = this.#normalizeLayerName(name);
        const normalizedNewName = this.#normalizeLayerName(newName);

        const currentLayer = this.getLayerByName(normalizedName); // Use normalized lookup
        if (!currentLayer) {
            throw new Error(`Layer not found: ${name} (normalized: ${normalizedName})`);
        }

        if (currentLayer.locked) {
            throw new Error('Layer is locked');
        }

        if (this.getLayerByName(normalizedNewName)) { // Use normalized lookup
            throw new Error(`Unable to rename layer, layer name already exists: ${newName} (normalized: ${normalizedNewName})`);
        }

        // First lets insert the "new" layer to the db
        const newLayer = currentLayer;
        // Set the name using the normalized new name
        newLayer.setName(normalizedNewName);
        // Optionally set the label to the original newName if desired
        newLayer.setLabel(newName);
        try {
            await this.#dbStoreLayer(newLayer);
        } catch (error) {
            throw new Error(`Failed to store renamed layer into the database: ${newName}`);
        }

        // Now lets remove the old layer from the db using the old layer object
        try {
            await this.#dbRemoveLayer(currentLayer); // #dbRemoveLayer normalizes the name from layer object
        } catch (error) {
            throw new Error(`Failed to remove existing layer: ${newName}`);
        }

        return newLayer;
    }

    async removeLayer(layer) {
        if (layer.locked) { throw new Error('Layer is locked'); }
        await this.#dbRemoveLayer(layer); // Normalizes internally
    }

    async removeLayerByID(id) {
        const layer = this.getLayerByID(id);
        if (!layer) {
            throw new Error(`Layer not found with ID: ${id}`);
        }

        if (layer.locked) {
            throw new Error('Layer is locked');
        }

        await this.#dbRemoveLayer(layer);
    }

    async removeLayerByName(name) {
        const layer = this.getLayerByName(name); // Normalizes internally
        if (!layer) {
            // It's possible the layer doesn't exist, handle gracefully or re-throw
            debug(`Layer not found by name "${name}", cannot remove.`);
            return; // Or throw new Error(`Layer not found: ${name}`);
        }

        if (layer.locked) {
            throw new Error('Layer is locked');
        }

        await this.#dbRemoveLayer(layer);
    }

    /**
     * Persistence
     */

    async persistLayer(layer) {
        if (!layer || !layer.id || !layer.name) {
            throw new Error('Cannot persist invalid layer object.');
        }
        // We assume the layer object passed in is the source of truth.
        // Let #dbStoreLayer handle DB persistence and map update.
        // Note: #dbStoreLayer already normalizes the name before map update.
        await this.#dbStoreLayer(layer);
        debug(`Persisted layer ${layer.id} changes.`);
        return true;
    }

    /**
     * Private(internal) methods
     */

    #constructLayerKey(id) {
        return `layer/${id}`;
    }

    async #dbStoreLayer(layer, persistent = true) {
        if (!layer || !layer.name || !layer.id) {
            console.error('Invalid layer object passed to #dbStoreLayer:', layer);
            throw new Error('Cannot store invalid layer object.');
        }
        if (persistent) {
            await this.#store.put(this.#constructLayerKey(layer.id), layer);
        }
        const normalizedName = this.#normalizeLayerName(layer.name);
        this.#nameToLayerMap.set(normalizedName, layer);
        debug(`Stored layer ${layer.id} in DB and map with normalized name: ${normalizedName}`);
        return true;
    }

    async #dbRemoveLayer(layer) {
        if (!layer || !layer.name || !layer.id) {
            console.error('Invalid layer object passed to #dbRemoveLayer:', layer);
            throw new Error('Cannot remove invalid layer object.');
        }
        await this.#store.remove(this.#constructLayerKey(layer.id));
        const normalizedName = this.#normalizeLayerName(layer.name);
        this.#nameToLayerMap.delete(normalizedName);
        debug(`Removed layer ${layer.id} from DB and map using normalized name: ${normalizedName}`);
        return true;
    }

    async #initBuiltInLayers() {
        // Check if a root layer already exists in the index
        debug(`Initializing built-in layers..`);
        debug(`Checking for root layer..`);
        if (!this.hasLayerName('/')) {
            debug(`Root layer not found, creating..`);
            const rootLayer = new RootLayer();
            await this.#dbStoreLayer(rootLayer);
        }

        return true;

        /*for (const layer of builtInLayers) {
            // Skip the root layer if it already exists
            if (rootExists && layer.name === '/') {
                continue;
            }
            this.createLayer(layer);
        }*/
    }

    async #initNameToLayerMap() {
        this.#nameToLayerMap.clear(); // Ensure map is empty before initialization
        const layers = await this.listLayers();
        for (const layerId of layers) {
            try {
                debug(`Initializing layer ${layerId}`);
                const layer = await this.getLayerByID(layerId); // Make sure this returns a promise if async
                 if (layer && layer.name) {
                    const normalizedName = this.#normalizeLayerName(layer.name);
                    this.#nameToLayerMap.set(normalizedName, layer);
                    debug(`Added layer ${layerId} to map with normalized name: ${normalizedName}`);
                } else {
                     debug(`Skipping layer ${layerId} during map init: Invalid layer object retrieved.`);
                     console.warn(`Layer data for ID ${layerId} seems invalid or lacks a name.`);
                 }
            } catch (error) {
                console.error(`Error initializing layer ${layerId}:`, error);
                // Decide if we should continue or stop initialization
            }
        }
    }
}

export default LayerIndex;

