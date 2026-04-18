'use strict';

import Layer from './BaseLayer.js';

// Canvas layer is a tree-adressable "database view" layer
// that stores filters and feature informations and (optionally)
// metadata used for dashboard/UI applet configuration
export default class Canvas extends Layer {

    constructor(name, options = {}) {
        super(name, options);
        this.type = 'canvas';
        this.description = 'Canvas layer';
    }

}
