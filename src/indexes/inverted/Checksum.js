'use strict';
export default class ChecksumIndex {

    constructor(options = {}) {
        if (!options.store) { throw new Error('A Map() like store reference required'); }
        this.store = options.store
    }

    async get(checksum) {
        return this.store.get(checksum);
    }

    async set(checksum, id) {
        this.store.set(checksum, id);
    }

    async delete(checksum) {
        return this.store.delete(checksum);
    }

    async has(checksum) {
        return this.store.has(checksum);
    }

    async list(algorithm = 'sha256') {
        return this.store.keys();
    }

}
