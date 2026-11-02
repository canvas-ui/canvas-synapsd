'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd');


import schemaRegistry from '../schemas/SchemaRegistry.js';
import { ValidationError } from './errors.js';
import { isDocumentData, isDocumentInstance } from '../schemas/SchemaRegistry.js';

function invalidField(field, expected, value, schema) {
    const received = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const message = `${field} must be ${expected} (got ${received})`;
    return new ValidationError(message, {
        schema,
        issues: [{ path: [field], message, code: 'invalid_type', received }],
    });
}

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

    if (!parsedData || typeof parsedData !== 'object' || Array.isArray(parsedData)) {
        throw invalidField('document', 'a non-null object', parsedData);
    }
    if (typeof parsedData.schema !== 'string' || !parsedData.schema.trim()) {
        throw invalidField('schema', 'a non-empty string', parsedData.schema);
    }
    // Normalize JSON-encoded payloads at the common write boundary, before any
    // schema-specific constructor, checksum, or timeline derivation runs.
    if (typeof parsedData.data === 'string') {
        try {
            parsedData = { ...parsedData, data: JSON.parse(parsedData.data) };
        } catch {
            const message = 'data contains invalid JSON; expected a non-null object';
            throw new ValidationError(message, {
                schema: parsedData.schema,
                issues: [{ path: ['data'], message, code: 'invalid_json', received: 'string' }],
            });
        }
    }
    if (parsedData.data === null || typeof parsedData.data !== 'object' || Array.isArray(parsedData.data)) {
        throw invalidField('data', 'a non-null object', parsedData.data, parsedData.schema);
    }

    return parsedData;
}

/**
 * Initialize a document from data (creates class instance if needed)
 * @param {Object} documentData
 * @returns {Document} Initialized document instance
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
 * @returns {Document} Initialized document instance
 */
export function parseInitializeDocument(documentData) {
    try {
        const parsedData = parseDocumentData(documentData);
        return initializeDocument(parsedData);
    } catch (error) {
        if (error instanceof ValidationError) { throw error; }
        const wrapped = new ValidationError(`Invalid document: ${error.message}`, {
            schema: documentData?.schema,
            issues: error.issues?.map(({ path, message, code }) => ({ path, message, code })) || [{ path: [], message: error.message }],
        });
        wrapped.cause = error;
        throw wrapped;
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

/**
 * Generate N sequential document IDs in a single transaction.
 */
export function generateDocumentIDs(internalStore, count, minId = 100000) {
    const counterKey = 'internal/document-id-counter';

    return internalStore.transactionSync(() => {
        let currentCounter = internalStore.get(counterKey);
        if (currentCounter === undefined || currentCounter === null) {
            currentCounter = minId;
        }
        const firstId = currentCounter + 1;
        internalStore.putSync(counterKey, currentCounter + count);
        const ids = new Array(count);
        for (let i = 0; i < count; i++) {
            ids[i] = firstId + i;
        }
        return ids;
    });
}

// Materialize readable rows while tolerating corrupted legacy documents.
export function safeParseDocuments(docs) {
    const result = [];
    for (const doc of docs) {
        try {
            result.push(parseInitializeDocument(doc));
        } catch (e) {
            debug(`safeParseDocuments: Skipping corrupted document (id=${doc?.id ?? 'unknown'}): ${e.message}`);
        }
    }
    return result;
}
