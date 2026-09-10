'use strict';

import { ulid } from 'ulid';
import debugInstance from 'debug';
import PrefixedStore from '../utils/PrefixedStore.js';
import { EVENTS, createEvent } from '../utils/events.js';

const debug = debugInstance('canvas:synapsd');

// Owns tree metadata, defaults, cached instances, selection, and forwarding.
export default class TreeRegistry {
    #internalStore;
    #bitmapIndex;
    #createTreeInstance;
    #publish;
    #onContextCollection;
    #treeCache = new Map();
    #treeMetadata = new Map();
    #defaultTreeIds = { context: null, directory: null };

    constructor({ internalStore, bitmapIndex, createTreeInstance, publish, onContextCollection }) {
        this.#internalStore = internalStore;
        this.#bitmapIndex = bitmapIndex;
        this.#createTreeInstance = createTreeInstance;
        this.#publish = publish;
        this.#onContextCollection = onContextCollection;
    }

    async initialize() {
        await this.#loadTreeRegistry();
        await this.#ensureDefaultTrees();
    }

    metadata() { return this.#treeMetadata.values(); }

    async reloadCached() {
        for (const tree of this.#treeCache.values()) { await tree.reload(); }
    }


    async listTrees(type = null) {
        const trees = Array.from(this.#treeMetadata.values());
        return type ? trees.filter((tree) => tree.type === type) : trees;
    }

    getTree(nameOrId) {
        if (!nameOrId) {
            return null;
        }

        const directMatch = this.#treeMetadata.get(String(nameOrId));
        if (directMatch) {
            return this.#instantiateTree(directMatch);
        }

        const normalized = this.#normalizeTreeName(nameOrId);
        for (const meta of this.#treeMetadata.values()) {
            if (this.#normalizeTreeName(meta.name) === normalized) {
                return this.#instantiateTree(meta);
            }
        }

        return null;
    }

    getDefaultContextTree() {
        return this.#getDefaultTreeByType('context');
    }

    getDefaultDirectoryTree() {
        return this.#getDefaultTreeByType('directory');
    }

    async createTree(name, type = 'context', options = {}) {
        const normalizedName = this.#normalizeTreeName(name);
        if (!normalizedName) { throw new Error('Tree name is required'); }
        if (!['context', 'directory'].includes(type)) { throw new Error(`Unsupported tree type "${type}"`); }
        if (this.getTree(name)) { throw new Error(`Tree already exists: ${name}`); }

        const now = new Date().toISOString();
        const meta = {
            id: options.id || ulid(),
            name: String(name).trim(),
            type,
            createdAt: now,
            updatedAt: now,
            isDefault: options.isDefault ?? !this.#defaultTreeIds[type],
            // Generic per-tree settings bag; synapsd only interprets generic
            // flags (e.g. linkContextRoot) — policy names live at the caller.
            settings: options.settings && typeof options.settings === 'object'
                ? { ...options.settings }
                : {},
        };

        await this.#internalStore.put(this.#treeMetaKey(meta.id), meta);
        this.#treeMetadata.set(meta.id, meta);
        if (meta.isDefault || !this.#defaultTreeIds[type]) {
            this.#defaultTreeIds[type] = meta.id;
        }

        const tree = this.#instantiateTree(meta);
        await tree.initialize();
        if (type === 'context' && meta.id === this.#defaultTreeIds.context) {
            this.#onContextCollection(tree.collection || this.contextCollection(meta.id));
        }

        this.#publish(EVENTS.TREE_CREATED, createEvent(EVENTS.TREE_CREATED, { treeId: meta.id, treeName: meta.name, treeType: meta.type }));
        return meta;
    }

    async deleteTree(nameOrId) {
        const meta = this.#resolveTreeMeta(nameOrId);
        if (!meta) { throw new Error(`Tree not found: ${nameOrId}`); }
        await this.#deleteTreeStorage(meta);
        this.#treeMetadata.delete(meta.id);
        this.#treeCache.delete(meta.id);
        if (this.#defaultTreeIds[meta.type] === meta.id) {
            this.#defaultTreeIds[meta.type] = null;
            const next = (await this.listTrees(meta.type))[0];
            if (next) {
                this.#defaultTreeIds[meta.type] = next.id;
            }
        }
        this.#publish(EVENTS.TREE_DELETED, createEvent(EVENTS.TREE_DELETED, { treeId: meta.id, treeName: meta.name, treeType: meta.type }));
        return true;
    }

    async renameTree(nameOrId, newName) {
        const meta = this.#resolveTreeMeta(nameOrId);
        if (!meta) { throw new Error(`Tree not found: ${nameOrId}`); }
        if (this.getTree(newName)) { throw new Error(`Tree already exists: ${newName}`); }
        meta.name = String(newName).trim();
        meta.updatedAt = new Date().toISOString();
        await this.#internalStore.put(this.#treeMetaKey(meta.id), meta);
        // Update the cached instance so `tree.name` reflects the rename instead
        // of the stale construction-time value.
        const cached = this.#treeCache.get(meta.id);
        if (cached) { cached.name = meta.name; }
        this.#publish(EVENTS.TREE_RENAMED, createEvent(EVENTS.TREE_RENAMED, { treeId: meta.id, treeName: meta.name, treeType: meta.type }));
        return meta;
    }

    getTreePaths(nameOrId) {
        const tree = this.getTree(nameOrId);
        if (!tree) { throw new Error(`Tree not found: ${nameOrId}`); }
        return tree.paths;
    }

    getTreeJson(nameOrId) {
        const tree = this.getTree(nameOrId);
        if (!tree) { throw new Error(`Tree not found: ${nameOrId}`); }
        return tree.buildJsonTree();
    }

    // Emit a tree.document.* event for a context/directory selection. Emitting on
    // the tree means #registerTreeEvents stamps treeId/treeName/treeType, and the
    // workspace runtime listener adds workspaceId — the shape clients (browser
    // extension auto-open/close, web UI) rely on. Carries documentIds + the path
    // so consumers can fetch/close by id without inline document bodies.
    // Public: emit a tree-scoped document event for an already-known selection
    // (e.g. a scoped purge that deleted ids at a specific tree+path). Lets callers
    // that hold the selector drive cross-client auto-close without per-doc
    // membership reconstruction. Pass whichever of context/directory applies.
    emitTreeDocumentEvent(eventName, { context = null, directory = null, documentIds = [] } = {}) {
        this.emitDocumentEvent(eventName, 'context', context, documentIds);
        this.emitDocumentEvent(eventName, 'directory', directory, documentIds);
    }

    /**
     * Internal methods
     */

    async #loadTreeRegistry() {
        this.#treeMetadata.clear();
        this.#defaultTreeIds = { context: null, directory: null };

        const treeIds = new Set();
        for await (const key of this.#internalStore.getKeys({
            start: 'tree/',
            end: 'tree/\uffff',
        })) {
            const match = String(key).match(/^tree\/([^/]+)\/meta$/);
            if (match) {
                treeIds.add(match[1]);
            }
        }

        for (const treeId of treeIds) {
            const meta = this.#internalStore.get(this.#treeMetaKey(treeId));
            if (!meta) { continue; }
            this.#treeMetadata.set(meta.id, meta);
            if (meta.isDefault && !this.#defaultTreeIds[meta.type]) {
                this.#defaultTreeIds[meta.type] = meta.id;
            }
        }
    }

    async #ensureDefaultTrees() {
        if ((await this.listTrees('context')).length === 0) {
            await this.createTree('default', 'context', { isDefault: true });
        }
        if ((await this.listTrees('directory')).length === 0) {
            await this.createTree('directory', 'directory', { isDefault: true });
        }

        if (!this.#defaultTreeIds.context) {
            this.#defaultTreeIds.context = (await this.listTrees('context'))[0]?.id || null;
        }
        if (!this.#defaultTreeIds.directory) {
            this.#defaultTreeIds.directory = (await this.listTrees('directory'))[0]?.id || null;
        }

        if (this.#defaultTreeIds.context) {
            this.#onContextCollection(this.contextCollection(this.#defaultTreeIds.context));
        }

        for (const meta of this.#treeMetadata.values()) {
            await this.#instantiateTree(meta).initialize();
        }
    }

    #resolveTreeMeta(nameOrId, type = null) {
        const tree = this.getTree(nameOrId);
        if (!tree) {
            return null;
        }
        const meta = this.#treeMetadata.get(tree.id) || null;
        if (type && meta?.type !== type) {
            return null;
        }
        return meta;
    }

    #getDefaultTreeByType(type) {
        const treeId = this.#defaultTreeIds[type] || null;
        return treeId ? this.getTree(treeId) : null;
    }

    #instantiateTree(meta) {
        if (!meta) { return null; }
        if (this.#treeCache.has(meta.id)) {
            return this.#treeCache.get(meta.id);
        }

        const dataStore = new PrefixedStore(this.#internalStore, `tree/${meta.id}`);
        const tree = this.#createTreeInstance(meta.type, {
            dataStore,
            bitmapIndex: this.#bitmapIndex,
            treeId: meta.id,
            treeName: meta.name,
            settings: meta.settings,
            bitmapCollection: meta.type === 'directory'
                ? this.directoryCollection(meta.id)
                : this.contextCollection(meta.id),
        });

        this.#registerTreeEvents(tree, meta);
        this.#treeCache.set(meta.id, tree);
        return tree;
    }

    #registerTreeEvents(tree, meta) {
        if (tree.__synapsdTreeEventsBound) { return; }
        tree.__synapsdTreeEventsBound = true;
        const publish = this.#publish;
        tree.on('**', function (payload = {}) {
            const eventName = this.event;
            if (!eventName) { return; }
            const forwarded = payload && typeof payload === 'object' ? { ...payload } : { value: payload };
            if (!forwarded.treeId) { forwarded.treeId = meta.id; }
            if (!forwarded.treeName) { forwarded.treeName = meta.name; }
            if (!forwarded.treeType) { forwarded.treeType = meta.type; }
            if (!forwarded.source) { forwarded.source = 'tree'; }
            publish(eventName, forwarded);
        });
    }

    #treeMetaKey(treeId) {
        return `tree/${treeId}/meta`;
    }

    #normalizeTreeName(name) {
        return String(name ?? '')
            .normalize('NFKC')
            .trim()
            .replace(/\s+/g, ' ')
            .toLowerCase();
    }

    async #deleteTreeStorage(meta) {
        const internalKeys = [];
        for await (const key of this.#internalStore.getKeys({
            start: `tree/${meta.id}/`,
            end: `tree/${meta.id}/\uffff`,
        })) {
            internalKeys.push(key);
        }
        for (const key of internalKeys) {
            await this.#internalStore.remove(key);
        }

        const bitmapPrefix = meta.type === 'directory' ? `vfs/${meta.id}` : `context/${meta.id}`;
        const bitmapKeys = await this.#bitmapIndex.listBitmaps(bitmapPrefix);
        for (const key of bitmapKeys) {
            await this.#bitmapIndex.deleteBitmap(key);
        }
    }

    resolveSelection(type, spec, defaultPath = null) {
        if (typeof spec === 'string' || Array.isArray(spec)) {
            throw new Error(`Legacy ${type} path strings are no longer supported. Pass { tree, path } instead.`);
        }
        const pathFallbackKey = type === 'directory' ? 'directory' : 'context';
        const treeSelector = spec && typeof spec === 'object' && !Array.isArray(spec)
            ? (spec.tree ?? spec.treeId ?? spec.nameOrId ?? null)
            : null;
        const path = spec && typeof spec === 'object' && !Array.isArray(spec)
            ? (spec.path ?? spec[pathFallbackKey] ?? defaultPath)
            : (spec ?? defaultPath);
        const tree = treeSelector ? this.getTree(treeSelector) : this.#getDefaultTreeByType(type);
        if (!tree) {
            throw new Error(`No ${type} tree available`);
        }
        if (tree.type !== type) {
            throw new Error(`Tree "${tree.name}" is not a ${type} tree`);
        }
        return {
            tree,
            collection: type === 'context'
                ? this.contextCollection(tree.id)
                : this.directoryCollection(tree.id),
            path,
        };
    }

    resolveGenericSelection(selector = null, defaultPath = '/', fallbackType = 'context') {
        if (selector == null) {
            const tree = this.#getDefaultTreeByType(fallbackType);
            if (!tree) {
                throw new Error(`No ${fallbackType} tree available`);
            }
            return {
                type: tree.type,
                tree,
                path: defaultPath,
                spec: { tree: tree.id, path: defaultPath },
            };
        }

        if (typeof selector === 'string' || Array.isArray(selector)) {
            const tree = this.#getDefaultTreeByType(fallbackType);
            if (!tree) {
                throw new Error(`No ${fallbackType} tree available`);
            }
            return {
                type: tree.type,
                tree,
                path: selector,
                spec: { tree: tree.id, path: selector },
            };
        }

        if (typeof selector !== 'object' || Array.isArray(selector)) {
            throw new Error('Invalid tree selector');
        }

        if (Object.prototype.hasOwnProperty.call(selector, 'context')) {
            const { tree, path } = this.resolveSelection('context', {
                tree: selector.tree ?? selector.treeId ?? selector.nameOrId ?? null,
                path: selector.path ?? selector.context ?? defaultPath,
            }, defaultPath);
            return {
                type: 'context',
                tree,
                path,
                spec: { tree: tree.id, path },
            };
        }

        if (Object.prototype.hasOwnProperty.call(selector, 'directory')) {
            const { tree, path } = this.resolveSelection('directory', {
                tree: selector.tree ?? selector.treeId ?? selector.nameOrId ?? null,
                path: selector.path ?? selector.directory ?? defaultPath,
            }, defaultPath);
            return {
                type: 'directory',
                tree,
                path,
                spec: { tree: tree.id, path },
            };
        }

        const treeSelector = selector.tree ?? selector.treeId ?? selector.nameOrId ?? null;
        const tree = treeSelector ? this.getTree(treeSelector) : this.#getDefaultTreeByType(fallbackType);
        if (!tree) {
            throw new Error(`Tree not found: ${treeSelector}`);
        }

        const path = selector.path ?? defaultPath;
        return {
            type: tree.type,
            tree,
            path,
            spec: { tree: tree.id, path },
        };
    }

    contextCollection(treeId) {
        return this.#bitmapIndex.createCollection(`context/${treeId}`);
    }

    directoryCollection(treeId) {
        return this.#bitmapIndex.createCollection(`vfs/${treeId}`);
    }

    emitDocumentEvent(eventName, type, spec, documentIds) {
        if (!spec || !Array.isArray(documentIds) || documentIds.length === 0) { return; }
        try {
            const { tree, path } = this.resolveSelection(type, spec, '/');
            const contextSpec = Array.isArray(path) ? (path[0] ?? '/') : (path ?? '/');
            tree.emit(eventName, createEvent(eventName, { documentIds, contextSpec, source: 'tree' }));
        } catch (error) {
            debug(`emitDocumentEvent ${eventName} (${type}) failed: ${error.message}`);
        }
    }
}
