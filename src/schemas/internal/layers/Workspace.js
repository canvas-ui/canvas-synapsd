'use strict';

import Layer from './BaseLayer.js';

// To be used as a "mountpoint" to a workspace
export default class Workspace extends Layer {

    constructor(name, options = {}) {
        super(name, options);
    }

}
