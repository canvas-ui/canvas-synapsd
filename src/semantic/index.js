'use strict';

class SemanticEngine {
    constructor(options = {}) {
        this.db = options.db || null;
    }

    async initialize() { }

    async recall(query, spec = {}) {
        if (!query || (typeof query !== 'string' && !Array.isArray(query))) {
            throw new Error('recall() requires a query string or semantic anchor array');
        }
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
            throw new Error('recall() spec must be an object when provided');
        }

        // Semantic-anchor planning (layered overlapping semantic trees) is a
        // separate, later effort. For MVP a string query maps to hybrid search.
        if (Array.isArray(query)) {
            throw new Error('Semantic anchor recall is not implemented yet');
        }

        return this.db.search({ ...spec, query, mode: spec.mode || 'hybrid' });
    }
}

export default SemanticEngine;
