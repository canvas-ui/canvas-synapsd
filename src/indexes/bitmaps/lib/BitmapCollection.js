'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import path from 'path';
import debugMessage from 'debug';
const debug = debugMessage('canvas-synapsd:bitmapCollection');


export default class BitmapCollection {

    constructor(name, options = {}) {
        if (!name) { throw new Error('BitmapCollection name required'); }
        this.name = name;

        this.store = options?.backingStore || new Map();
        this.cache = options?.cache || new Map();

        this.rangeMin = options?.rangeMin || 0;
        this.rangeMax = options?.rangeMax || 4294967296; // 2^32

        debug(`BitmapCollection "${this.name}" initialized with rangeMin: ${this.rangeMin}, rangeMax: ${this.rangeMax}`);
    }

}