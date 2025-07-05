'use strict';

// Backend implementations
import LmdbBackend from './lmdb/index.js';
import FileBackend from './file/index.js';

import debugInstance from 'debug';
const debug = debugInstance('canvas:service:synapsd:backend');

/**
 * Backend factory for SynapsD
 * Supports multiple backend types with a unified interface
 */

class BackendFactory {
    
    static BACKEND_TYPES = {
        LMDB: 'lmdb',
        FILE: 'file',
        // Future backends can be added here
        // SQLITE: 'sqlite',
        // MEMORY: 'memory',
    };

    /**
     * Create a backend instance based on type
     * @param {string} type - Backend type ('lmdb', 'file', etc.)
     * @param {object} options - Backend configuration options
     * @returns {object} Backend instance
     */
    static createBackend(type, options) {
        const backendType = type.toLowerCase();
        
        debug(`Creating backend of type: ${backendType}`);
        
        switch (backendType) {
            case BackendFactory.BACKEND_TYPES.LMDB:
                return new LmdbBackend(options);
                
            case BackendFactory.BACKEND_TYPES.FILE:
                return new FileBackend(options);
                
            default:
                throw new Error(`Unsupported backend type: ${type}. Supported types: ${Object.values(BackendFactory.BACKEND_TYPES).join(', ')}`);
        }
    }

    /**
     * Get available backend types
     * @returns {Array<string>} Array of available backend types
     */
    static getAvailableBackends() {
        return Object.values(BackendFactory.BACKEND_TYPES);
    }

    /**
     * Validate backend type
     * @param {string} type - Backend type to validate
     * @returns {boolean} True if valid, false otherwise
     */
    static isValidBackendType(type) {
        return Object.values(BackendFactory.BACKEND_TYPES).includes(type.toLowerCase());
    }

    /**
     * Get backend capabilities (for future extensibility)
     * @param {string} type - Backend type
     * @returns {object} Capabilities object
     */
    static getBackendCapabilities(type) {
        const backendType = type.toLowerCase();
        
        switch (backendType) {
            case BackendFactory.BACKEND_TYPES.LMDB:
                return {
                    transactions: true,
                    atomicWrites: true,
                    compression: true,
                    versioning: true,
                    backup: true,
                    performance: 'high',
                    durability: 'high',
                    concurrency: 'high',
                };
                
            case BackendFactory.BACKEND_TYPES.FILE:
                return {
                    transactions: true,
                    atomicWrites: true,
                    compression: false,
                    versioning: false,
                    backup: true,
                    performance: 'medium',
                    durability: 'medium',
                    concurrency: 'low',
                };
                
            default:
                return {};
        }
    }
}

/**
 * Interface definition for backend implementations
 * This serves as documentation for what methods backends must implement
 */
class BackendInterface {
    // Constructor
    constructor(options, dataset) {
        throw new Error('BackendInterface is abstract and cannot be instantiated');
    }

    // Properties
    get path() { throw new Error('path getter must be implemented'); }
    get name() { throw new Error('name getter must be implemented'); }
    get status() { throw new Error('status getter must be implemented'); }
    get stats() { throw new Error('stats getter must be implemented'); }

    // Dataset management
    createDataset(dataset, options = {}) { throw new Error('createDataset must be implemented'); }

    // Map-like interface
    clear() { throw new Error('clear must be implemented'); }
    delete(key) { throw new Error('delete must be implemented'); }
    entries() { throw new Error('entries must be implemented'); }
    forEach(callback) { throw new Error('forEach must be implemented'); }
    get(key, options = {}) { throw new Error('get must be implemented'); }
    has(key) { throw new Error('has must be implemented'); }
    keys() { throw new Error('keys must be implemented'); }
    values() { throw new Error('values must be implemented'); }
    set(key, value) { throw new Error('set must be implemented'); }

    // Native methods
    async put(key, value, version) { throw new Error('put must be implemented'); }
    async remove(key) { throw new Error('remove must be implemented'); }
    async transaction(action) { throw new Error('transaction must be implemented'); }
    transactionSync(action, flags) { throw new Error('transactionSync must be implemented'); }
    
    // Lifecycle methods
    async close() { throw new Error('close must be implemented'); }
}

export default BackendFactory;
export { BackendInterface };