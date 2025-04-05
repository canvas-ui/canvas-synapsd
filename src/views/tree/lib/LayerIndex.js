'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import debugInstance from 'debug';
const debug = debugInstance('synapsd:context-tree:layer-index');

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
        debug(`Getting layer ID ${id} from store..`);
        return this.#store.get(id);
    }

    getLayerByName(name) {
        if (!this.#initialized) {
            throw new Error('Layer index not initialized');
        }

        return this.#nameToLayerMap.get(name);
    }

    hasLayer(id) { return this.hasLayerID(id); }

    hasLayerID(id) { return this.#store.doesExist(id); }

    hasLayerName(name) {
        if (!this.#initialized) {
            throw new Error('Layer index not initialized');
        }

        return this.#nameToLayerMap.has(name);
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
        //const layer = this.getLayerByName(name);
        return false //layer && builtInLayers.find((layer) => layer.name === name);
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
        debug(`Creating layer ${name} with options ${JSON.stringify(options)}`);

        // Check if layer type is valid
        if (options.type && !SchemaRegistry.hasSchema(`internal/layers/${options.type}`)) {
            throw new Error(`Invalid layer type: ${options.type}`);
        }

        // Check if layer already exists
        if (this.hasLayerName(options.name)) {
            //throw new Error(`Layer already exists: ${options.name}`);
            return this.updateLayer(options.name, options);
        }

        const LayerSchema = SchemaRegistry.getSchema(`internal/layers/${options.type}`);
        const layer = new LayerSchema(options);
        if (!layer) { throw new Error(`Failed to create layer with options ${options}`); }

        await this.#dbStoreLayer(layer);
        return layer;
    }

    async updateLayer(name, options) {
        const layer = this.getLayerByName(name);
        if (!layer) {
            return false;
        }
        if (layer.locked) {
            throw new Error('Layer is locked');
        }
        Object.assign(layer, options);
        await this.#dbStoreLayer(layer);
        return true;
    }

    async renameLayer(name, newName) {
        const currentLayer = this.getLayerByName(name);
        if (!currentLayer) {
            throw new Error(`Layer not found: ${name}`);
        }

        if (currentLayer.locked) {
            throw new Error('Layer is locked');
        }

        if (this.getLayerByName(newName)) {
            throw new Error(`Unable to rename layer, layer name already exists: ${newName}`);
        }

        // First lets insert the "new" layer to the db
        const newLayer = currentLayer;
        newLayer.setName(newName);
        newLayer.setLabel(newName);
        try {
            await this.#dbStoreLayer(newLayer);
        } catch (error) {
            throw new Error(`Failed to store renamed layer into the database: ${newName}`);
        }

        // Now lets remove the old layer from the db
        try {
            await this.#dbRemoveLayer(currentLayer);
        } catch (error) {
            throw new Error(`Failed to remove existing layer: ${newName}`);
        }

        return newLayer;
    }

    async removeLayer(layer) {
        if (layer.locked) { throw new Error('Layer is locked'); }
        await this.#dbRemoveLayer(layer);
    }

    async removeLayerByID(id) {
        const layer = this.getLayerByID(id);
        if (layer.locked) {
            throw new Error('Layer is locked');
        }

        await this.#dbRemoveLayer(layer);
    }

    async removeLayerByName(name) {
        const layer = this.getLayerByName(name);
        if (layer.locked) {
            throw new Error('Layer is locked');
        }

        await this.#dbRemoveLayer(layer);
    }

    /**
     * Private(internal) methods
     */

    #constructLayerKey(id) {
        return `layer/${id}`;
    }

    async #dbStoreLayer(layer, persistent = true) {
        if (persistent) {
            await this.#store.put(this.#constructLayerKey(layer.id), layer);
        }

        this.#nameToLayerMap.set(layer.name, layer);
        return true;
    }

    async #dbRemoveLayer(layer) {
        await this.#store.remove(this.#constructLayerKey(layer.id));
        this.#nameToLayerMap.delete(layer.name);
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
        const layers = await this.listLayers();
        for (const layerId of layers) {
            debug(`Initializing layer ${layerId}`);
            const layer = this.getLayerByID(layerId);
            console.log('layer', layer);
            this.#nameToLayerMap.set(layer.name, layer);
        }
    }
}

export default LayerIndex;

