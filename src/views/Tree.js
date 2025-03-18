'use strict';

// Utils
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:context-tree');

export default class ContextTree {

    // ContextTree abstraction on top of the data.
    // I'm almost decided to move the Tree module from
    // canvas-server to this synapsd module as conceptually,
    // it seems like a good fit.

    constructor() {}

    /**
     * Getters
     */

    get layers() {}
    get paths() {}
    get jsonTree() {}

    /**
     * Tree methods
     */

    insertPath() {}

    copyPath() {}

    movePath() {}

    removePath() {}

    deletePath() {}

    pathExists() {}

    mergeUp() {}

    mergeDown() {}

    /**
     * Layer methods
     */


    /**
     * Internal methods
     */

}
