'use strict';

import EventEmitter from 'eventemitter2';
import debugInstance from 'debug';
import { ulid } from 'ulid';
import TreeNode from './lib/TreeNode.js';
import { EVENTS } from '../utils/events.js';
import { buildTreeEventPayload } from './lib/treeEvents.js';
import Canvas from '../schemas/internal/layers/Canvas.js';

const debug = debugInstance('canvas:synapsd:directory-tree');

const ROOT_NODE_ID = 'root';
const INHERITED_LOCK_METADATA_KEY = 'inheritedLocks';
// `system:*` locks (e.g. system:backends, system:backend:<name>) protect a
// SINGLE node from structural ops (remove/rename/move) — they are NOT subtree
// locks and must not cascade to children. Without this, every backend-ingested
// subfolder under /.backends inherited the root lock and could never be deleted.
const SYSTEM_LOCK_PREFIX = 'system:';
const isSystemLock = (lock) => String(lock).startsWith(SYSTEM_LOCK_PREFIX);

class DirectoryTree extends EventEmitter {
    #dataStore;
    #db;
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
        this.#db = options.db || null;
        this.#treeId = options.treeId;
        this.#treeName = options.treeName || options.name || options.treeId;
        this.#collection = options.bitmapCollection || options.bitmapIndex.createCollection(`vfs/${this.#treeId}`);
        this.root = null;
    }

    get id() { return this.#treeId; }
    get name() { return this.#treeName; }
    // See ContextTree: keep cached instance name in sync on rename.
    set name(value) { if (value) this.#treeName = String(value); }
    get type() { return 'directory'; }
    get collection() { return this.#collection; }

    get paths() {
        return this.#buildPathArray();
    }

    async initialize() {
        if (this.#initialized) { return; }
        this.root = await this.#loadTree();
        this.#initialized = true;
    }

    async put(oid, path) {
        const node = await this.#ensureNode(path);
        await this.#collection.tick(node.id, oid);
        return this.#collection.makeKey(node.id);
    }

    async putMany(oid, pathArray) {
        const nodeIds = await this.ensurePaths(pathArray);
        if (nodeIds.length === 0) { return []; }
        await this.#collection.tickMany(nodeIds, oid);
        return nodeIds.map((id) => this.#collection.makeKey(id));
    }

    async ensurePaths(pathArray) {
        const paths = Array.isArray(pathArray) ? pathArray : [pathArray];
        const nodeIds = [];
        for (const path of paths) {
            const node = await this.#ensureNode(path);
            nodeIds.push(node.id);
        }
        return nodeIds;
    }

    async unlink(oid, path) {
        const node = this.#getNodeForPath(this.#normalizePath(path));
        if (!node) { return; }
        await this.#collection.untick(node.id, oid);
    }

    async unlinkMany(oid) {
        const ids = this.#collectNodeIds(this.root).filter((id) => id !== ROOT_NODE_ID);
        if (ids.length === 0) { return; }
        await this.#collection.untickMany(ids, oid);
    }

    async find(path) {
        const node = this.#getNodeForPath(this.#normalizePath(path));
        if (!node) { return null; }
        const bitmap = await this.#collection.getBitmap(node.id, false);
        return bitmap ? bitmap.clone() : null;
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

    // Resolve the documents ticked into the folder bitmap at `path`.
    // Mirrors ContextTree.list() so consumers can treat both tree types uniformly.
    async list({ path = '/', limit = 1000, parse = true } = {}) {
        if (!this.#db) { throw new Error('DirectoryTree requires a db reference for list()'); }
        const bitmap = await this.find(path);
        if (!bitmap || bitmap.size === 0) { return []; }
        const oids = bitmap.toArray().slice(0, limit);
        const docs = await this.#db.getDocumentsByIdArray(oids, { parse });
        return Array.isArray(docs) ? docs.filter(Boolean) : [];
    }

    async getPathByNodeId(nodeId) {
        if (!nodeId) { return null; }
        if (nodeId === ROOT_NODE_ID) { return '/'; }

        const segments = [];
        let currentId = nodeId;
        while (currentId && currentId !== ROOT_NODE_ID) {
            const nodeData = this.#dataStore.get(this.#nodeKey(currentId));
            if (!nodeData) { return null; }
            segments.unshift(nodeData.name);
            currentId = nodeData.parentId || ROOT_NODE_ID;
        }

        return segments.length > 0 ? `/${segments.join('/')}` : '/';
    }

    getNodeIdsForPath(path = '/', { recursive = false } = {}) {
        const node = this.#getNodeForPath(this.#normalizePath(path));
        if (!node) { return []; }
        if (!recursive) { return [node.id]; }
        return this.#collectNodeIds(node);
    }

    pathExists(path = '/') {
        return Boolean(this.#getNodeForPath(this.#normalizePath(path)));
    }

    async listDirectories(parentPath = '/') {
        const parent = this.#getNodeForPath(this.#normalizePath(parentPath));
        if (!parent) { return []; }
        return parent.getSortedChildren().map((child) => child.payload.name);
    }

    async insertPath(path = '/', options = {}) {
        const normalizedPath = this.#normalizePath(path);
        const leafType = options.leafType || options.type || 'directory';
        if (!options.ignoreLocks) {
            this.#assertPathMutableForInsert(normalizedPath);
        }
        const existing = this.#getNodeForPath(normalizedPath);
        if (existing && existing.payload.type !== leafType) {
            if (leafType === 'canvas' && existing.payload.type === 'directory' && !existing.hasChildren) {
                existing.payload.type = 'canvas';
                this.#applyNodeUpdates(existing, options);
                await this.#persistNode(existing);
                return {
                    data: [existing.id],
                    count: 1,
                    error: null,
                };
            }
            return {
                data: [],
                count: 0,
                error: `Path "${normalizedPath}" already exists as type "${existing.payload.type}". Pick a different path for the new ${leafType}.`,
            };
        }

        const node = existing || await this.#ensureNode(normalizedPath, { leafType });
        if (leafType === 'canvas') {
            this.#applyNodeUpdates(node, options);
            await this.#persistNode(node);
        }
        this.#emitTreeEvent(EVENTS.TREE_PATH_INSERTED, {
            path: normalizedPath,
            nodeId: node.id,
        });
        return {
            data: [node.id],
            count: 1,
            error: null,
        };
    }

    getLayerForPath(path = '/') {
        const node = this.#getNodeForPath(this.#normalizePath(path));
        return node ? this.#nodeToLayer(node) : null;
    }

    async updateLayer(nameOrId, updates = {}) {
        const node = this.#findNodeById(String(nameOrId));
        if (!node) { throw new Error(`Layer not found: ${nameOrId}`); }
        // Shared canvases stay locked in the tree but remain widget-editable via metadata.
        if (this.#isNodeLocked(node)) {
            const updateKeys = Object.keys(updates || {});
            const presentationOnly = updateKeys.length > 0
                && updateKeys.every((key) => ['querySpec', 'metadata', 'color'].includes(key));
            if (!presentationOnly) { throw new Error('Layer is locked'); }
        } else {
            this.#assertNodeMutable(node);
        }
        this.#applyNodeUpdates(node, updates);
        await this.#persistNode(node);
        const layer = this.#nodeToLayer(node);
        this.#emitTreeEvent(EVENTS.TREE_LAYER_UPDATED, {
            layerId: layer.id,
            layerName: layer.name,
            layerType: layer.type,
            path: await this.getPathByNodeId(node.id),
            updates: Object.keys(updates || {}),
        });
        return layer;
    }

    async lockLayer(nameOrId, lockBy) {
        return this.lockPath(nameOrId, lockBy);
    }

    async unlockLayer(nameOrId, lockBy) {
        return this.unlockPath(nameOrId, lockBy);
    }

    async lockPath(pathOrNodeId, lockBy, options = {}) {
        if (!lockBy) { throw new Error('Locking layer requires a lockBy parameter'); }
        const node = this.#resolveNode(pathOrNodeId);
        if (!node) { throw new Error(`Layer not found: ${pathOrNodeId}`); }
        this.#lockNode(node, lockBy, options.recursive === true);
        await this.#persistSubtree(node);
        return true;
    }

    async unlockPath(pathOrNodeId, lockBy, options = {}) {
        if (!lockBy) { throw new Error('Unlocking layer requires a lockBy parameter'); }
        if (String(lockBy).startsWith('system:') && options.system !== true) {
            throw new Error('System locks cannot be removed through the tree API');
        }
        const node = this.#resolveNode(pathOrNodeId);
        if (!node) { throw new Error(`Layer not found: ${pathOrNodeId}`); }
        this.#unlockNode(node, lockBy, options.recursive === true);
        await this.#persistSubtree(node);
        return {
            unlockedBy: lockBy,
            isStillLocked: this.#isNodeLocked(node),
            lockedBy: [...(node.payload.lockedBy || [])],
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
        this.#assertNodeMutable(node);
        this.#assertPathMutableForInsert(targetPath);

        const currentParent = this.#getParentNode(sourcePath);
        const { parentNode: targetParent, targetName } = await this.#resolveTargetParent(targetPath);
        if (!currentParent || !targetParent) { throw new Error('Unable to resolve move target'); }
        this.#assertNodeMutable(targetParent);
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

        this.#emitTreeEvent(EVENTS.TREE_PATH_MOVED, {
            pathFrom: sourcePath,
            pathTo: targetPath,
            nodeId: node.id,
        });

        return { data: { nodeId: node.id }, count: 1, error: null };
    }

    async copyPath(pathFrom, pathTo, recursive = true) {
        const sourcePath = this.#normalizePath(pathFrom);
        const targetPath = this.#normalizePath(pathTo);
        const sourceNode = this.#getNodeForPath(sourcePath);
        if (!sourceNode) { throw new Error(`Path not found: ${sourcePath}`); }
        this.#assertPathMutableForInsert(targetPath);

        const { parentNode: targetParent, targetName } = await this.#resolveTargetParent(targetPath);
        this.#assertNodeMutable(targetParent);
        if (this.#hasChildWithName(targetParent, targetName)) {
            throw new Error(`Target path already exists: ${targetPath}`);
        }

        const copiedNode = await this.#cloneSubtree(sourceNode, recursive);
        copiedNode.payload.name = targetName;
        copiedNode.payload.parentId = targetParent.id;
        targetParent.addChild(copiedNode);

        await this.#persistSubtree(copiedNode);
        await this.#persistNode(targetParent);

        this.#emitTreeEvent(EVENTS.TREE_PATH_COPIED, {
            pathFrom: sourcePath,
            pathTo: targetPath,
            recursive,
            nodeId: copiedNode.id,
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
        this.#assertNodeMutable(node);
        if (!recursive && node.hasChildren) {
            return { data: null, count: 0, error: 'Directory is not empty' };
        }

        const parent = this.#getParentNode(normalizedPath);
        parent.removeChild(node.id);
        await this.#persistNode(parent);
        await this.#deleteSubtree(node);

        this.#emitTreeEvent(EVENTS.TREE_PATH_REMOVED, {
            path: normalizedPath,
            recursive,
            nodeId: node.id,
        });

        return {
            data: { nodeId: node.id, path: normalizedPath },
            count: 1,
            error: null,
        };
    }

    buildJsonTree(node = this.root) {
        const view = {
            id: node.id,
            name: node.payload.name,
            type: node.payload.type || 'directory',
            label: node.payload.label || node.payload.name,
            description: node.payload.description || '',
            color: node.payload.color ?? null,
            locked: this.#isNodeLocked(node),
            lockedBy: node.payload.lockedBy || [],
            metadata: node.payload.metadata || {},
            children: node.getSortedChildren().map((child) => this.buildJsonTree(child)),
        };
        if (view.type === 'canvas') {
            view.querySpec = Canvas.normalizeQuerySpec(node.payload.querySpec);
        }
        return view;
    }

    async #ensureNode(path, options = {}) {
        const normalizedPath = this.#normalizePath(path);
        if (normalizedPath === '/') { return this.root; }

        let current = this.root;
        const segments = normalizedPath.split('/').filter(Boolean);
        const touched = new Set();
        for (let index = 0; index < segments.length; index++) {
            const rawName = segments[index];
            const name = this.#sanitizeSegment(rawName);
            let child = this.#findChildByName(current, name);
            if (!child) {
                const isLeaf = index === segments.length - 1;
                child = new TreeNode(ulid(), {
                    id: ulid(),
                    name,
                    parentId: current.id,
                    type: isLeaf ? (options.leafType || 'directory') : 'directory',
                    lockedBy: this.#locksForChild(current),
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
            type: sourceNode.payload.type || 'directory',
            label: sourceNode.payload.label,
            description: sourceNode.payload.description,
            color: sourceNode.payload.color,
            metadata: sourceNode.payload.metadata,
            lockedBy: sourceNode.payload.lockedBy || [],
            querySpec: sourceNode.payload.querySpec,
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
        const data = {
            id: node.id,
            name: node.payload.name,
            parentId: node.payload.parentId ?? null,
            type: node.payload.type || 'directory',
            childIds: Array.from(node.children.keys()),
        };
        for (const key of ['label', 'description', 'color', 'metadata', 'querySpec', 'lockedBy']) {
            if (node.payload[key] !== undefined) { data[key] = node.payload[key]; }
        }
        await this.#dataStore.put(this.#nodeKey(node.id), data);
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

    #findNodeById(nodeId, current = this.root) {
        if (!current) { return null; }
        if (current.id === nodeId || current.payload.id === nodeId) { return current; }
        for (const child of current.children.values()) {
            const found = this.#findNodeById(nodeId, child);
            if (found) { return found; }
        }
        return null;
    }

    #applyNodeUpdates(node, updates = {}) {
        if (updates.querySpec !== undefined) {
            node.payload.querySpec = Canvas.normalizeQuerySpec(updates.querySpec);
        }
        if (updates.metadata !== undefined && typeof updates.metadata === 'object' && updates.metadata !== null) {
            node.payload.metadata = updates.metadata;
        }
        for (const key of ['label', 'description', 'color']) {
            if (updates[key] !== undefined) { node.payload[key] = updates[key]; }
        }
    }

    #nodeToLayer(node) {
        const payload = node.payload;
        const layer = {
            id: node.id,
            type: payload.type || 'directory',
            name: payload.name,
            label: payload.label || payload.name,
            description: payload.description || '',
            color: payload.color ?? null,
            metadata: payload.metadata || {},
            locked: this.#isNodeLocked(node),
            lockedBy: payload.lockedBy || [],
            toJSON() {
                const json = { ...this };
                delete json.toJSON;
                return json;
            },
        };
        if (layer.type === 'canvas') {
            layer.querySpec = Canvas.normalizeQuerySpec(payload.querySpec);
        }
        return layer;
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

    #resolveNode(pathOrNodeId) {
        const value = String(pathOrNodeId || '');
        return value.startsWith('/') ? this.#getNodeForPath(this.#normalizePath(value)) : this.#findNodeById(value);
    }

    #isNodeLocked(node) {
        return Array.isArray(node?.payload?.lockedBy) && node.payload.lockedBy.length > 0;
    }

    #assertNodeMutable(node) {
        if (this.#isNodeLocked(node)) {
            throw new Error('Layer is locked');
        }
    }

    #assertPathMutableForInsert(path) {
        const existing = this.#getNodeForPath(path);
        if (existing) {
            this.#assertNodeMutable(existing);
            return;
        }

        const parts = path.split('/').filter(Boolean);
        while (parts.length > 0) {
            parts.pop();
            const parentPath = parts.length > 0 ? `/${parts.join('/')}` : '/';
            const parent = this.#getNodeForPath(parentPath);
            if (parent) {
                this.#assertNodeMutable(parent);
                return;
            }
        }
    }

    #locksForChild(parent) {
        const inheritedLocks = parent?.payload?.metadata?.[INHERITED_LOCK_METADATA_KEY];
        return Array.from(new Set([
            ...(parent?.payload?.lockedBy || []),
            ...(Array.isArray(inheritedLocks) ? inheritedLocks : []),
        ])).filter((lock) => !isSystemLock(lock));
    }

    #lockNode(node, lockBy, recursive = false) {
        node.payload.lockedBy = Array.from(new Set([...(node.payload.lockedBy || []), lockBy]));
        const metadata = node.payload.metadata || {};
        const inheritedLocks = Array.isArray(metadata[INHERITED_LOCK_METADATA_KEY])
            ? metadata[INHERITED_LOCK_METADATA_KEY]
            : [];
        node.payload.metadata = {
            ...metadata,
            [INHERITED_LOCK_METADATA_KEY]: Array.from(new Set([...inheritedLocks, lockBy])),
        };
        if (recursive) {
            for (const child of node.children.values()) {
                this.#lockNode(child, lockBy, true);
            }
        }
    }

    #unlockNode(node, lockBy, recursive = false) {
        node.payload.lockedBy = (node.payload.lockedBy || []).filter((value) => value !== lockBy);
        const metadata = { ...(node.payload.metadata || {}) };
        if (Array.isArray(metadata[INHERITED_LOCK_METADATA_KEY])) {
            metadata[INHERITED_LOCK_METADATA_KEY] = metadata[INHERITED_LOCK_METADATA_KEY].filter((value) => value !== lockBy);
            if (metadata[INHERITED_LOCK_METADATA_KEY].length === 0) {
                delete metadata[INHERITED_LOCK_METADATA_KEY];
            }
        }
        node.payload.metadata = metadata;
        if (recursive) {
            for (const child of node.children.values()) {
                this.#unlockNode(child, lockBy, true);
            }
        }
    }

    #sanitizeSegment(value) {
        const sanitized = String(value ?? '')
            .normalize('NFKC')
            .trim()
            .replace(/[\\/]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/[^\p{L}\p{N}\p{M} .+_@:-]/gu, '_')
            .replace(/_+/g, '_');
        return sanitized || '_';
    }

    #normalizeSegmentForCompare(value) {
        return this.#sanitizeSegment(value).toLowerCase();
    }

    #buildPathArray() {
        const paths = ['/'];
        const traverse = (node, parentPath) => {
            for (const child of node.getSortedChildren()) {
                const childPath = parentPath === '/' ? `/${child.payload.name}` : `${parentPath}/${child.payload.name}`;
                paths.push(childPath);
                traverse(child, childPath);
            }
        };
        traverse(this.root, '/');
        return paths;
    }

    #emitTreeEvent(eventName, payload = {}) {
        this.emit(eventName, buildTreeEventPayload(this, eventName, payload));
    }
}

export default DirectoryTree;
