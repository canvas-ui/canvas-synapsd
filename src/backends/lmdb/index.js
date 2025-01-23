'use strict';

// Utils
import path from 'path';
import fs from 'fs';
import { mkdirp } from 'mkdirp'
import debugMessage from 'debug';
const debug = debugMessage('canvas-synapsd:backend:lmdb');

// Database backend
import { open } from 'lmdb';

/**
 * Canvas LMDB wrapper, originally LevelDB
 */

class Db {

    #dataset = 'default';
    #path;

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
                backupPath: options.backupPath || path.join(options.path, 'backup'),

                // Backup options
                backupOnOpen: options.backupOnOpen || false,
                backupOnClose: options.backupOnClose || false,

                // Internals
                maxDbs: options.maxDbs || 64,
                readOnly: options.readOnly || false,
                logLevel: options.logLevel || 'info',
                compression: options.compression || true,
                cache: options.cache || true,
                // keyEncoding: options.keyEncoding || 'uint32',// ?ordered-binary
                // encoding: options.encoding || 'binary',
                // useVersions: options.useVersions || false,
                ...options,
            };

            this.db = new open(options);
            debug(`Initialized LMDB database backend at "${options.path}"`);
        } else {
            this.db = options;
            this.#dataset = dataset;
            debug(`Initialized LMDB dataset "${dataset}"`);
        }

        // Set the db path in the wrapper class
        this.#path = options.path;

        // This is unfortunate
        this.backupOptions = {
            backupPath: options.backupPath,
            backupOnOpen: options.backupOnOpen,
            backupOnClose: options.backupOnClose,
            compact: options.backupCompact,
        };

        // This is even more so
        if (this.backupOptions.backupOnOpen) {
            // TODO: Check if the database changed from the last backup
            this.#backupDatabase( /* we always compact the db */ );
        }

    }

    /**
     * Custom methods
     */

    get path() { return this.#path; }
    get backupPath() { return this.backupOptions.backupPath; }

    // Returns the status of the underlying database / dataset
    get status() { return this.db.status; }

    // Returns stats of the underlying database / dataset
    get stats() { return this.db.getStats(); }

    listKeys() {
        let keys = [];
        this.db.getKeys().forEach(element => {
            keys.push(element);
        });
        return keys;
    }

    listValues() {
        let values = [];
        this.db.getRange().forEach(element => {
            values.push(element.value);
        });
        return values;
    }

    listEntries() {
        let entries = [];
        this.db.getRange().forEach(element => {
            entries.push(element);
        });
        return entries;
    }

    // Creates a new dataset using the same wrapper class
    createDataset(dataset, options = {}) {
        debug(`Creating new dataset "${dataset}" using options: ${JSON.stringify(options)}`);
        let db = this.db.openDB(dataset, options);
        return new Db(db, dataset);
    }


    /**
     * Map() like (sync) interface
     */

    clear() { return this.db.clearSync(); }

    delete(key) { return this.db.removeSync(key); }

    entries() { return this.db.getRange(); }    // Iterator

    forEach() { /* TODO */ }

    // get(key) { return this.db.get(key); }    // Using native LMDB method

    has(key) { return this.db.doesExist(key); } // bool

    keys() { return this.db.getKeys(); }        // Iterator

    values() { return this.listValues(); }   // TODO: Fixme

    set(key, value) { return this.db.putSync(key, value); }


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
    put(key, value, version) { return this.db.put(key, value, version); }

    /**
    * (async) Remove the entry with the provided id/key, conditionally based on the provided existing version number
    * @param key The key for the entry to remove
    **/
    remove(key) { return this.db.remove(key); }

    /**
    * Remove the entry with the provided id/key, conditionally based on the provided existing version number
    * @param key The key for the entry to remove
    * @param version If provided the remove will only succeed if the previous version number matches this (atomically checked)
    **/
    removeVersion(key, version) {
        if (version === undefined) {throw new Error('Version must be provided');}
        return this.db.remove(key, version);
    }

    /**
    * Remove the entry with the provided id/key and value (mainly used for dupsort databases) and optionally the required
    * existing version
    * @param key The key for the entry to remove
    * @param value The value for the entry to remove
    **/
    removeValue(key, value) { return this.db.remove(key, value); }

    /**
    * Synchronously store the provided value, using the provided id/key, will return after the data has been written.
    * @param key The key for the entry
    * @param value The value to store
    * @param version The version number to assign to this entry
    **/
    putSync(key, value, version) { return this.db.putSync(key, value, version); }


    /**
    * Synchronously remove the entry with the provided id/key
    * existing version
    * @param key The key for the entry to remove
    **/
    removeSync(key) { return this.db.removeSync(key); }

    /**
    * Synchronously remove the entry with the provided id/key and value (mainly used for dupsort databases)
    * existing version
    * @param key The key for the entry to remove
    * @param value The value for the entry to remove
    **/
    removeValueSync(key, value) { return this.db.removeSync(key, value); }

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
    drop() { return this.db.drop(); }

    /**
    * Synchronously delete this database/store.
    **/
    dropSync() { return this.db.dropSync(); }

    /**
    * Returns statistics about the current database
    **/
    getStats() { return this.db.getStats(); }

    /**
    * Asynchronously clear all the entries from this database/store.
    **/
    clearAsync() { return this.db.clearAsync(); }

    /**
    * Synchronously clear all the entries from this database/store.
    **/
    clearSync() { return this.db.clearSync(); }

    /**
    * Make a snapshot copy of the current database at the indicated path
    * @param path Path to store the backup
    * @param compact Apply compaction while making the backup (slower and smaller)
    **/
    backup(path, compact = true) { return this.db.backup(path, compact); }

    /**
    * Close the current database.
    **/
    close() { return this.db.close(); }


    /**
     * Internal methods
     */

    #backupDatabase(compact = true) {
        const backupPath = this.#generateBackupFolderPath();

        // Create the backup folder
        try {
            mkdirp.sync(backupPath);
            debug(`Created backup folder "${backupPath}"`);
        } catch (error) {
            debug(`Error occurred while creating backup folder: ${error.message}`);
            throw error;
        }

        debug(`Backing up database "${this.#path}" to "${backupPath}"`);
        // TODO: Rework, backup() is async
        this.db.backup(backupPath, compact);
    }

    #generateBackupFolderPath() {
        const dateString = new Date().toISOString().split('T')[0].replace(/-/g, '');
        let backupFolderName = dateString;
        let backupFolderPath = path.join(this.backupOptions.backupPath, backupFolderName);

        let counter = 1;
        while (fs.existsSync(backupFolderPath)) {
            backupFolderName = `${dateString}.${counter}`;
            backupFolderPath = path.join(this.backupOptions.backupPath, backupFolderName);
            counter++;
        }

        return backupFolderPath;
    }

}

export default Db;
