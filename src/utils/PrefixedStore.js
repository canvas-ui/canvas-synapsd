'use strict';

export default class PrefixedStore {
    #store;
    #prefix;

    constructor(store, prefix) {
        if (!store) { throw new Error('Backing store required'); }
        if (!prefix || typeof prefix !== 'string') { throw new Error('Prefix string required'); }
        this.#store = store;
        this.#prefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    }

    get prefix() {
        return this.#prefix;
    }

    get(key) {
        return this.#store.get(this.#mapKey(key));
    }

    put(key, value, version) {
        return this.#store.put(this.#mapKey(key), value, version);
    }

    remove(key, version) {
        return this.#store.remove(this.#mapKey(key), version);
    }

    doesExist(key) {
        return this.#store.doesExist(this.#mapKey(key));
    }

    async *getKeys(rangeOptions = {}) {
        const mappedRange = this.#mapRange(rangeOptions);
        for await (const key of this.#store.getKeys(mappedRange)) {
            if (!String(key).startsWith(this.#prefix)) {
                continue;
            }
            yield String(key).slice(this.#prefix.length);
        }
    }

    #mapKey(key = '') {
        return `${this.#prefix}${String(key).replace(/^\/+/, '')}`;
    }

    #mapRange(rangeOptions = {}) {
        const start = rangeOptions.start == null ? '' : String(rangeOptions.start);
        const end = rangeOptions.end == null ? '\uffff' : String(rangeOptions.end);
        return {
            ...rangeOptions,
            start: this.#mapKey(start),
            end: this.#mapKey(end),
        };
    }
}
