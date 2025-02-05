'use strict';
export default class ChecksumIndex {

    constructor(store, cache = new Map()) {
        if (!store) { throw new Error('A Map() like store reference required'); }
        this.store = store;
        this.cache = cache;
    }

    get(checksum) {
        return this.store.get(checksum);
    }

    set(checksum, id) {
        return this.store.set(checksum, id);
    }

    delete(checksum) {
        return this.store.delete(checksum);
    }

    has(checksum) {
        return this.store.has(checksum);
    }

    list(algorithm = 'sha256') {
        return this.store.keys();
    }

}
