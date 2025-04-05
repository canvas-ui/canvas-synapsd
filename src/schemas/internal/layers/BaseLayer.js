import debugMessage from 'debug';
const debug = debugMessage('synapsd:tree:layer');

import { v4 as uuidv4 } from 'uuid';

class Layer {
    constructor(name, options = {}) {
        if (typeof name === 'object') {
            options = name;
            name = options.name;
        }

        // Default options
        options = {
            id: uuidv4(),
            type: 'context',
            color: null,
            ...options,
        };

        // TODO: This constructor needs a proper cleanup!
        this.id = options.id;
        this.schemaVersion = options.schemaVersion || '2.0';
        this.type = options.type ?? 'context';
        this.name = this.#sanitizeName(name);
        this.label = options.label ? this.#sanitizeLabel(options.label) : this.name;
        this.description = options.description ? this.#sanitizeDescription(options.description) : 'Canvas layer';
        this.color = options?.color;
        this.locked = options?.locked || false;
        this.metadata = options.metadata || {};
    }

    /**
     * Convenience methods
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

    #sanitizeName(name) {
        if (typeof name !== 'string') {
            throw new Error('Name must be a string');
        }

        if (name.length > 32) {
            throw new Error('Name must be less than 32 characters');
        }

        // Remove all special characters except underscore, dash, dot and forward slash
        name = name.replace(/[^a-zA-Z0-9_./\-]/g, '_');

        // Convert to lowercase
        name = name.toLowerCase();

        return name;
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
