'use strict';

import Layer from './BaseLayer.js';

// No-op layer not tied to any bitmap, hence not processed when supplied via contextSpec/contextArray
export default class Label extends Layer {

    constructor(name, options = {}) {
        super(name, options);
    }

}
