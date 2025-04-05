import { Index } from 'flexsearch';
import { promises as fs } from 'fs';

import debugInstance from 'debug';
const debug = debugInstance('synapsd:index:fts');

class Fts {

    #store;
    #options;

    constructor(backingStore, indexOptions = {
        preset: 'performance',
        tokenize: 'forward',
        cache: true,
    }) {
        if (!backingStore) { throw new Error('Map() - like backingStore is required'); }
        this.#store = backingStore;
        this.#options = indexOptions;
        // https://github.com/nextapps-de/flexsearch
        this.index = Index(this.#options);
        this.loadIndex();
    }

    async insert(id, str) {
        if (!id || !str) { return false; }
        if (typeof str === 'string') { str = [str]; }
        if (str.length === 0) { return false; }

        for (const input of str) {
            await this.index.addAsync(id, input); // Uses update internally anyway
        }

        await this.saveIndex();
    }

    async update(id, str) {
        await this.remove(id);
        await this.insert(id, str);
    }

    async remove(id) {
        await this.index.removeAsync(id);
        await this.saveIndex();
    }

    async search(query, limit = 100) {
        const results = await this.index.searchAsync(query, limit);
        return results;
    }

    searchSync(query, limit = 100) {
        // TODO: Current backend does not support searching on a subset of documents
        // We can get those cheaply, so a nice task for whoever picks this up
        return this.index.search(query, limit);
    }

    /**
     * Utils
     */

    async loadIndex() {
        const data = await this.#store.get('index');
        if (!data) {
            debug('No existing index found. Starting with an empty index.');
            return;
        }
        this.index.import(data);
    }

    async loadIndexFromFile() {
        try {
            const data = await fs.readFile(this.indexPath, 'utf8');
            const dump = JSON.parse(data);
            await this.index.import(dump);
            debug('Index loaded successfully');
        } catch (error) {
            if (error.code === 'ENOENT') {
                debug('No existing index found. Starting with an empty index.');
            } else {
                debug('Error loading index:', error);
            }
        }
    }

    async saveIndex() {
        const dump = this.index.export();
        await this.#store.put('index', dump);
    }

    async saveIndexToFile() {
        try {
            const dump = await this.index.export();
            await fs.writeFile(this.indexPath, JSON.stringify(dump));
            debug('Index saved successfully');
        } catch (error) {
            debug('Error saving index:', error);
        }
    }
}

export default Fts;
