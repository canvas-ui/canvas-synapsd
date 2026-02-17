'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:document-utils');

import schemaRegistry from '../schemas/SchemaRegistry.js';
import { isDocumentData, isDocumentInstance } from '../schemas/SchemaRegistry.js';

/**
 * Parse a document data object (string or object) into a plain JS object
 * @param {String|Object} documentData
 * @returns {Object} Parsed document data object
 */
export function parseDocumentData(documentData) {
    if (!documentData) { throw new Error('Document data required'); }

    let parsedData;
    if (typeof documentData === 'string') {
        try {
            parsedData = JSON.parse(documentData);
        } catch (error) {
            throw new Error(`Invalid JSON data provided: ${error.message}`);
        }
    } else if (typeof documentData === 'object' && documentData !== null) {
        parsedData = documentData;
    } else {
        throw new Error(`Invalid document data type: Expected string or object, got ${typeof documentData}`);
    }

    if (!parsedData.schema || parsedData.data == null || typeof parsedData.data !== 'object') {
        throw new Error('Parsed document data must have a schema and a non-null data object.');
    }

    return parsedData;
}

/**
 * Initialize a document from data (creates class instance if needed)
 * @param {Object} documentData
 * @returns {BaseDocument} Initialized document instance
 */
export function initializeDocument(documentData) {
    if (!documentData || typeof documentData !== 'object') {
        throw new Error('Document data required for initialization (must be an object)');
    }

    if (isDocumentInstance(documentData)) { return documentData; }

    if (isDocumentData(documentData)) {
        const Schema = schemaRegistry.getSchema(documentData.schema);
        return Schema.fromData(documentData);
    }

    throw new Error('Invalid document data type: Expected Document instance or plain data object.');
}

/**
 * Parse and initialize a document in one step
 * @param {Object|string} documentData
 * @returns {BaseDocument} Initialized document instance
 */
export function parseInitializeDocument(documentData) {
    if (!documentData) { throw new Error('Document data required'); }
    try {
        const parsedData = parseDocumentData(documentData);
        return initializeDocument(parsedData);
    } catch (error) {
        throw new Error(`Failed to parse and initialize document: ${error.message}`);
    }
}

/**
 * Generate a new document ID using atomic counter
 * @param {Object} internalStore - LMDB internal store dataset
 * @param {number} minId - Minimum ID (INTERNAL_BITMAP_ID_MAX)
 * @returns {number} New document ID
 */
export function generateDocumentID(internalStore, minId = 100000) {
    const counterKey = 'internal/document-id-counter';

    return internalStore.transactionSync(() => {
        let currentCounter = internalStore.get(counterKey);
        if (currentCounter === undefined || currentCounter === null) {
            currentCounter = minId;
        }
        const newId = currentCounter + 1;
        internalStore.putSync(counterKey, newId);
        return newId;
    });
}
