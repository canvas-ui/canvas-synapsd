'use strict';

import Layer from './BaseLayer.js';

/**
 * Canvas layer
 *
 * A tree-addressable "stored db view" layer. It carries a `querySpec`
 * (features + filters) that the application AND-composes with the host
 * tree path at query time. `querySpec.query` is an optional FTS string for
 * saved searches. `metadata` is an opaque blob owned entirely
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
            query: null,
            sort: null,
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

        const query = spec.query ?? spec.search ?? spec.q;
        if (typeof query === 'string' && query.trim()) {
            out.query = query.trim();
        }

        // Saved view order: { sortBy: <timeline name>, order: 'asc'|'desc' }.
        // sortBy AND-composes nothing — it only reorders the composed result set
        // (applied in Workspace.#composeCanvasForScope). Empty sortBy = no sort.
        if (spec.sort && typeof spec.sort === 'object') {
            const sortBy = typeof spec.sort.sortBy === 'string' ? spec.sort.sortBy.trim() : '';
            if (sortBy) {
                out.sort = { sortBy, order: spec.sort.order === 'asc' ? 'asc' : 'desc' };
            }
        }

        return out;
    }

    setQuerySpec(spec) {
        // No lock guard here: a canvas's querySpec (search/filter refinement) is
        // presentation, not structure. LayerIndex.updateLayer already gates locked
        // layers to the presentation allowlist (querySpec/metadata/color) and
        // DirectoryTree applies querySpec on locked nodes the same way — a lock
        // (e.g. a public share) keeps the canvas's identity/path stable for the
        // share URL, but the owner must still be able to save filter changes.
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
