// Utils
import EventEmitter from 'eventemitter2';
import debugMessage from 'debug';
const debug = debugMessage('canvas:context:layer-manager');

// Constants
const LAYER_TYPES = [
    'universe', // Root layer for a workspace
    'system', // System layers (canvas, device, user, session)
    'workspace', // "Mountpoint" to a workspace
    'canvas', // Can store context, feature and filter bitmaps + dashboard / UI layouts
    'context', // Has context bitmaps only
    'label', // Label only (no associated bitmaps)
];

// Includes
import Layer from './lib/Layer.js';
import builtInLayers from './lib/builtinLayers.js';

/**
 * Layer Index
 */
class LayerIndex extends EventEmitter {
    constructor(index, rootLayerOptions = {}) {
        super(); // EventEmitter

        if (!index || typeof index.set !== 'function' || typeof index.get !== 'function') {
            throw new Error('A Index Store reference with a Map() like interface required');
        }
        this.index = index;

        this.nameToLayerMap = new Map();
        this.#initBuiltInLayers(rootLayerOptions);
        this.#initNameToLayerMap();
        debug(`Layer index initialized with ${this.index.size} layers`);
    }

    has(id) {
        return this.hasLayerID(id);
    }
    hasLayerID(id) {
        return this.index.has(id);
    }
    hasLayerName(name) {
        return this.nameToLayerMap.has(name);
    }

    isInternalLayerName(name) {
        const layer = this.getLayerByName(name);
        return layer && builtInLayers.find((layer) => layer.name === name);
    }

    isInternalLayerID(id) {
        const layer = this.getLayerByID(id);
        return layer && builtInLayers.find((layer) => layer.id === id);
    }

    list() {
        const result = [];
        for (const [id, layer] of this.index()) {
            result.push(layer);
        }
        return result;
    }

    createLayer(name, options = {}) {
        if (typeof name === 'string') {
            options = {
                name: name,
                ...options,
            };
        } else {
            options = name;
        }
        debug(`Creating layer ${JSON.stringify(options)}`);

        // Check if layer type is valid
        if (options.type && !LAYER_TYPES.includes(options.type)) {
            throw new Error(`Invalid layer type: ${options.type}`);
        }

        // Check if layer already exists
        if (this.hasLayerName(options.name)) {
            // If update option is set, update the existing layer
            if (options.update === true) {
                const existingLayer = this.getLayerByName(options.name);
                // Update properties
                Object.assign(existingLayer, options);
                debug(`Updated existing layer ${options.name}`);
                return existingLayer;
            }
            return false;
        }

        const layer = new Layer(options);
        if (!layer) {
            throw new Error(`Failed to create layer with options ${options}`);
        }

        this.#addLayerToIndex(layer, !this.isInternalLayerID(layer.id));
        return layer;
    }

    getLayerByID(id) {
        return this.index.get(id) || null;
    }

    getLayerByName(name) {
        const res = this.nameToLayerMap.get(name);
        return res || null;
    }

    updateLayer(name, options) {
        const layer = this.getLayerByName(name);
        if (!layer) {
            return false;
        }
        if (layer.locked) {
            throw new Error('Layer is locked');
        }
        Object.assign(layer, options);
        this.index.set(layer.id, layer);
        return true;
    }

    renameLayer(name, newName) {
        const layer = this.getLayerByName(name);
        if (layer.locked) {
            throw new Error('Layer is locked');
        }
        if (layer.setName(newName)) {
            this.nameToLayerMap.deleteSync(name);
            this.nameToLayerMap.set(newName, layer);
            this.index.set(layer.id, layer);
        }
    }

    removeLayer(layer) {
        if (layer.locked) {
            throw new Error('Layer is locked');
        }
        this.index.delete(layer.id);
        this.nameToLayerMap.deleteSync(layer.name);
    }

    removeLayerByID(id) {
        const layer = this.getLayerByID(id);
        if (layer.locked) {
            throw new Error('Layer is locked');
        }
        return layer ? this.removeLayer(layer) : false;
    }

    removeLayerByName(name) {
        const layer = this.getLayerByName(name);
        if (layer.locked) {
            throw new Error('Layer is locked');
        }
        return layer ? this.removeLayer(layer) : false;
    }

    nameToID(name) {
        const layer = this.getLayerByName(name);
        return layer.id || null;
    }

    idToName(id) {
        const layer = this.getLayerByID(id);
        return layer.name || null;
    }

    #addLayerToIndex(layer, persistent = true) {
        if (persistent) {
            this.index.set(layer.id, layer);
        }
        this.nameToLayerMap.set(layer.name, layer);
    }

    #initBuiltInLayers(rootLayerOptions = {}) {
        // Check if a root layer already exists in the index
        const rootExists = this.hasLayerName('/');
        if (!rootExists) {
            if (rootLayerOptions.name) {
                this.createLayer(rootLayerOptions.name, rootLayerOptions);
            } else {
                this.createLayer(builtInLayers[0]);
            }
        }

        // TODO: Builtin layers should not be added to the index
        return;

        for (const layer of builtInLayers) {
            // Skip the root layer if it already exists
            if (rootExists && layer.name === '/') {
                continue;
            }
            this.createLayer(layer);
        }
    }

    #initNameToLayerMap() {
        for (const [id, layer] of this.index) {
            this.nameToLayerMap.set(layer.name, this.index.get(layer.id));
        }
    }
}

export default LayerIndex;
export { LAYER_TYPES };
