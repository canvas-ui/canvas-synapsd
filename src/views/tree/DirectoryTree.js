'use strict';

import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:directory-tree');

/**
 * DirectoryTree - Traditional VFS directory abstraction
 *
 * Unlike ContextTree (where /foo/bar does AND of shared layers "foo" and "bar"),
 * DirectoryTree gives each full path its own unique bitmap.
 *
 * - Document at /projects/canvas → bitmap key vfs/projects/canvas
 * - find('/projects/canvas') → single bitmap lookup (ls semantics)
 * - findRecursive('/projects') → OR of all vfs/projects/* bitmaps (find semantics)
 * - listDirectories('/projects') → prefix scan, extract unique next-level segments
 *
 * Leverages BitmapCollection's prefix-based listBitmaps() which uses LMDB range queries.
 */
class DirectoryTree {

    #collection;

    constructor(bitmapIndex, options = {}) {
        if (!bitmapIndex) { throw new Error('BitmapIndex required'); }
        this.#collection = bitmapIndex.createCollection(options.prefix || 'vfs');
    }

    get collection() { return this.#collection; }

    // =========================================================================
    // Document operations
    // =========================================================================

    /**
     * Insert a document into a specific directory path
     * @param {number} oid - Document OID
     * @param {string} path - Directory path (e.g., '/projects/canvas')
     */
    async insertDocument(oid, path) {
        const key = this.#pathToKey(path);
        if (!key) { return; }
        await this.#collection.tick(key, oid);
        debug(`insertDocument: doc ${oid} → ${key}`);
    }

    /**
     * Insert a document into multiple directory paths.
     * Returns full bitmap store keys for synapse tracking.
     * @param {number} oid - Document OID
     * @param {Array<string>} pathArray - Array of directory paths
     * @returns {Array<string>} Full bitmap keys that were ticked
     */
    async insertDocumentMany(oid, pathArray) {
        if (!Array.isArray(pathArray)) { pathArray = [pathArray]; }
        const keys = pathArray.map(p => this.#pathToKey(p)).filter(Boolean);
        if (keys.length === 0) { return []; }
        await this.#collection.tickMany(keys, oid);
        debug(`insertDocumentMany: doc ${oid} → ${keys.length} paths`);
        return keys.map(k => this.#collection.makeKey(k));
    }

    /**
     * Remove a document from a specific directory
     * @param {number} oid - Document OID
     * @param {string} path - Directory path
     */
    async removeDocument(oid, path) {
        const key = this.#pathToKey(path);
        if (!key) { return; }
        await this.#collection.untick(key, oid);
        debug(`removeDocument: doc ${oid} from ${key}`);
    }

    /**
     * Delete a document from the entire directory tree (all directories)
     * @param {number} oid - Document OID
     */
    async deleteDocument(oid) {
        const allKeys = await this.#collection.listBitmaps();
        if (allKeys.length === 0) { return; }
        const relativeKeys = allKeys.map(k => k.replace(this.#collection.prefix, ''));
        await this.#collection.untickMany(relativeKeys, oid);
        debug(`deleteDocument: doc ${oid} from ${allKeys.length} directories`);
    }

    // =========================================================================
    // Querying
    // =========================================================================

    /**
     * Find documents in an exact directory path (ls semantics)
     * @param {string} path - Directory path
     * @returns {RoaringBitmap32|null} Bitmap of matching OIDs
     */
    async find(path) {
        const key = this.#pathToKey(path);
        if (!key) { return null; }
        return await this.#collection.getBitmap(key, false);
    }

    /**
     * Find documents in a directory and all subdirectories (find semantics)
     * @param {string} path - Directory path prefix
     * @returns {RoaringBitmap32} Union bitmap of all matching OIDs
     */
    async findRecursive(path) {
        const prefix = this.#pathToKey(path);
        if (!prefix) {
            // Root recursive = everything
            const allKeys = await this.#collection.listBitmaps();
            const relKeys = allKeys.map(k => k.replace(this.#collection.prefix, ''));
            return relKeys.length > 0 ? await this.#collection.OR(relKeys) : null;
        }

        // Get all bitmaps under this prefix
        const bitmapIndex = this.#collection.bitmapIndex;
        const fullPrefix = this.#collection.prefix + prefix;

        const keys = [];
        for await (const key of bitmapIndex.dataset.getKeys({
            start: fullPrefix,
            end: fullPrefix + '\uffff',
        })) { keys.push(key); }

        // Also include the exact path bitmap itself
        const exactKey = this.#collection.prefix + prefix;
        if (bitmapIndex.hasBitmap(exactKey) && !keys.includes(exactKey)) {
            keys.unshift(exactKey);
        }

        if (keys.length === 0) { return null; }

        // OR all matching bitmaps directly via bitmapIndex (keys already have full prefix)
        return await bitmapIndex.OR(keys);
    }

    // =========================================================================
    // Directory management
    // =========================================================================

    /**
     * List child directories under a parent path
     * @param {string} parentPath - Parent directory path
     * @returns {Array<string>} Array of child directory names
     */
    async listDirectories(parentPath = '/') {
        const prefix = this.#pathToKey(parentPath);
        const searchPrefix = prefix ? `${prefix}/` : '';
        const fullSearchPrefix = this.#collection.prefix + searchPrefix;

        const keys = [];
        for await (const key of this.#collection.bitmapIndex.dataset.getKeys({
            start: fullSearchPrefix,
            end: fullSearchPrefix + '\uffff',
        })) { keys.push(key); }

        // Extract unique next-level segments
        const segments = new Set();
        const prefixLen = fullSearchPrefix.length;
        for (const key of keys) {
            const remainder = key.slice(prefixLen);
            const nextSegment = remainder.split('/')[0];
            if (nextSegment) { segments.add(nextSegment); }
        }

        return Array.from(segments).sort();
    }

    /**
     * Move a directory (batch rename all bitmap keys under the path)
     * @param {string} from - Source path
     * @param {string} to - Destination path
     */
    async moveDirectory(from, to) {
        const fromKey = this.#pathToKey(from);
        const toKey = this.#pathToKey(to);
        if (!fromKey || !toKey) { throw new Error('Invalid paths for move'); }

        const bitmapIndex = this.#collection.bitmapIndex;
        const fullFromPrefix = this.#collection.prefix + fromKey;

        const keys = [];
        for await (const key of bitmapIndex.dataset.getKeys({
            start: fullFromPrefix,
            end: fullFromPrefix + '\uffff',
        })) { keys.push(key); }

        // Also include exact path
        if (bitmapIndex.hasBitmap(fullFromPrefix) && !keys.includes(fullFromPrefix)) {
            keys.unshift(fullFromPrefix);
        }

        for (const oldFullKey of keys) {
            const suffix = oldFullKey.slice(fullFromPrefix.length);
            const newFullKey = this.#collection.prefix + toKey + suffix;
            await bitmapIndex.renameBitmap(oldFullKey, newFullKey);
        }

        debug(`moveDirectory: ${from} → ${to} (${keys.length} bitmaps)`);
    }

    /**
     * Delete a directory and optionally all subdirectories
     * @param {string} path - Directory path
     * @param {boolean} recursive - Delete subdirectories too
     */
    async deleteDirectory(path, recursive = false) {
        const key = this.#pathToKey(path);
        if (!key) { return; }

        const bitmapIndex = this.#collection.bitmapIndex;

        if (recursive) {
            const fullPrefix = this.#collection.prefix + key;
            const keys = [];
            for await (const k of bitmapIndex.dataset.getKeys({
                start: fullPrefix,
                end: fullPrefix + '\uffff',
            })) { keys.push(k); }

            if (bitmapIndex.hasBitmap(fullPrefix)) { keys.unshift(fullPrefix); }

            for (const k of keys) {
                await bitmapIndex.deleteBitmap(k);
            }
            debug(`deleteDirectory: ${path} (recursive, ${keys.length} bitmaps)`);
        } else {
            const fullKey = this.#collection.prefix + key;
            if (bitmapIndex.hasBitmap(fullKey)) {
                await bitmapIndex.deleteBitmap(fullKey);
            }
            debug(`deleteDirectory: ${path}`);
        }
    }

    /**
     * Check if a directory path exists (has any documents)
     * @param {string} path
     * @returns {boolean}
     */
    pathExists(path) {
        const key = this.#pathToKey(path);
        if (!key) { return false; }
        return this.#collection.hasBitmap(key);
    }

    // =========================================================================
    // Private
    // =========================================================================

    /**
     * Convert a path string to a normalized bitmap key segment
     * @param {string} pathStr
     * @returns {string} Key segment without leading/trailing slashes
     */
    #pathToKey(pathStr) {
        if (!pathStr || pathStr === '/') { return ''; }
        return String(pathStr)
            .replace(/\\/g, '/')
            .replace(/\/+/g, '/')
            .replace(/^\//, '')
            .replace(/\/$/, '')
            .toLowerCase()
            .replace(/[^a-z0-9_\-./]/g, '_')
            .replace(/_+/g, '_');
    }
}

export default DirectoryTree;
