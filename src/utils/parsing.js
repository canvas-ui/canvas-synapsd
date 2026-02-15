'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:parsing');

/**
 * Parse a single path string into layer array
 * @param {string} pathString - Path string like '/foo/bar'
 * @returns {Array<string>} Array of layers ['/', 'foo', 'bar']
 */
export function parsePathToLayers(pathString) {
    if (!pathString || pathString === '') { return ['/']; }
    if (typeof pathString !== 'string') { throw new Error('Path must be a string'); }
    if (pathString === '/') { return ['/']; }

    const parts = pathString.split('/').map(part => part.trim()).filter(Boolean);
    return parts.length === 0 ? ['/'] : ['/', ...parts];
}

/**
 * Parse contextSpec for INSERT operations (supports arrays of independent paths)
 * @param {string|Array<string>} contextSpec - Single path or array of paths
 * @returns {Array<Array<string>>} Array of path-layer-arrays
 */
export function parseContextSpecForInsert(contextSpec) {
    if (!contextSpec || contextSpec === '') { return [['/']] ; }

    if (Array.isArray(contextSpec)) {
        const flattened = contextSpec.flat().filter(Boolean);
        if (flattened.length === 0) { return [['/']] ; }
        return flattened.map(path => parsePathToLayers(path));
    }

    if (typeof contextSpec === 'string') {
        return [parsePathToLayers(contextSpec)];
    }

    throw new Error('Invalid contextSpec: Must be a path string or an array of path strings.');
}

/**
 * Parse contextSpec for QUERY operations (single path only)
 * @param {string|null} contextSpec - Single path string or null
 * @returns {Array<string>} Single layer array
 */
export function parseContextSpecForQuery(contextSpec) {
    if (contextSpec === null || contextSpec === undefined) { return []; }
    if (contextSpec === '') { return ['/']; }
    if (Array.isArray(contextSpec)) {
        throw new Error('Arrays are not supported in query contextSpec. Use a single path string or null.');
    }
    if (typeof contextSpec === 'string') { return parsePathToLayers(contextSpec); }
    throw new Error('Invalid contextSpec for query: Must be a path string or null.');
}

/**
 * Normalize bitmap array input
 * @param {Array|*} bitmapArray
 * @returns {Array}
 */
export function parseBitmapArray(bitmapArray) {
    return Array.isArray(bitmapArray) ? bitmapArray : [bitmapArray];
}
