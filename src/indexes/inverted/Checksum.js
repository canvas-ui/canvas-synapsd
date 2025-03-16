'use strict';

export default class ChecksumIndex {

    constructor(backingStore) {
        if (!backingStore) { throw new Error('backingStore reference required'); }
        this.store = backingStore;
    }

    /**
     * Get the number of documents in the index
     * @returns {number} The number of documents in the index
     */
    getCount() {
        return this.store.getCount();
    }

    async insert(checksum, id) {
        return await this.store.set(checksum, id);
    }

    async insertArray(checksumArray, id) {
        if (!Array.isArray(checksumArray)) { checksumArray = [checksumArray]; }
        for (const checksum of checksumArray) {
            await this.store.set(checksum, id);
        }
    }

    async delete(checksum) {
        return this.store.delete(checksum);
    }

    async deleteArray(checksumArray) {
        if (!Array.isArray(checksumArray)) { checksumArray = [checksumArray]; }
        for (const checksum of checksumArray) {
            await this.store.delete(checksum);
        }
    }

    async has(checksum) {
        return this.store.has(checksum);
    }

    async list(algorithm = 'sha256') {
        // Optimize by leveraging LMDB range queries.
        // Ensure algorithm prefix ends with a "/" so that it matches the key structure (e.g., "sha256/").
        const prefix = algorithm.endsWith('/') ? algorithm : algorithm + '/';
        const lowerBound = prefix;
        const upperBound = prefix + '\uffff'; // This ensures we cover all keys with the given prefix.

        const checksums = [];

        // Using "start" and "end" options per lmdb's range query API.
        for await (const { key } of this.store.getRange({ start: lowerBound, end: upperBound })) {
            checksums.push(key);
        }

        return checksums;
    }

    async listAll() {
        const checksums = [];
        for await (const { key } of this.store.getRange()) {
            checksums.push(key);
        }
        return checksums;
    }

    async checksumToId(algo, checksum) {
        if (!algo || !checksum) {
            throw new Error('Algorithm and checksum are required');
        }

        return await this.store.get(`${algo}/${checksum}`);
    }

    async checksumStringToId(checksum) {
        if (typeof checksum !== 'string') {
            throw new Error('Checksum must be a string');
        }

        return await this.store.get(checksum);
    }

    async checksumArrayToIds(algo, checksums) {
        if (!Array.isArray(checksums)) {
            throw new Error('Expected array of checksums');
        }

        return await Promise.all(
            checksums.map(checksum => this.checksumToId(algo, checksum))
        );
    }

    async checksumStringArrayToIds(checksums) {
        if (!Array.isArray(checksums)) {
            throw new Error('Expected array of checksums');
        }

        return await Promise.all(
            checksums.map(checksum => this.checksumStringToId(checksum))
        );
    }

}
