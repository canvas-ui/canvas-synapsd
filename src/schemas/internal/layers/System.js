'use strict';

import Layer from './BaseLayer.js';

// Reserved for internal system layers
export default class System extends Layer {

    constructor(name, options = {}) {
        super(name, options);
    }

}
