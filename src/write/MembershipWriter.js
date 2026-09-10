import debugInstance from 'debug';
import { EVENTS, createEvent, membershipDelta } from '../utils/events.js';
import { parseInitializeDocument, parseDocumentData } from '../utils/document.js';
import { parseBitmapArray, parseContextSpecForInsert } from '../utils/parsing.js';
import { normalizeBitmapKeys } from '../indexes/bitmaps/lib/keys.js';

import { documentFeatureKeys, schemaBitmapKeys } from '../documents/derivation.js';

import { isDocumentOperationOptions, normalizeDocumentOperationSpec, normalizeProvenance, unlinkedContextPaths } from './options.js';
const debug = debugInstance('canvas:synapsd');

export default class MembershipWriter {
    #documents;
    #trees;
    #writes;
    #derived;
    #getById;
    constructor({ documents, trees, writes, derived, getById }) {
        this.#documents = documents;
        this.#trees = trees;
        this.#writes = writes;
        this.#derived = derived;
        this.#getById = getById;
    }

    async link(idOrIds, spec = {}) {
        if (Array.isArray(idOrIds)) {
            return await this.linkMany(idOrIds, spec);
        }
        if (!idOrIds) { throw new Error('Document id required'); }
        return await this.linkOne(idOrIds, normalizeDocumentOperationSpec(spec));
    }

    async linkMany(ids, spec = {}) {
        const normSpec = normalizeDocumentOperationSpec(spec);
        if (!Array.isArray(ids)) {
            throw new Error('Document ID array must be an array');
        }

        const result = {
            successful: [],
            failed: [],
            count: ids.length,
        };

        // Validate IDs upfront
        const validEntries = [];
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (typeof id !== 'number') {
                result.failed.push({ index: i, id, error: 'Invalid document ID: Must be a number.' });
            } else {
                validEntries.push({ index: i, id });
            }
        }

        if (validEntries.length === 0) { return result; }

        // Resolve spec fields once (same for all docs in this batch)
        const contextSpec = normSpec.context ?? null;
        const directorySpec = normSpec.directory ?? null;
        const featureBitmaps = parseBitmapArray(normSpec.features);

        // Batch-fetch all documents at once
        const validIds = validEntries.map(e => e.id);
        const rawDocs = await this.#documents.getMany(validIds);

        const toProcess = [];
        for (let i = 0; i < validEntries.length; i++) {
            const { index, id } = validEntries[i];
            const docData = rawDocs[i];
            if (!docData) {
                result.failed.push({ index, id, error: `Document with ID "${id}" not found` });
                continue;
            }
            const doc = parseInitializeDocument(docData);
            const docFeatures = [...featureBitmaps];
            for (const key of documentFeatureKeys(doc)) {
                if (!docFeatures.includes(key)) { docFeatures.push(key); }
            }
            for (const key of schemaBitmapKeys(doc)) {
                if (!docFeatures.includes(key)) { docFeatures.push(key); }
            }
            toProcess.push({ index, id, docFeatures });
        }

        if (toProcess.length === 0) { return result; }

        // Single transaction for all index operations
        try {
            await this.#writes.withDeferredMembership(async () => {
                for (const { id, docFeatures } of toProcess) {
                    await this.#derived.indexDocument(id, contextSpec, directorySpec, docFeatures);
                }
            });
        } catch (error) {
            for (const { index, id } of toProcess) {
                result.failed.push({ index, id, error: error.message || 'Transaction failed' });
            }
            return result;
        }

        for (const { index, id } of toProcess) {
            result.successful.push({ index, id });
        }

        // One event per op, not per document: a lone doc gets a single event,
        // many docs collapse into batch events. Linking a folder of 1300 docs
        // otherwise emitted ~2600 socket messages and froze the browser.
        try {
            const ids = toProcess.map((e) => e.id);
            const delta = membershipDelta(
                { context: contextSpec, directory: directorySpec },
                { memberships: { context: contextSpec, directory: directorySpec } },
            );
            const shared = { ...delta, reason: 'membership', ...(normSpec.provenance || {}) };

            // DEPRECATED membership-only alias (see #linkOne).
            if (ids.length === 1) {
                this.#writes.emit(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, { id: ids[0], ...shared }));
            } else if (ids.length > 1) {
                this.#writes.emit(EVENTS.DOCUMENT_UPDATED_BATCH, createEvent(EVENTS.DOCUMENT_UPDATED_BATCH, { ids, ...shared }));
            }

            // First-class membership events. A lone document gets the singular
            // form WITH its document — same contract as #linkOne, one read —
            // so a rule matching on content behaves identically whether the
            // caller went through link() or linkMany([one]). Bulk links stay
            // id-only: loading 1000 documents to serve consumers that may not
            // want them is the cost this whole event family avoids, and the
            // consumer that does want them hydrates per document on fan-out.
            if (ids.length === 1) {
                const linkedData = await this.#documents.get(ids[0]);
                const linkedDocument = linkedData ? parseDocumentData(linkedData) : null;
                if (linkedDocument) {
                    this.#writes.emit(EVENTS.DOCUMENT_LINKED, createEvent(EVENTS.DOCUMENT_LINKED, {
                        id: ids[0], document: linkedDocument, ...shared,
                    }));
                }
            } else if (ids.length > 1) {
                this.#writes.emit(EVENTS.DOCUMENT_LINKED_BATCH, createEvent(EVENTS.DOCUMENT_LINKED_BATCH, {
                    ids, count: ids.length, ...shared,
                }));
            }

            // Tree-scoped events drive the web UI content refresh + browser
            // extension. Batch helper handles the single/none cases internally.
            this.#trees.emitDocumentEvent(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, 'context', contextSpec, ids);
            this.#trees.emitDocumentEvent(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, 'directory', directorySpec, ids);
        } catch (eventError) {
            debug(`linkMany: Failed to emit events: ${eventError.message}`);
        }

        return result;
    }

    async linkOne(docId, contextSpec = { path: '/' }, featureBitmapArray = [], emitEvent = true) {
        if (!docId) { throw new Error('Document id required'); }

        let directorySpec = null;
        let provenance = null;
        if (isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
            emitEvent = opts.emitEvent ?? emitEvent;
            provenance = normalizeProvenance(opts.provenance);
        }

        const numericId = typeof docId === 'string' ? parseInt(docId, 10) : docId;
        if (!Number.isInteger(numericId)) {
            throw new Error('Document identifier must be a numeric ID');
        }

        const storedDocument = await this.#getById(numericId);
        if (!storedDocument) {
            throw new Error(`Document with ID "${numericId}" not found`);
        }

        const featureBitmaps = parseBitmapArray(featureBitmapArray).filter(Boolean);
        // What the CALLER asked to tick, before the schema keys the engine
        // re-ticks on every link are folded in. Those keys are not a delta —
        // the document already had them — so they belong in the write path,
        // not in an event that says "here is what changed".
        const requestedFeatures = [...featureBitmaps];
        for (const key of schemaBitmapKeys(storedDocument)) {
            if (!featureBitmaps.includes(key)) { featureBitmaps.push(key); }
        }

        await this.#writes.withDeferredMembership(async () => {
            await this.#derived.indexDocument(numericId, contextSpec, directorySpec, featureBitmaps);
        });

        if (emitEvent) {
            const treeType = contextSpec ? 'context' : (directorySpec ? 'directory' : null);
            const treeSpec = contextSpec ?? directorySpec;
            if (treeType && treeSpec) {
                const { tree } = this.#trees.resolveSelection(treeType, treeSpec, treeType === 'context' ? '/' : null);
                tree.emit(EVENTS.TREE_DOCUMENT_INSERTED, createEvent(EVENTS.TREE_DOCUMENT_INSERTED, {
                    documentId: numericId,
                    contextSpec,
                    directorySpec,
                    source: 'tree',
                }));
            }
            const delta = membershipDelta(
                { context: contextSpec, directory: directorySpec, features: requestedFeatures },
                { memberships: { context: contextSpec, directory: directorySpec, features: featureBitmaps } },
            );
            // DEPRECATED membership-only alias — no document, so automation
            // cannot match on content. Superseded by document.linked below.
            this.#writes.emit(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, {
                id: numericId,
                ...delta,
                reason: 'membership',
                ...(provenance || {}),
            }));
            // First-class membership event carrying the full document so
            // automation (hooks/rules) can match on content.
            this.#writes.emit(EVENTS.DOCUMENT_LINKED, createEvent(EVENTS.DOCUMENT_LINKED, {
                id: numericId,
                document: storedDocument,
                ...delta,
                reason: 'membership',
                ...(provenance || {}),
            }));
        }

        return numericId;
    }

    async unlink(idOrIds, spec = {}) {
        if (Array.isArray(idOrIds)) {
            return await this.unlinkMany(idOrIds, spec);
        }
        if (!idOrIds) { throw new Error('Document id required'); }
        // `spec` is the OPTIONS argument (4th), not the feature array (3rd) —
        // features are unwrapped from the normalized spec inside. Passing it
        // third silently dropped `recursive`, so unlink(id, { recursive:true })
        // unticked only the leaf layer while unlinkMany([id], …) honoured it.
        return await this.unlinkOne(idOrIds, normalizeDocumentOperationSpec(spec), [], spec);
    }

    async unlinkMany(ids, spec = {}) {
        const normSpec = normalizeDocumentOperationSpec(spec);
        // `recursive` rides in on the spec (Workspace.unlinkMany spreads its options
        // into the spec). There is no separate `options` param here.
        const recursive = Boolean(spec.recursive);
        if (!Array.isArray(ids)) {
            throw new Error('Document ID array must be an array');
        }

        const result = {
            successful: [],
            failed: [],
            count: ids.length,
        };

        // Validate IDs upfront
        const validEntries = [];
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (typeof id !== 'number') {
                result.failed.push({ index: i, id, error: 'Invalid document ID: Must be a number.' });
            } else {
                validEntries.push({ index: i, id });
            }
        }

        if (validEntries.length === 0) { return result; }

        // Resolve layers to remove from spec once (same for all docs in this batch)
        const contextSpec = normSpec.context ?? null;
        const directorySpec = normSpec.directory ?? null;
        const featureKeys = parseBitmapArray(normSpec.features).filter(Boolean);
        const layersToRemove = [];
        const removedContextPaths = [];
        const removedDirectoryPaths = [];

        if (contextSpec) {
            try {
                const { tree: contextTree, collection: contextCollection, path: normalizedContextSpec } = this.#trees.resolveSelection('context', contextSpec, '/');
                const pathLayersArray = parseContextSpecForInsert(normalizedContextSpec);
                for (const pathLayers of pathLayersArray) {
                    if (pathLayers.length === 1 && pathLayers[0] === '/') {
                        throw new Error('Cannot unlink from root context "/". Unlink a real path or delete the document.');
                    }
                    const filteredLayers = pathLayers.filter((context) => context !== '/');
                    if (filteredLayers.length === 0) {
                        throw new Error('Cannot unlink from root context "/". Unlink a real path or delete the document.');
                    }
                    const targetLayers = recursive
                        ? filteredLayers
                        : [filteredLayers[filteredLayers.length - 1]];
                    const layerIds = contextTree.resolveLayerIds(targetLayers);
                    layersToRemove.push(...layerIds.map((layerId) => contextCollection.makeKey(layerId)));
                    removedContextPaths.push(...unlinkedContextPaths(filteredLayers, recursive));
                }
            } catch (error) {
                for (const { index, id } of validEntries) {
                    result.failed.push({ index, id, error: error.message });
                }
                return result;
            }
        }

        if (directorySpec) {
            try {
                const { tree: directoryTree, collection: directoryCollection, path: normalizedDirectoryPath } = this.#trees.resolveSelection('directory', directorySpec, '/');
                const directoryPaths = Array.isArray(normalizedDirectoryPath) ? normalizedDirectoryPath : [normalizedDirectoryPath];
                for (const directoryPath of directoryPaths) {
                    const nodeIds = directoryTree.getNodeIdsForPath(directoryPath, { recursive });
                    layersToRemove.push(...nodeIds.map((nodeId) => directoryCollection.makeKey(nodeId)));
                    if (nodeIds.length > 0) {
                        removedDirectoryPaths.push(directoryPath);
                    }
                }
            } catch (error) {
                for (const { index, id } of validEntries) {
                    result.failed.push({ index, id, error: error.message });
                }
                return result;
            }
        }

        layersToRemove.push(...normalizeBitmapKeys(featureKeys));
        const uniqueLayers = Array.from(new Set(layersToRemove));

        // Single transaction for all membership removals
        try {
            await this.#writes.withDeferredMembership(async () => {
                for (const { id } of validEntries) {
                    if (uniqueLayers.length > 0) {
                        await this.#writes.removeDocumentMembership(id, uniqueLayers);
                    }
                }
            });
        } catch (error) {
            for (const { index, id } of validEntries) {
                result.failed.push({ index, id, error: error.message || 'Transaction failed' });
            }
            return result;
        }

        for (const { index, id } of validEntries) {
            result.successful.push({ index, id });
        }

        // One event per op: single for a lone doc, batch otherwise (avoids a
        // socket-emit storm on large bulk removes).
        try {
            const ids = validEntries.map((e) => e.id);
            const shared = {
                ...membershipDelta(
                    { context: removedContextPaths, directory: removedDirectoryPaths, features: featureKeys },
                    {
                        contextArray: removedContextPaths,
                        directoryArray: removedDirectoryPaths,
                        featureArray: featureKeys,
                    },
                ),
                recursive,
                reason: 'membership',
                ...(normSpec.provenance || {}),
            };

            // DEPRECATED membership-only alias (see #unlinkOne).
            if (ids.length === 1) {
                this.#writes.emit(EVENTS.DOCUMENT_REMOVED, createEvent(EVENTS.DOCUMENT_REMOVED, { id: ids[0], ...shared }));
            } else if (ids.length > 1) {
                this.#writes.emit(EVENTS.DOCUMENT_REMOVED_BATCH, createEvent(EVENTS.DOCUMENT_REMOVED_BATCH, { ids, ...shared }));
            }

            // First-class membership events, mirroring linkMany: singular WITH
            // the document for a lone id, id-only batch beyond that.
            if (ids.length === 1) {
                const unlinkedData = await this.#documents.get(ids[0]);
                const unlinkedDocument = unlinkedData ? parseDocumentData(unlinkedData) : null;
                if (unlinkedDocument) {
                    this.#writes.emit(EVENTS.DOCUMENT_UNLINKED, createEvent(EVENTS.DOCUMENT_UNLINKED, {
                        id: ids[0], document: unlinkedDocument, ...shared,
                    }));
                }
            } else if (ids.length > 1) {
                this.#writes.emit(EVENTS.DOCUMENT_UNLINKED_BATCH, createEvent(EVENTS.DOCUMENT_UNLINKED_BATCH, {
                    ids, count: ids.length, ...shared,
                }));
            }

            // Tree-scoped events drive cross-client auto-close (browser extension)
            // and web UI refresh — they carry the path + tree id/name the consumers
            // match on. Emit for whichever tree(s) the unlink touched.
            this.#trees.emitDocumentEvent(EVENTS.TREE_DOCUMENT_REMOVED_BATCH, 'context', contextSpec, ids);
            this.#trees.emitDocumentEvent(EVENTS.TREE_DOCUMENT_REMOVED_BATCH, 'directory', directorySpec, ids);
        } catch (eventError) {
            debug(`unlinkMany: Failed to emit events: ${eventError.message}`);
        }

        return result;
    }

    // Removes documents from context and/or feature bitmaps
    async unlinkOne(docId, contextSpec = { path: '/' }, featureBitmapArray = [], options = { recursive: false }) {
        if (!docId) { throw new Error('Document id required'); }
        if (typeof options !== 'object') { options = { recursive: false }; }

        let directorySpec = null;
        let provenance = null;
        if (isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
            provenance = normalizeProvenance(opts.provenance);
        }

        const featureKeys = normalizeBitmapKeys(featureBitmapArray);
        const layersToRemove = [];
        const removedContextPaths = [];
        const removedDirectoryPaths = [];

        if (contextSpec) {
            const { tree: contextTree, collection: contextCollection, path: normalizedContextSpec } = this.#trees.resolveSelection('context', contextSpec, '/');
            const pathLayersArray = parseContextSpecForInsert(normalizedContextSpec);

            for (const pathLayers of pathLayersArray) {
                if (pathLayers.length === 1 && pathLayers[0] === '/') {
                    throw new Error('Cannot unlink from root context "/". Unlink a real path or delete the document.');
                }

                const filteredLayers = pathLayers.filter((context) => context !== '/');
                if (filteredLayers.length === 0) {
                    throw new Error('Cannot unlink from root context "/". Unlink a real path or delete the document.');
                }

                const targetLayers = options.recursive
                    ? filteredLayers
                    : [filteredLayers[filteredLayers.length - 1]];
                const layerIds = contextTree.resolveLayerIds(targetLayers);
                layersToRemove.push(...layerIds.map((layerId) => contextCollection.makeKey(layerId)));
                removedContextPaths.push(...unlinkedContextPaths(filteredLayers, options.recursive));
            }
        }

        if (directorySpec) {
            const { tree: directoryTree, collection: directoryCollection, path: normalizedDirectoryPath } = this.#trees.resolveSelection('directory', directorySpec, '/');
            const directoryPaths = Array.isArray(normalizedDirectoryPath) ? normalizedDirectoryPath : [normalizedDirectoryPath];

            for (const directoryPath of directoryPaths) {
                const nodeIds = directoryTree.getNodeIdsForPath(directoryPath, { recursive: Boolean(options.recursive) });
                layersToRemove.push(...nodeIds.map((nodeId) => directoryCollection.makeKey(nodeId)));
                if (nodeIds.length > 0) {
                    removedDirectoryPaths.push(directoryPath);
                }
            }
        }

        layersToRemove.push(...featureKeys);

        try {
            if (layersToRemove.length > 0) {
                await this.#writes.withDeferredMembership(async () => {
                    await this.#writes.removeDocumentMembership(docId, Array.from(new Set(layersToRemove)));
                });
                debug(`unlink: Removed doc ${docId} from ${layersToRemove.length} layers via Synapses`);
            }

            const delta = membershipDelta(
                { context: removedContextPaths, directory: removedDirectoryPaths, features: featureKeys },
                {
                    contextArray: removedContextPaths,
                    directoryArray: removedDirectoryPaths,
                    featureArray: featureKeys,
                },
            );
            // DEPRECATED membership-only alias — superseded by
            // document.unlinked below, which carries the document.
            this.#writes.emit(EVENTS.DOCUMENT_REMOVED, createEvent(EVENTS.DOCUMENT_REMOVED, {
                id: docId,
                ...delta,
                recursive: options.recursive,
                reason: 'membership',
                ...(provenance || {}),
            }));
            // First-class membership event carrying the full document (still in
            // the store — unlink only drops memberships) so automation can match
            // on content. Omitted if the document is gone.
            try {
                const unlinkedData = await this.#documents.get(docId);
                if (unlinkedData) {
                    this.#writes.emit(EVENTS.DOCUMENT_UNLINKED, createEvent(EVENTS.DOCUMENT_UNLINKED, {
                        id: docId,
                        document: parseDocumentData(unlinkedData),
                        ...delta,
                        recursive: options.recursive,
                        reason: 'membership',
                        ...(provenance || {}),
                    }));
                }
            } catch (error) {
                debug(`unlink: document.unlinked emit skipped for ${docId}: ${error.message}`);
            }
            return docId;
        } catch (error) {
            debug(`Error during unlink for ID ${docId}: ${error.message}`);
            throw error;
        }
    }
}
