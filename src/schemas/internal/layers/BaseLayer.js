import debugMessage from 'debug';
const debug = debugMessage('synapsd:tree:layer');

import { ulid } from 'ulid';

class Layer {
    constructor(name, options = {}) {
        if (typeof name === 'object') {
            options = name;
            name = options.name;
        }

        // Default options
        options = {
            id: undefined,
            type: 'context',
            color: null,
            ...options,
        };

        // Compute normalized name first
        const normalizedName = this.#sanitizeName(name);

        // Initialize core fields
        this.schemaVersion = options.schemaVersion || '2.0';
        this.type = options.type ?? 'context';
        this.name = normalizedName;

        // ID: prefer provided id; otherwise generate a ULID (chronologically sortable)
        this.id = options.id ?? ulid();

        // Label: preserve provided label (original user-facing string), else fallback to original name string
        const providedLabel = options.label ?? String(name ?? normalizedName);
        this.label = this.#sanitizeLabel(providedLabel);

        this.description = options.description ? this.#sanitizeDescription(options.description) : 'Canvas layer';
        this.color = options?.color;
        this.lockedBy = options?.lockedBy || [];
        this.metadata = options.metadata || {};
        this.acl = options.acl || {};
    }

    /**
     * Getters
     */

    get isLocked() {
        return this.lockedBy.length > 0;
    }

    isLockedBy(lockBy) {
        if (!lockBy) {
            return false;
        }
        return this.lockedBy.includes(lockBy);
    }

    /**
     * Convenience methods
     */

    setName(name) {
        if (this.isLocked) {
            throw new Error('Layer is locked');
        }
        const sanitized = this.#sanitizeName(name);
        this.name = sanitized;
        return this;
    }

    setLabel(label) {
        if (this.isLocked) {
            throw new Error('Layer is locked');
        }
        this.label = this.#sanitizeLabel(label);
        return this;
    }

    setDescription(description) {
        if (this.isLocked) {
            throw new Error('Layer is locked');
        }
        this.description = this.#sanitizeDescription(description);
        return this;
    }

    lock(lockBy) {
        if (!lockBy) {
            throw new Error('Locking layer requires a lockBy parameter');
        }

        if (!this.lockedBy.includes(lockBy)) {
            this.lockedBy.push(lockBy);
        }

        return true;
    }

    unlock(lockBy) {
        if (!lockBy) {
            throw new Error('Unlocking layer requires a lockBy parameter');
        }

        this.lockedBy = this.lockedBy.filter(context => context !== lockBy);

        return this.isLocked;
    }

    /**
     * Validators
     */

    #sanitizeName(name) {
        if (typeof name !== 'string') {
            throw new Error('Name must be a string');
        }

        // Root layer name is a special case
        if (name === '/') {
            return '/';
        }

        if (name.length > 64) {
            throw new Error('Name must be less than 64 characters');
        }

        // Allow UTF-8 letters/numbers + spaces and: . + - _ @
        // Disallow path/control characters (e.g. '/', '\', ':', '*', etc) by replacing them with '_'.
        const INVALID = /[^\p{L}\p{N}\p{M} .+_@-]/gu;

        let n = String(name).normalize('NFKC').trim().replace(/\s+/g, ' ');
        n = n.replace(INVALID, '_').replace(/_+/g, '_');
        return n || '_';
    }

    #sanitizeLabel(label) {
        if (typeof label !== 'string') {
            throw new Error('Label must be a string');
        }

        if (label.length > 64) {
            throw new Error('Label must be less than 64 characters');
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
            locked: this.isLocked,
            lockedBy: this.lockedBy,
            metadata: this.metadata,
            acl: this.acl,
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
            lockedBy: json.lockedBy || [],
            metadata: json.metadata,
            acl: json.acl || {},
        });
        return layer;
    }

}

export default Layer;
