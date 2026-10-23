'use strict';

// Utils
import path from 'path';
import DatabaseBackups from '../../backups/DatabaseBackups.js';

import debugInstance from 'debug';
const debug = debugInstance('canvas:service:synapsd:lmdb');

// Database backend
import { open } from 'lmdb';

/**
 * Canvas LMDB wrapper, originally LevelDB
 */

// Writes issued once close() has begun would reach LMDB after its environment
// is gone: they fail inside lmdb's commit timer as an uncaught exception and
// their promise never settles. The wrapper refuses them up front instead.
const closedError = () => Object.assign(new Error('Database is closed'), { code: 'DB_CLOSED' });

class Db {

    #dataset = 'default';
    #path;
    #datasets = new Set();
    // Shared by the root handle and every dataset opened from it.
    #lifecycle = { closing: false };

    // TODO: Wrap versioning support
    // TODO: Extend using openAsClass()
    constructor(options, dataset) {

        // Parse input arguments
        if (options.open === undefined) {
            // Let's make path a required option
            if (!options.path) { throw new Error('LMDB database path not provided'); }

            options = {
                // Database paths
                path: options.path,
                backupPath: options.backupPath ?? path.join(options.path, 'backup'),

                // Verified checkpoints; startup and hourly retention are independent.
                backupOnOpen: options.backupOnOpen ?? true,
                backupOnClose: options.backupOnClose ?? false,

                // Internals
                maxDbs: options.maxDbs ?? 64,
                readOnly: options.readOnly ?? false,
                logLevel: options.logLevel ?? 'info',
                compression: options.compression ?? true,
                cache: options.cache ?? true,
                strictAsyncOrder: options.strictAsyncOrder ?? true, // Ensure strict ordering for document ID generation
                // keyEncoding: options.keyEncoding || 'uint32',// ?ordered-binary
                // encoding: options.encoding || 'binary',
                // useVersions: options.useVersions || false,
                ...options,
            };

            this.db = new open(options);
            debug(`LMDB database backend at "${options.path} initialized"`);
        } else {
            this.db = options;
            this.#dataset = dataset;
            // Ensure no debug log here related to dataset name initialization
            debug(`LMDB dataset "${dataset}" initialized`);
        }

        // Set the db path in the wrapper class
        this.#path = options.path;

        // This is unfortunate
        this.backupOptions = {
            backupPath: options.backupPath,
            backupOnOpen: options.backupOnOpen,
            backupOnClose: options.backupOnClose,
            compact: options.backupCompact,
            backupRetentionDays: options.backupRetentionDays,
            maxBackupRetention: options.maxBackupRetention,
        };

        if (this.db && dataset) { // Check if it's a dataset instance
            this.#dataset = dataset;
        }

        this.ready = this.backupOptions.backupOnOpen
            ? new DatabaseBackups(this.#path, { backupPath: this.backupPath }).create('startup')
            : Promise.resolve();
        // Callers can await ready; never create an unhandled rejection when a
        // constructor is used without start(). close() still awaits the worker.
        this.ready.catch(error => debug(`Startup backup failed: ${error.message}`));

    }

    /**
     * Custom methods
     */

    get path() { return this.#path; }
    get backupPath() { return this.backupOptions.backupPath; }

    // Getter for the dataset name
    get name() { return this.#dataset; }

    // Returns the status of the underlying database / dataset
    get status() { return this.db.status; }

    // Returns stats of the underlying database / dataset
    get stats() { return this.db.getStats(); }
    async flush() { await this.db.flushed; }

    listKeys() {
        const keys = [];
        this.db.getKeys().forEach(element => {
            keys.push(element);
        });
        return keys;
    }

    listValues() {
        const values = [];
        this.db.getRange().forEach(element => {
            values.push(element.value);
        });
        return values;
    }

    listEntries() {
        const entries = [];
        this.db.getRange().forEach(element => {
            entries.push(element);
        });
        return entries;
    }

    // Creates a new dataset using the same wrapper class
    createDataset(dataset, options = {}) {
        debug(`Creating new dataset "${dataset}" using options: ${JSON.stringify(options)}`);

        // Ensure strictAsyncOrder is enabled for datasets as well
        const datasetOptions = {
            strictAsyncOrder: true, // Required for document ID generation consistency
            ...options,
        };

        const db = this.db.openDB(dataset, datasetOptions);
        if (!db) { return undefined; } // read-only/create:false: never create missing datasets
        const wrapped = new Db(db, dataset);
        wrapped.#lifecycle = this.#lifecycle;
        this.#datasets.add(wrapped);
        return wrapped;
    }

    // Compatibility surface for key/value consumers. Always return a SynapsD
    // dataset wrapper; native handles stay in the database package.
    openDB(name, options = {}) {
        if (name && typeof name === 'object') {
            const { name: dataset, ...settings } = name;
            return this.createDataset(dataset, settings);
        }
        return this.createDataset(name, options);
    }


    /**
     * Map() like (sync) interface
     */

    clear() { this.#writable(); return this.db.clearSync(); }

    delete(key) { this.#writable(); return this.db.removeSync(key); }

    entries() { return this.db.getRange(); }    // Iterator

    forEach() { /* TODO */ }

    // get(key) { return this.db.get(key); }    // Using native LMDB method

    has(key) { return this.db.doesExist(key); } // bool

    keys() { return this.db.getKeys(); }        // Iterator

    values() { return this.listValues(); }   // TODO: Fixme

    set(key, value) { this.#writable(); return this.db.putSync(key, value); }


    /**
     * Native LMDB methods (small subset)
     */

    /**
    * Get the value stored by given id/key
    * @param key The key for the entry
    * @param options Additional options for the retrieval
    **/
    get(key, options) { return this.db.get(key, options); }

    /**
    * Get the entry stored by given id/key, which includes both the value and the version number (if available)
    * @param key The key for the entry
    * @param options Additional options for the retrieval
    **/
    getEntry(key, options) { return this.db.getEntry(key, options); }

    /**
    * Get the value stored by given id/key in binary format, as a Buffer
    * @param key The key for the entry
    **/
    getBinary(key) { return this.db.getBinary(key); }

    /**
    * Asynchronously get the values stored by the given ids and return the
    * values in array corresponding to the array of keys.
    * @param keys The keys for the entries to get
    **/
    getMany(keys, cb){ return this.db.getMany(keys, cb); }

    /**
    * (async) Store the provided value, using the provided id/key
    * @param key The key for the entry
    * @param value The value to store
    * @param version The version number to assign to this entry
    **/
    put(key, value, version) { return this.#closed() ?? this.db.put(key, value, version); }

    /**
    * (async) Remove the entry with the provided id/key, conditionally based on the provided existing version number
    * @param key The key for the entry to remove
    **/
    remove(key) { return this.#closed() ?? this.db.remove(key); }

    /**
    * Remove the entry with the provided id/key, conditionally based on the provided existing version number
    * @param key The key for the entry to remove
    * @param version If provided the remove will only succeed if the previous version number matches this (atomically checked)
    **/
    removeVersion(key, version) {
        if (version === undefined) {throw new Error('Version must be provided');}
        return this.#closed() ?? this.db.remove(key, version);
    }

    /**
    * Remove the entry with the provided id/key and value (mainly used for dupsort databases) and optionally the required
    * existing version
    * @param key The key for the entry to remove
    * @param value The value for the entry to remove
    **/
    removeValue(key, value) { return this.#closed() ?? this.db.remove(key, value); }

    /**
    * Synchronously store the provided value, using the provided id/key, will return after the data has been written.
    * @param key The key for the entry
    * @param value The value to store
    * @param version The version number to assign to this entry
    **/
    putSync(key, value, version) { this.#writable(); return this.db.putSync(key, value, version); }

    /**
    * Synchronously store the provided value with options
    * @param key The key for the entry
    * @param value The value to store
    * @param options The options for the put operation (including noOverwrite, version, etc.)
    **/
    putSyncWithOptions(key, value, options = {}) { this.#writable(); return this.db.putSync(key, value, options); }

    /**
    * Execute a transaction asynchronously
    * @param action The function to execute within the transaction
    **/
    async transaction(action) {
        this.#writable();
        // LMDB transaction() batches callbacks but does not roll back their
        // earlier writes on a throw. An abortable child transaction does.
        try {
            return await this.db.childTransaction(action);
        } catch (error) {
            // Native caching tracks the root handle's child transaction, but
            // writes also touch named datasets in the same environment.
            this.#invalidateCaches();
            throw error;
        }
    }

    #writable() { if (this.#lifecycle.closing) { throw closedError(); } }

    #closed() { return this.#lifecycle.closing ? Promise.reject(closedError()) : null; }

    #invalidateCaches() {
        this.db.cache?.clear();
        for (const dataset of this.#datasets) { dataset.#invalidateCaches(); }
    }

    /**
    * Execute a transaction synchronously
    * @param action The function to execute within the transaction
    * @param flags Additional flags specifying transaction behavior
    **/
    transactionSync(action, flags) { this.#writable(); return this.db.transactionSync(action, flags); }

    /**
    * Execute writes conditionally if the key doesn't exist
    * @param key Key to check for non-existence
    * @param action Function to execute if key doesn't exist
    **/
    ifNoExists(key, action) { return this.#closed() ?? this.db.ifNoExists(key, action); }

    /**
    * Synchronously remove the entry with the provided id/key
    * existing version
    * @param key The key for the entry to remove
    **/
    removeSync(key) { this.#writable(); return this.db.removeSync(key); }

    /**
    * Synchronously remove the entry with the provided id/key and value (mainly used for dupsort databases)
    * existing version
    * @param key The key for the entry to remove
    * @param value The value for the entry to remove
    **/
    removeValueSync(key, value) { this.#writable(); return this.db.removeSync(key, value); }

    /**
    * Get all the values for the given key (for dupsort databases)
    * existing version
    * @param key The key for the entry to remove
    * @param rangeOptions The options for the iterator
    **/
    getValues(key, rangeOptions) { return this.db.getValues(key, rangeOptions); }

    /**
    * Get the count of all the values for the given key (for dupsort databases)
    * existing version
    * @param key The key for the entry to remove
    * @param rangeOptions The options for the range/iterator
    **/
    getValuesCount(key, rangeOptions) { return this.db.getValuesCount(key, rangeOptions); }

    /**
    * Get all the unique keys for the given range
    * existing version
    * @param rangeOptions The options for the range/iterator
    **/
    getKeys(rangeOptions) { return this.db.getKeys(rangeOptions); }

    /**
    * Get the count of all the unique keys for the given range
    * existing version
    * @param rangeOptions The options for the range/iterator
    **/
    getKeysCount(rangeOptions) { return this.db.getKeysCount(rangeOptions); }

    /**
    * Get all the entries for the given range
    * existing version
    * @param rangeOptions The options for the range/iterator
    **/
    getRange(rangeOptions) { return this.db.getRange(rangeOptions); }

    /**
    * Get the count of all the entries for the given range
    * existing version
    * @param rangeOptions The options for the range/iterator
    **/
    getCount(rangeOptions) { return this.db.getCount(rangeOptions); }

    /**
    * Check if an entry for the provided key exists
    * @param key Key of the entry to check
    */
    doesExist(key) { return this.db.doesExist(key); }

    /**
    * Check if an entry for the provided key/value exists
    * @param id Key of the entry to check
    * @param value Value of the entry to check
    */
    doesExistValue(key, value) { return this.db.doesExist(key, value); }

    /**
    * Check if an entry for the provided key exists with the expected version
    * @param key Key of the entry to check
    * @param version Expected version
    */
    doesExistVersion(key, version) { return this.db.doesExist(key, version); }

    /**
    * Delete this database/store (asynchronously).
    **/
    drop() { return this.#closed() ?? this.db.drop(); }

    /**
    * Synchronously delete this database/store.
    **/
    dropSync() { this.#writable(); return this.db.dropSync(); }

    /**
    * Returns statistics about the current database
    **/
    getStats() { return this.db.getStats(); }

    /**
    * Asynchronously clear all the entries from this database/store.
    **/
    clearAsync() { return this.#closed() ?? this.db.clearAsync(); }

    /**
    * Synchronously clear all the entries from this database/store.
    **/
    clearSync() { this.#writable(); return this.db.clearSync(); }

    /**
    * Make a snapshot copy of the current database at the indicated path
    * @param path Path to store the backup
    * @param compact Apply compaction while making the backup (slower and smaller)
    **/
    backup(path, compact = true) { return this.db.backup(path, compact); }

    /**
    * Close the current database.
    **/
    async close() {
        this.#lifecycle.closing = true;
        try {
            if (this.backupOptions.backupOnOpen) { await this.ready; }
            if (this.backupOptions.backupOnClose) {
                await new DatabaseBackups(this.#path, { backupPath: this.backupPath }).create('manual');
            }
        } finally { await this.db.close(); }
    }
}

export default Db;
