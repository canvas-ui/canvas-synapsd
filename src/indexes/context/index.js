// Utils
import EventEmitter from 'eventemitter2';
import debugMessage from 'debug';
const debug = debugMessage('synapsd:layer-index');

// Schemas
import SchemaRegistry from '../../schemas/SchemaRegistry.js';

// Constants
const LAYER_TYPES = [
    'universe', // Root layer for a workspace
    'system', // System layers (canvas, device, user, session)
    'workspace', // "Mountpoint" to a workspace
    'canvas', // Can store context, feature and filter bitmaps + dashboard / UI layouts
    'context', // Has context bitmaps only
    'label', // Label only (no associated bitmaps)
];

class ContextLayerIndex {

    constructor(options = {}) {
        this.options = options;
    }

    /**
     * Getters
     */

    get layers() {
        return this.options.layers;
    }

    /**
     * Internal methods
     */

    #initNameToLayerMap() {
        for (const [id, layer] of this.layerIndex) {
            this.nameToLayerMap.set(layer.name, this.index.get(layer.id));
        }
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
