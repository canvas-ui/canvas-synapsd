'use strict';

import EventEmitter from 'eventemitter2';
import debugInstance from 'debug';
import { ulid } from 'ulid';
import TreeNode from './tree/lib/TreeNode.js';

const debug = debugInstance('canvas:synapsd:directory-tree');

const ROOT_NODE_ID = 'root';

class DirectoryTree extends EventEmitter {
    #dataStore;
    #collection;
    #treeId;
    #treeName;
    #initialized = false;

    constructor(options = {}) {
        super({
            wildcard: true,
            delimiter: '.',
            newListener: false,
            maxListeners: 100,
            ...(options.eventEmitterOptions || {}),
        });

        if (!options.dataStore) { throw new Error('DirectoryTree requires a dataStore reference'); }
        if (!options.bitmapIndex) { throw new Error('DirectoryTree requires a bitmapIndex reference'); }
        if (!options.treeId) { throw new Error('DirectoryTree requires a treeId'); }

        this.#dataStore = options.dataStore;
        this.#treeId = options.treeId;
        this.#treeName = options.treeName || options.name || options.treeId;
        this.#collection = options.bitmapCollection || options.bitmapIndex.createCollection(`vfs/${this.#treeId}`);
        this.root = null;
    }

    get id() { return this.#treeId; }
    get name() { return this.#treeName; }
    get type() { return 'directory'; }
    get collection() { return this.#collection; }

    async initialize() {
        if (this.#initialized) { return; }
        this.root = await this.#loadTree();
        this.#initialized = true;
    }

    async insertDocument(oid, path) {
        const node = await this.#ensureNode(path);
        await this.#collection.tick(node.id, oid);
        return this.#collection.makeKey(node.id);
    }

    async insertDocumentMany(oid, pathArray) {
        const paths = Array.isArray(pathArray) ? pathArray : [pathArray];
        const nodeIds = [];
        for (const path of paths) {
            const node = await this.#ensureNode(path);
            nodeIds.push(node.id);
        }
        if (nodeIds.length === 0) { return []; }
        await this.#collection.tickMany(nodeIds, oid);
        return nodeIds.map((id) => this.#collection.makeKey(id));
    }

    async removeDocument(oid, path) {
        const node = this.#getNodeForPath(this.#normalizePath(path));
        if (!node) { return; }
        await this.#collection.untick(node.id, oid);
    }

    async deleteDocument(oid) {
        const ids = this.#collectNodeIds(this.root).filter((id) => id !== ROOT_NODE_ID);
        if (ids.length === 0) { return; }
        await this.#collection.untickMany(ids, oid);
    }

    async find(path) {
        const node = this.#getNodeForPath(this.#normalizePath(path));
        if (!node) { return null; }
        return await this.#collection.getBitmap(node.id, false);
    }

    async findRecursive(path) {
        const node = this.#getNodeForPath(this.#normalizePath(path));
        if (!node) { return null; }
        const nodeIds = this.#collectNodeIds(node).filter((id) => id !== ROOT_NODE_ID);
        if (nodeIds.length === 0) {
            return await this.find(path);
        }
        return await this.#collection.OR(nodeIds);
    }

    pathExists(path = '/') {
        return Boolean(this.#getNodeForPath(this.#normalizePath(path)));
    }

    async listDirectories(parentPath = '/') {
        const parent = this.#getNodeForPath(this.#normalizePath(parentPath));
        if (!parent) { return []; }
        return parent.getSortedChildren().map((child) => child.payload.name);
    }

    async insertPath(path = '/') {
        const normalizedPath = this.#normalizePath(path);
        const node = await this.#ensureNode(normalizedPath);
        this.emit('tree.path.inserted', {
            path: normalizedPath,
            nodeId: node.id,
            treeType: this.type,
            timestamp: new Date().toISOString(),
        });
        return {
            data: [node.id],
            count: 1,
            error: null,
        };
    }

    async movePath(pathFrom, pathTo) {
        const sourcePath = this.#normalizePath(pathFrom);
        const targetPath = this.#normalizePath(pathTo);
        if (sourcePath === '/' || targetPath === '/') {
            throw new Error('Cannot move the root directory');
        }

        const node = this.#getNodeForPath(sourcePath);
        if (!node) { throw new Error(`Path not found: ${sourcePath}`); }

        const currentParent = this.#getParentNode(sourcePath);
        const { parentNode: targetParent, targetName } = await this.#resolveTargetParent(targetPath);
        if (!currentParent || !targetParent) { throw new Error('Unable to resolve move target'); }
        if (this.#hasChildWithName(targetParent, targetName, node.id)) {
            throw new Error(`Target path already exists: ${targetPath}`);
        }
        if (this.#isDescendantPath(sourcePath, targetPath)) {
            throw new Error('Cannot move a directory into itself');
        }

        currentParent.removeChild(node.id);
        targetParent.addChild(node);
        node.payload.name = targetName;
        node.payload.parentId = targetParent.id;

        await Promise.all([
            this.#persistNode(currentParent),
            this.#persistNode(targetParent),
            this.#persistNode(node),
        ]);

        this.emit('tree.path.moved', {
            pathFrom: sourcePath,
            pathTo: targetPath,
            nodeId: node.id,
            treeType: this.type,
            timestamp: new Date().toISOString(),
        });

        return { data: { nodeId: node.id }, count: 1, error: null };
    }

    async copyPath(pathFrom, pathTo, recursive = true) {
        const sourcePath = this.#normalizePath(pathFrom);
        const targetPath = this.#normalizePath(pathTo);
        const sourceNode = this.#getNodeForPath(sourcePath);
        if (!sourceNode) { throw new Error(`Path not found: ${sourcePath}`); }

        const { parentNode: targetParent, targetName } = await this.#resolveTargetParent(targetPath);
        if (this.#hasChildWithName(targetParent, targetName)) {
            throw new Error(`Target path already exists: ${targetPath}`);
        }

        const copiedNode = await this.#cloneSubtree(sourceNode, recursive);
        copiedNode.payload.name = targetName;
        copiedNode.payload.parentId = targetParent.id;
        targetParent.addChild(copiedNode);

        await this.#persistSubtree(copiedNode);
        await this.#persistNode(targetParent);

        this.emit('tree.path.copied', {
            pathFrom: sourcePath,
            pathTo: targetPath,
            recursive,
            nodeId: copiedNode.id,
            treeType: this.type,
            timestamp: new Date().toISOString(),
        });

        return true;
    }

    async removePath(path, recursive = false) {
        const normalizedPath = this.#normalizePath(path);
        if (normalizedPath === '/') {
            throw new Error('Cannot remove the root directory');
        }
        const node = this.#getNodeForPath(normalizedPath);
        if (!node) {
            return { data: null, count: 0, error: `Path not found: ${normalizedPath}` };
        }
        if (!recursive && node.hasChildren) {
            return { data: null, count: 0, error: 'Directory is not empty' };
        }

        const parent = this.#getParentNode(normalizedPath);
        parent.removeChild(node.id);
        await this.#persistNode(parent);
        await this.#deleteSubtree(node);

        this.emit('tree.path.removed', {
            path: normalizedPath,
            recursive,
            nodeId: node.id,
            treeType: this.type,
            timestamp: new Date().toISOString(),
        });

        return {
            data: { nodeId: node.id, path: normalizedPath },
            count: 1,
            error: null,
        };
    }

    buildJsonTree(node = this.root) {
        return {
            id: node.id,
            name: node.payload.name,
            type: 'directory',
            children: node.getSortedChildren().map((child) => this.buildJsonTree(child)),
        };
    }

    async #ensureNode(path) {
        const normalizedPath = this.#normalizePath(path);
        if (normalizedPath === '/') { return this.root; }

        let current = this.root;
        const touched = new Set();
        for (const rawName of normalizedPath.split('/').filter(Boolean)) {
            const name = this.#sanitizeSegment(rawName);
            let child = this.#findChildByName(current, name);
            if (!child) {
                child = new TreeNode(ulid(), {
                    id: ulid(),
                    name,
                    parentId: current.id,
                    type: 'directory',
                });
                child.payload.id = child.id;
                current.addChild(child);
                touched.add(current);
                touched.add(child);
            }
            current = child;
        }

        for (const node of touched) {
            await this.#persistNode(node);
        }

        return current;
    }

    async #cloneSubtree(sourceNode, recursive) {
        const clone = new TreeNode(ulid(), {
            id: null,
            name: sourceNode.payload.name,
            parentId: null,
            type: 'directory',
        });
        clone.payload.id = clone.id;

        const sourceBitmap = await this.#collection.getBitmap(sourceNode.id, false);
        if (sourceBitmap) {
            await this.#collection.createBitmap(clone.id, sourceBitmap);
        }

        if (recursive) {
            for (const child of sourceNode.children.values()) {
                const childClone = await this.#cloneSubtree(child, true);
                childClone.payload.parentId = clone.id;
                clone.addChild(childClone);
            }
        }

        return clone;
    }

    async #persistSubtree(node) {
        await this.#persistNode(node);
        for (const child of node.children.values()) {
            await this.#persistSubtree(child);
        }
    }

    async #deleteSubtree(node) {
        for (const child of node.children.values()) {
            await this.#deleteSubtree(child);
        }
        await this.#collection.deleteBitmap(node.id).catch(() => null);
        await this.#dataStore.remove(this.#nodeKey(node.id));
    }

    async #loadTree() {
        const rootData = this.#dataStore.get(this.#nodeKey(ROOT_NODE_ID));
        if (!rootData) {
            const root = new TreeNode(ROOT_NODE_ID, {
                id: ROOT_NODE_ID,
                name: '/',
                parentId: null,
                type: 'directory',
            });
            await this.#persistNode(root);
            return root;
        }
        return await this.#loadNode(rootData);
    }

    async #loadNode(nodeData) {
        const node = new TreeNode(nodeData.id, { ...nodeData });
        for (const childId of nodeData.childIds || []) {
            const childData = this.#dataStore.get(this.#nodeKey(childId));
            if (!childData) { continue; }
            node.addChild(await this.#loadNode(childData));
        }
        return node;
    }

    async #persistNode(node) {
        await this.#dataStore.put(this.#nodeKey(node.id), {
            id: node.id,
            name: node.payload.name,
            parentId: node.payload.parentId ?? null,
            type: 'directory',
            childIds: Array.from(node.children.keys()),
        });
    }

    #nodeKey(nodeId) {
        return `nodes/${nodeId}`;
    }

    #getNodeForPath(path) {
        if (!this.root) { throw new Error('DirectoryTree not initialized'); }
        if (path === '/' || !path) { return this.root; }

        let current = this.root;
        for (const rawName of path.split('/').filter(Boolean)) {
            const name = this.#sanitizeSegment(rawName);
            current = this.#findChildByName(current, name);
            if (!current) { return null; }
        }
        return current;
    }

    #getParentNode(path) {
        const normalized = this.#normalizePath(path);
        if (normalized === '/') { return null; }
        const parentPath = normalized.split('/').slice(0, -1).join('/');
        return this.#getNodeForPath(parentPath || '/');
    }

    async #resolveTargetParent(targetPath) {
        const parts = targetPath.split('/').filter(Boolean);
        const targetName = this.#sanitizeSegment(parts.pop());
        const parentPath = parts.length > 0 ? `/${parts.join('/')}` : '/';
        const parentNode = await this.#ensureNode(parentPath);
        return { parentNode, targetName };
    }

    #collectNodeIds(node) {
        const ids = [node.id];
        for (const child of node.children.values()) {
            ids.push(...this.#collectNodeIds(child));
        }
        return ids;
    }

    #findChildByName(parent, name) {
        const normalized = this.#normalizeSegmentForCompare(name);
        return Array.from(parent.children.values())
            .find((child) => this.#normalizeSegmentForCompare(child.payload.name) === normalized) || null;
    }

    #hasChildWithName(parent, name, excludeId = null) {
        const normalized = this.#normalizeSegmentForCompare(name);
        return Array.from(parent.children.values()).some((child) =>
            child.id !== excludeId && this.#normalizeSegmentForCompare(child.payload.name) === normalized
        );
    }

    #isDescendantPath(sourcePath, targetPath) {
        return targetPath.startsWith(`${sourcePath}/`);
    }

    #normalizePath(path) {
        if (path == null || path === '') { return '/'; }
        let normalized = String(path).replace(/\\/g, '/').trim();
        if (!normalized.startsWith('/')) {
            normalized = `/${normalized}`;
        }
        normalized = normalized.replace(/\/+/g, '/');
        if (normalized.length > 1 && normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1);
        }
        return normalized;
    }

    #sanitizeSegment(value) {
        const sanitized = String(value ?? '')
            .normalize('NFKC')
            .trim()
            .replace(/[\\/]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/[^\p{L}\p{N}\p{M} .+_@-]/gu, '_')
            .replace(/_+/g, '_');
        return sanitized || '_';
    }

    #normalizeSegmentForCompare(value) {
        return this.#sanitizeSegment(value).toLowerCase();
    }
}

export default DirectoryTree;
