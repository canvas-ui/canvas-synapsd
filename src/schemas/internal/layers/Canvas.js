'use strict';

import Layer from './BaseLayer.js';

/**
 * Canvas layer
 *
 * A tree-addressable "stored db view" layer. It carries a `querySpec`
 * (features + filters) that the application AND-composes with the host
 * tree path at query time, plus an opaque `metadata` blob owned entirely
 * by the consumer (UI layout, share info, applet config, etc.).
 *
 * SynapsD itself never introspects `metadata`.
 */
export default class Canvas extends Layer {

    constructor(name, options = {}) {
        // Mirror BaseLayer's name-as-object overload so callers can do
        // `new Canvas({ name, querySpec, ... })`. Without this unwrap, the
        // querySpec/schemaVersion reads below pull from the empty default
        // options object and the spec is silently dropped on reconstruction.
        if (typeof name === 'object' && name !== null) {
            options = name;
            name = options.name;
        }

        super(name, { ...options, type: 'canvas' });

        // Bump per-schema version (BaseLayer defaults to '2.0')
        this.schemaVersion = options.schemaVersion || '2.1';
        this.type = 'canvas';

        this.querySpec = Canvas.normalizeQuerySpec(options.querySpec);
    }

    /**
     * Validate / normalize a partial querySpec.
     * Missing keys mean "no constraint". `null` features ≠ `[]` features.
     */
    static normalizeQuerySpec(spec = {}) {
        const out = {
            features: null,
            filters: [],
        };
        if (!spec || typeof spec !== 'object') { return out; }

        if (spec.features !== undefined) {
            const f = spec.features;
            if (f === null) {
                out.features = null;
            } else if (Array.isArray(f)) {
                out.features = f.filter((x) => typeof x === 'string');
            } else if (typeof f === 'object') {
                // Object form { allOf, anyOf, noneOf } passes through verbatim
                out.features = {};
                if (Array.isArray(f.allOf))  { out.features.allOf  = f.allOf.filter((x) => typeof x === 'string'); }
                if (Array.isArray(f.anyOf))  { out.features.anyOf  = f.anyOf.filter((x) => typeof x === 'string'); }
                if (Array.isArray(f.noneOf)) { out.features.noneOf = f.noneOf.filter((x) => typeof x === 'string'); }
            }
        }

        if (Array.isArray(spec.filters)) {
            out.filters = spec.filters.filter((x) => typeof x === 'string');
        }

        return out;
    }

    setQuerySpec(spec) {
        if (this.isLocked) {
            throw new Error('Layer is locked');
        }
        this.querySpec = Canvas.normalizeQuerySpec(spec);
        return this;
    }

    toJSON() {
        return {
            ...super.toJSON(),
            schemaVersion: this.schemaVersion,
            querySpec: this.querySpec,
        };
    }

    static fromJSON(json) {
        return new Canvas({
            schemaVersion: json.schemaVersion,
            id: json.id,
            type: 'canvas',
            name: json.name,
            label: json.label,
            description: json.description,
            color: json.color,
            lockedBy: json.lockedBy || [],
            metadata: json.metadata,
            acl: json.acl || {},
            querySpec: json.querySpec,
        });
    }
}
