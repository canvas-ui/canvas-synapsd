'use strict';

export default class ChecksumIndex {

    constructor(options = {}) {
        if (!options.store) { throw new Error('A Map() like store reference required'); }
        this.store = options.store
    }

    async get(checksum) {
        console.log('ChecksumIndex.get called with:', checksum);
        const result = this.store.get(checksum);
        console.log('ChecksumIndex.get result:', result);
        return result;
    }

    async set(checksum, id) {
        console.log('ChecksumIndex.set called with:', checksum, id);
        this.store.set(checksum, id);
        console.log('ChecksumIndex.set completed');
    }

    async delete(checksum) {
        return this.store.delete(checksum);
    }

    async has(checksum) {
        return this.store.has(checksum);
    }

    // Meant for testing purposes
    async listChecksums(algorithm = 'sha256') {
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

}
