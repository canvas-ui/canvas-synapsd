

import debugMessage from 'debug';
const debug = debugMessage('canvas:tree:layer');

import { v4 as uuidv4 } from 'uuid';
//import { LAYER_TYPES } from '../index.js';

class Layer {
    constructor(options) {
        if (typeof options !== 'object') {
            options = { name: options };
        }

        // Default options
        options = {
            schemaVersion: '2.0',
            id: uuidv4(),
            type: 'layer',
            color: null,
            ...options,
        };

        if (!options.name || typeof options.name !== 'string' || !options.name.trim().length) {
            throw new Error('Layer name must be a non-empty String');
        }

        // TODO: This constructor needs a proper cleanup!
        this.id = options.id;
        this.type = this.#validateType(options.type); // TODO: Move to LayerManager/dedicated file
        this.name = this.#sanitizeName(options.name);
        this.label = options.label ? this.#sanitizeLabel(options.label) : this.name;
        this.description = options.description ? this.#sanitizeDescription(options.description) : 'Canvas layer';
        this.color = options?.color;
        this.locked = options?.locked || false;
        this.metadata = options.metadata || {};
    }

    /**
     * Setters
     */

    setName(name) {
        if (this.locked) {
            throw new Error('Layer is locked');
        }
        this.name = this.#sanitizeName(name);
        return this;
    }

    setLabel(label) {
        if (this.locked) {
            throw new Error('Layer is locked');
        }
        this.label = this.#sanitizeLabel(label);
        return this;
    }

    setDescription(description) {
        if (this.locked) {
            throw new Error('Layer is locked');
        }
        this.description = this.#sanitizeDescription(description);
        return this;
    }

    /**
     * Validators
     */

    #validateType(type) {
        /*if (!LAYER_TYPES.includes(type)) {
            throw new Error('Unsupported layer type');
        }*/
        // Moved to Tree
        return type;
    }

    #sanitizeName(name) {
        if (typeof name !== 'string') {
            throw new Error('Name must be a string');
        }

        if (name.length > 32) {
            throw new Error('Name must be less than 32 characters');
        }

        return name.toLowerCase(); //name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    }

    #sanitizeLabel(label) {
        if (typeof label !== 'string') {
            throw new Error('Label must be a string');
        }

        if (label.length > 32) {
            throw new Error('Label must be less than 32 characters');
        }

        return label; //label.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    #sanitizeDescription(description) {
        // Check if description is a string, not empty and less than 255 characters
        if (typeof description !== 'string') {
            throw new Error('Description must be a string');
        }

        if (description.length > 255) {
            throw new Error('Description must be less than 255 characters');
        }

        return description;
    }

    /**
     * JSON
     */

    toJSON() {
        // TODO: Maybe we should use JSON.stringify to return a valid JSON directly
        return {
            schemaVersion: this.schemaVersion,
            id: this.id,
            type: this.type,
            name: this.name,
            label: this.label,
            description: this.description,
            color: this.color,
            locked: this.locked,
            metadata: this.metadata,
        };
    }

    static fromJSON(json) {
        // TODO: Maybe we should use JSON string as input and then JSON.parse it
        const layer = new Layer({
            schemaVersion: json.schemaVersion,
            id: json.id,
            type: json.type,
            name: json.name,
            label: json.label,
            description: json.description,
            color: json.color,
            locked: json.locked,
            metadata: json.metadata,
        });
        return layer;
    }
}

export default Layer;
