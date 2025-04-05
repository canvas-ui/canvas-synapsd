'use strict';

import Layer from './BaseLayer.js';

export default class Universe extends Layer {

    constructor(name = '/', options = {
        id: '10000000-1000',
        label: 'Universe',
        type: 'universe',
        description: 'And then there was geometry...',
        locked: true,
        color: '#fff',
    }) {
        super(name, options);
    }

}
