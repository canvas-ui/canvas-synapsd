// Utils
import EventEmitter from 'eventemitter2';
import debugMessage from 'debug';
const debug = debugMessage('synapsd:layer-index');

// Schemas
import SchemaRegistry from '../../schemas/SchemaRegistry.js';

/**
 * Context Layer Index
 */
class ContextLayerIndex {

    constructor(options = {}) {
        if (!options.layerDataset) {
            throw new Error('Layer dataset is required');
        }

        this.index = options.layerDataset;
        this.options = options;

        // Initialize the name to layer map
        this.nameToLayerMap = new Map();
        this.#initNameToLayerMap();

        debug(`Layer index initialized`);
    }

    /**
     * Getters
     */

    get layers() {

    }

    /**
     * Internal methods
     */

    #initNameToLayerMap() {

    }

    #saveLayerToDb(layer, persistent = true) {
        if (persistent) {
            this.index.set(layer.id, layer);
        }
        this.nameToLayerMap.set(layer.name, layer);
    }

    #loadLayerFromDb(name) {
        const layer = this.nameToLayerMap.get(name);
        if (!layer) {
            throw new Error(`Layer "${name}" not found`);
        }
        return layer;
    }

}

export default ContextLayerIndex;
