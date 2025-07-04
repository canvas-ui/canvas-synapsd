'use strict';

// Utils
import path from 'path';
import fs from 'fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from 'fs';
import { mkdirp } from 'mkdirp';
import { randomUUID } from 'crypto';

import debugInstance from 'debug';
const debug = debugInstance('canvas:service:synapsd:file');

/**
 * Canvas File Backend - JSON file-based storage
 * Implements the same interface as LMDB backend for compatibility
 */

class FileBackend {
    #dataset = 'default';
    #path;
    #dataPath;
    #lockPath;
    #isTransaction = false;
    #transactionData = new Map();
    #transactionDeletes = new Set();

    constructor(options, dataset) {
        // Parse input arguments
        if (options.open === undefined) {
            // Let's make path a required option
            if (!options.path) { throw new Error('File backend database path not provided'); }

            this.options = {
                // Database paths
                path: options.path,
                backupPath: options.backupPath || path.join(options.path, 'backup'),

                // Backup options
                backupOnOpen: options.backupOnOpen || false,
                backupOnClose: options.backupOnClose || false,

                // File backend specific options
                pretty: options.pretty || false,
                atomic: options.atomic !== false, // Default to true
                syncWrites: options.syncWrites || false,
                fileExtension: options.fileExtension || '.json',
                maxCacheSize: options.maxCacheSize || 1000,
                ...options,
            };

            this.#path = this.options.path;
            this.#dataPath = path.join(this.#path, 'data');
            this.#lockPath = path.join(this.#path, 'locks');

            // Create directories if they don't exist
            this.#ensureDirectories();
            
            debug(`File backend database at "${this.options.path}" initialized`);
        } else {
            // Dataset instance
            this.options = options.options || {};
            this.#path = options.path;
            this.#dataset = dataset;
            this.#dataPath = path.join(this.#path, dataset);
            this.#lockPath = path.join(this.#path, 'locks', dataset);
            
            // Create dataset directory
            this.#ensureDirectories();
            
            debug(`File backend dataset "${dataset}" initialized`);
        }

        // Initialize cache
        this.cache = new Map();
        this.cacheTimestamps = new Map();

        // This is unfortunate but matches LMDB interface
        this.backupOptions = {
            backupPath: this.options.backupPath,
            backupOnOpen: this.options.backupOnOpen,
            backupOnClose: this.options.backupOnClose,
            compact: this.options.backupCompact,
        };

        if (this.backupOptions.backupOnOpen) {
            this.#backupDatabase();
        }
    }

    /**
     * Private helper methods
     */

    #ensureDirectories() {
        if (!existsSync(this.#path)) {
            mkdirSync(this.#path, { recursive: true });
        }
        if (!existsSync(this.#dataPath)) {
            mkdirSync(this.#dataPath, { recursive: true });
        }
        if (!existsSync(this.#lockPath)) {
            mkdirSync(this.#lockPath, { recursive: true });
        }
    }

    #getFilePath(key) {
        // Sanitize key for filename
        const sanitized = this.#sanitizeKey(key);
        return path.join(this.#dataPath, sanitized + this.options.fileExtension);
    }

    #sanitizeKey(key) {
        // Convert key to safe filename
        if (typeof key === 'string') {
            return key.replace(/[^a-zA-Z0-9_-]/g, '_');
        }
        return String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    #readFile(filePath) {
        try {
            const data = readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return undefined;
            }
            throw new Error(`Failed to read file ${filePath}: ${error.message}`);
        }
    }

    #writeFile(filePath, data) {
        try {
            const jsonData = JSON.stringify(data, null, this.options.pretty ? 2 : 0);
            
            if (this.options.atomic) {
                // Atomic write using temporary file
                const tempFile = filePath + '.tmp.' + randomUUID();
                writeFileSync(tempFile, jsonData, 'utf8');
                
                // Atomic rename (sync version)
                renameSync(tempFile, filePath);
            } else {
                writeFileSync(filePath, jsonData, 'utf8');
            }
            
            return true;
        } catch (error) {
            throw new Error(`Failed to write file ${filePath}: ${error.message}`);
        }
    }

    #deleteFile(filePath) {
        try {
            unlinkSync(filePath);
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') {
                return false; // File doesn't exist
            }
            throw new Error(`Failed to delete file ${filePath}: ${error.message}`);
        }
    }

    #listFiles() {
        try {
            const files = readdirSync(this.#dataPath);
            return files
                .filter(file => file.endsWith(this.options.fileExtension))
                .map(file => file.replace(this.options.fileExtension, ''));
        } catch (error) {
            if (error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }

    async #backupDatabase() {
        const backupPath = this.#generateBackupFolderPath();
        
        try {
            await mkdirp(backupPath);
            debug(`Created backup folder "${backupPath}"`);
            
            // Copy all files to backup
            const files = await fs.readdir(this.#dataPath);
            for (const file of files) {
                const sourcePath = path.join(this.#dataPath, file);
                const destPath = path.join(backupPath, file);
                await fs.copyFile(sourcePath, destPath);
            }
            
            debug(`Backed up database "${this.#path}" to "${backupPath}"`);
        } catch (error) {
            debug(`Error occurred while backing up database: ${error.message}`);
            throw error;
        }
    }

    #generateBackupFolderPath() {
        const dateString = new Date().toISOString().split('T')[0].replace(/-/g, '');
        let backupFolderName = dateString;
        let backupFolderPath = path.join(this.backupOptions.backupPath, backupFolderName);

        let counter = 1;
        while (existsSync(backupFolderPath)) {
            backupFolderName = `${dateString}.${counter}`;
            backupFolderPath = path.join(this.backupOptions.backupPath, backupFolderName);
            counter++;
        }

        return backupFolderPath;
    }

    /**
     * Custom methods (matching LMDB interface)
     */

    get path() { return this.#path; }
    get backupPath() { return this.backupOptions.backupPath; }
    get name() { return this.#dataset; }
    get status() { return 'active'; }
    
    get stats() {
        const files = this.#listFiles();
        return {
            files: files.length,
            cacheSize: this.cache.size,
            path: this.#path,
            dataset: this.#dataset,
        };
    }

    listKeys() {
        return this.#listFiles();
    }

    listValues() {
        const keys = this.listKeys();
        return keys.map(key => this.get(key)).filter(value => value !== undefined);
    }

    listEntries() {
        const keys = this.listKeys();
        return keys.map(key => ({
            key,
            value: this.get(key)
        })).filter(entry => entry.value !== undefined);
    }

    createDataset(dataset, options = {}) {
        debug(`Creating new dataset "${dataset}" using options: ${JSON.stringify(options)}`);
        const datasetPath = path.join(this.#path, dataset);
        
        const datasetInstance = new FileBackend({
            path: this.#path,
            options: { ...this.options, ...options },
            open: true
        }, dataset);
        
        return datasetInstance;
    }

    /**
     * Map() like (sync) interface
     */

    clear() {
        try {
            const files = this.#listFiles();
            for (const key of files) {
                this.delete(key);
            }
            this.cache.clear();
            this.cacheTimestamps.clear();
            return true;
        } catch (error) {
            debug(`Error clearing dataset: ${error.message}`);
            return false;
        }
    }

    delete(key) {
        const filePath = this.#getFilePath(key);
        const result = this.#deleteFile(filePath);
        
        // Clear from cache
        this.cache.delete(key);
        this.cacheTimestamps.delete(key);
        
        return result;
    }

    entries() {
        // Return iterator-like object
        const entries = this.listEntries();
        return entries[Symbol.iterator]();
    }

    forEach(callback) {
        const entries = this.listEntries();
        entries.forEach(entry => callback(entry.value, entry.key, this));
    }

    get(key, options = {}) {
        // Check cache first
        if (this.cache.has(key)) {
            const cachedValue = this.cache.get(key);
            if (options.asBuffer) {
                return Buffer.from(JSON.stringify(cachedValue));
            }
            return cachedValue;
        }

        const filePath = this.#getFilePath(key);
        const value = this.#readFile(filePath);
        
        if (value !== undefined) {
            // Cache the value
            this.cache.set(key, value);
            this.cacheTimestamps.set(key, Date.now());
            
            // Manage cache size
            if (this.cache.size > this.options.maxCacheSize) {
                this.#evictOldestCacheEntry();
            }
        }
        
        if (options.asBuffer && value !== undefined) {
            return Buffer.from(JSON.stringify(value));
        }
        
        return value;
    }

    #evictOldestCacheEntry() {
        let oldest = null;
        let oldestTime = Infinity;
        
        for (const [key, timestamp] of this.cacheTimestamps.entries()) {
            if (timestamp < oldestTime) {
                oldestTime = timestamp;
                oldest = key;
            }
        }
        
        if (oldest) {
            this.cache.delete(oldest);
            this.cacheTimestamps.delete(oldest);
        }
    }

    has(key) {
        // Check cache first
        if (this.cache.has(key)) {
            return true;
        }
        
        const filePath = this.#getFilePath(key);
        return existsSync(filePath);
    }

    keys() {
        return this.listKeys()[Symbol.iterator]();
    }

    values() {
        return this.listValues()[Symbol.iterator]();
    }

    set(key, value) {
        const filePath = this.#getFilePath(key);
        const result = this.#writeFile(filePath, value);
        
        if (result) {
            // Update cache
            this.cache.set(key, value);
            this.cacheTimestamps.set(key, Date.now());
        }
        
        return result;
    }

    /**
     * Native methods (matching LMDB interface)
     */

    getEntry(key, options = {}) {
        const value = this.get(key, options);
        if (value === undefined) {
            return undefined;
        }
        return {
            key,
            value,
            version: 1 // Simple versioning
        };
    }

    getBinary(key) {
        const value = this.get(key);
        if (value === undefined) {
            return undefined;
        }
        return Buffer.from(JSON.stringify(value));
    }

    async getMany(keys, callback) {
        const results = keys.map(key => this.get(key));
        if (callback) {
            callback(null, results);
        }
        return results;
    }

    async put(key, value, version) {
        return this.set(key, value);
    }

    async remove(key) {
        return this.delete(key);
    }

    removeVersion(key, version) {
        // Simple implementation - ignore version for now
        return this.remove(key);
    }

    removeValue(key, value) {
        const currentValue = this.get(key);
        if (currentValue === value) {
            return this.remove(key);
        }
        return false;
    }

    putSync(key, value, version) {
        return this.set(key, value);
    }

    putSyncWithOptions(key, value, options = {}) {
        if (options.noOverwrite && this.has(key)) {
            return false;
        }
        return this.set(key, value);
    }

    async transaction(action) {
        // Simple transaction implementation
        this.#isTransaction = true;
        this.#transactionData.clear();
        this.#transactionDeletes.clear();
        
        try {
            const result = await action();
            
            // Commit transaction
            for (const [key, value] of this.#transactionData) {
                this.set(key, value);
            }
            
            for (const key of this.#transactionDeletes) {
                this.delete(key);
            }
            
            return result;
        } catch (error) {
            // Rollback - just clear transaction data
            this.#transactionData.clear();
            this.#transactionDeletes.clear();
            throw error;
        } finally {
            this.#isTransaction = false;
        }
    }

    transactionSync(action, flags) {
        // Synchronous version of transaction
        this.#isTransaction = true;
        this.#transactionData.clear();
        this.#transactionDeletes.clear();
        
        try {
            const result = action();
            
            // Commit transaction
            for (const [key, value] of this.#transactionData) {
                this.set(key, value);
            }
            
            for (const key of this.#transactionDeletes) {
                this.delete(key);
            }
            
            return result;
        } catch (error) {
            // Rollback - just clear transaction data
            this.#transactionData.clear();
            this.#transactionDeletes.clear();
            throw error;
        } finally {
            this.#isTransaction = false;
        }
    }

    ifNoExists(key, action) {
        if (!this.has(key)) {
            return action();
        }
        return false;
    }

    removeSync(key) {
        return this.delete(key);
    }

    removeValueSync(key, value) {
        return this.removeValue(key, value);
    }

    getValues(key, rangeOptions = {}) {
        // For file backend, this is just the single value
        const value = this.get(key);
        return value ? [value] : [];
    }

    getValuesCount(key, rangeOptions = {}) {
        return this.has(key) ? 1 : 0;
    }

    getKeys(rangeOptions = {}) {
        return this.listKeys();
    }

    getKeysCount(rangeOptions = {}) {
        return this.listKeys().length;
    }

    getRange(rangeOptions = {}) {
        return this.listEntries();
    }

    getCount(rangeOptions = {}) {
        return this.listKeys().length;
    }

    doesExist(key) {
        return this.has(key);
    }

    doesExistValue(key, value) {
        const currentValue = this.get(key);
        return currentValue === value;
    }

    doesExistVersion(key, version) {
        // Simple implementation - just check existence
        return this.has(key);
    }

    async drop() {
        // Remove all files in dataset
        try {
            const files = await fs.readdir(this.#dataPath);
            for (const file of files) {
                await fs.unlink(path.join(this.#dataPath, file));
            }
            debug(`Dropped dataset "${this.#dataset}"`);
            return true;
        } catch (error) {
            debug(`Error dropping dataset: ${error.message}`);
            return false;
        }
    }

    dropSync() {
        // Synchronous version of drop
        return this.clear();
    }

    getStats() {
        return this.stats;
    }

    async clearAsync() {
        return this.clear();
    }

    clearSync() {
        return this.clear();
    }

    async backup(backupPath, compact = true) {
        return this.#backupDatabase();
    }

    async close() {
        if (this.backupOptions.backupOnClose) {
            await this.#backupDatabase();
        }
        
        // Clear cache
        this.cache.clear();
        this.cacheTimestamps.clear();
        
        debug(`File backend closed for dataset "${this.#dataset}"`);
        return true;
    }
}

export default FileBackend;