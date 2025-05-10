'use strict';

export default class ChecksumIndex {

    constructor(dataset) {
        if (!dataset) { throw new Error('ChecksumIndex dataset required'); }
        this.dataset = dataset;
    }

    /**
     * Get the number of documents in the index
     * @returns {number} The number of documents in the index
     */
    getCount() {
        return this.dataset.getCount();
    }

    insert(checksum, id) {
        if (Array.isArray(checksum)) {
            for (const cs of checksum) {
                this.dataset.set(cs, id);
            }
        } else {
            this.dataset.set(checksum, id);
        }
        return true;
    }

    insertArray(checksumArray, id) {
        for (const checksum of checksumArray) {
            this.dataset.set(checksum, id);
        }
        return true;
    }

    async get(checksum) {
        if (!checksum) { throw new Error('Checksum is required'); }
        return await this.dataset.get(checksum);
    }

    async getId(checksum) {
        return await this.get(checksum);
    }

    async checksumToId(checksumString) {
        return await this.get(checksumString);
    }

    async checksumStringToId(checksumString) {
        return await this.get(checksumString);
    }

    delete(checksum) {
        if (!checksum) { throw new Error('Checksum is required'); }
        return this.dataset.delete(checksum);
    }

    deleteArray(checksumArray) {
        for (const checksum of checksumArray) {
            this.dataset.delete(checksum);
        }
        return true;
    }

    has(checksum) {
        return this.dataset.has(checksum);
    }

    async list(algorithm = 'sha256') {
        // Optimize by leveraging LMDB range queries.
        // Ensure algorithm prefix ends with a "/" so that it matches the key structure (e.g., "sha256/").
        const prefix = algorithm.endsWith('/') ? algorithm : algorithm + '/';
        const lowerBound = prefix;
        const upperBound = prefix + '\uffff'; // This ensures we cover all keys with the given prefix.

        const checksums = [];

        // Using "start" and "end" options per lmdb's range query API.
        for await (const { key } of this.dataset.getRange({ start: lowerBound, end: upperBound })) {
            checksums.push(key);
        }

        return checksums;
    }

    async listAll() {
        const checksums = [];
        for await (const { key } of this.dataset.getRange()) {
            checksums.push(key);
        }
        return checksums;
    }

    async checksumArrayToIds(algo, checksums) {
        if (!Array.isArray(checksums)) {
            throw new Error('Expected array of checksums');
        }

        return await Promise.all(
            checksums.map(checksum => this.checksumToId(checksum)),
        );
    }

    async checksumStringArrayToIds(checksums) {
        if (!Array.isArray(checksums)) {
            throw new Error('Expected array of checksums');
        }

        return await Promise.all(
            checksums.map(checksum => this.checksumStringToId(checksum)),
        );
    }

}
