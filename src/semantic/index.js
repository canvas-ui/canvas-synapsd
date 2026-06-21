'use strict';

class SemanticEngine {
    constructor(options = {}) {
        this.db = options.db || null;
    }

    async initialize() { }
}

export default SemanticEngine;
