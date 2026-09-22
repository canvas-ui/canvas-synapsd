'use strict';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { RoaringBitmap32 } = require('roaring');

import { parseSpec } from '../utils/spec.js';
import { parseContextSpecForInsert } from '../utils/parsing.js';
import { parseFilters, applyTimelineFilter, applyGeoFilter } from '../utils/filters.js';
import { normalizeBitmapKeys, normalizeBitmapKey } from '../indexes/bitmaps/lib/keys.js';

// Resolves scopes and records exactly which memberships a session depends on.
export default class CandidateResolver {
    #bitmapIndex;
    #documents;
    #trees;
    #getLiveDocumentsBitmap;
    #getTimelineIndex;
    #getGeoIndex;
    #getEdges;

    constructor({ bitmapIndex, documents, trees, getLiveDocumentsBitmap, getTimelineIndex, getGeoIndex, getEdges }) {
        this.#bitmapIndex = bitmapIndex;
        this.#documents = documents;
        this.#trees = trees;
        this.#getLiveDocumentsBitmap = getLiveDocumentsBitmap;
        this.#getTimelineIndex = getTimelineIndex;
        this.#getGeoIndex = getGeoIndex;
        this.#getEdges = getEdges;
    }


    // ========================================
    // Read surface: resolveCandidates + rank
    // ========================================
    //
    // The public read API is list() + query(). Both are thin callers of one seam:
    //   resolveCandidates(spec) -> { bitmap, keys, collectionKeys, coarse }
    //   rank(bitmap, match, opts) -> page             match=null slices, else fts/vector/hybrid
    // The db stays stateless. `keys` is the legacy human-readable key list;
    // `collectionKeys` are the real bitmap keys consulted (collection vocabulary)
    // so a QuerySession can intersect them against membership.changed signals for
    // precise invalidation; `coarse` flags a temporal (BSI) dependency that has no
    // stable key and must be re-resolved on any relevant write. Nothing cached here.

    async resolveCandidates(rawSpec = {}) {
        return await this.resolveParsed(parseSpec(rawSpec));
    }

    async resolveParsed(parsed) {
        const { paths, features, filters, rel = [], ids = null } = parsed;
        const keys = [];
        // collectionKeys: the actual bitmap keys (collection vocabulary) consulted,
        // for precise QuerySession invalidation. coarse: this candidate set depends
        // on an operand with no stable key (temporal BSI range) → consumers must
        // re-resolve it on any relevant write rather than key-intersect.
        const collectionKeys = [];
        let coarse = false;
        let bitmap = null;
        let constrained = false;

        // Datasets (data/dataset/*) get their own algebra bucket. Every doc
        // implicitly belongs to the VIRTUAL 'default' dataset (= stamped with no
        // dataset); the candidate set is intersected with OR(selected datasets),
        // and 'default' starts selected. So: anyOf data/dataset/X ADDS the
        // dataset to the mix, allOf shows only it (the feature AND constrains),
        // noneOf deselects. anyOf/noneOf dataset keys are pulled OUT of the
        // generic feature buckets — a plain anyOf union would let dataset docs
        // bypass the caller's other feature filters.
        const DATASET_PREFIX = 'data/dataset/';
        const DEFAULT_DATASET_KEY = `${DATASET_PREFIX}default`;
        const isDatasetKey = (key) => normalizeBitmapKey(key)?.startsWith(DATASET_PREFIX);
        const selectedDatasets = new Set([DEFAULT_DATASET_KEY]);
        // allOf 'default' means "only unstamped docs" — there is no physical
        // bitmap to AND (default is virtual), so it resolves as the selection
        // {default} alone. Combined with an allOf NAMED dataset the result is
        // correctly empty (a doc cannot be both stamped and unstamped).
        const allOfDefault = features.allOf.some((key) => normalizeBitmapKey(key) === DEFAULT_DATASET_KEY);
        for (const key of [...features.allOf, ...features.anyOf].filter(isDatasetKey)) {
            selectedDatasets.add(normalizeBitmapKey(key));
        }
        for (const key of features.noneOf.filter(isDatasetKey)) {
            selectedDatasets.delete(normalizeBitmapKey(key));
        }
        if (allOfDefault) {
            selectedDatasets.clear();
            selectedDatasets.add(DEFAULT_DATASET_KEY);
        }
        // Named allOf keys stay in the bucket (the feature AND constrains);
        // 'default' has no physical bitmap and must not reach bitmapIndex.AND.
        features.allOf = features.allOf.filter((key) => normalizeBitmapKey(key) !== DEFAULT_DATASET_KEY);
        features.anyOf = features.anyOf.filter((key) => !isDatasetKey(key));
        features.noneOf = features.noneOf.filter((key) => !isDatasetKey(key));

        const includeBitmap = await this.#buildPathsBitmap(paths.in, keys, collectionKeys);
        if (includeBitmap) {
            bitmap = includeBitmap;
            constrained = true;
        }

        const featureBitmap = await this.buildFeaturesBitmap(features);
        if (featureBitmap) {
            keys.push(...features.allOf, ...features.anyOf, ...features.noneOf);
            // Feature keys are already collection vocabulary (same normalization as
            // membership feature keys), so they intersect tick keys directly.
            collectionKeys.push(...normalizeBitmapKeys([...features.allOf, ...features.anyOf, ...features.noneOf]));
            if (bitmap) { bitmap.andInPlace(featureBitmap); } else { bitmap = featureBitmap; }
            constrained = true;
        }

        if (filters.length > 0) {
            const { bitmapFilters, timelineFilters, geoFilters } = parseFilters(filters);
            if (bitmapFilters.length > 0) {
                const filterKeys = normalizeBitmapKeys(bitmapFilters);
                keys.push(...filterKeys);
                collectionKeys.push(...filterKeys);
                const filterBitmap = await this.#bitmapIndex.AND(filterKeys);
                if (bitmap) { bitmap.andInPlace(filterBitmap); } else { bitmap = filterBitmap; }
                constrained = true;
            }
            if (timelineFilters.length > 0) {
                const timelineBitmap = await this.#combineTimelineFilters(timelineFilters);
                keys.push(...timelineFilters.map((f) => `t:${f.name}`));
                // Temporal filters live in BSI tiers, not stable membership keys —
                // a write does not tick a key we can intersect. Mark coarse.
                coarse = true;
                if (bitmap) { bitmap.andInPlace(timelineBitmap); } else { bitmap = timelineBitmap; }
                constrained = true;
            }
            if (geoFilters.length > 0) {
                const geoBitmap = await this.#combineGeoFilters(geoFilters);
                keys.push(...geoFilters.map((f) => `geo:${f.kind}`));
                // Spatial filters live in the S2 BSI — same no-stable-key story
                // as temporal ones. Mark coarse.
                coarse = true;
                if (bitmap) { bitmap.andInPlace(geoBitmap); } else { bitmap = geoBitmap; }
                constrained = true;
            }
        }

        // Graph adjacency: one hop from a known document, composed under the same
        // sigil algebra as features and the BSI filter families.
        if (rel.length > 0) {
            const relBitmap = await this.#combineRelFilters(rel);
            keys.push(...rel.map((r) => `rel:${r.dir}:${r.p}:${r.of}`));
            // A rel operand is built from a dupsort scan, so it has NO stable
            // bitmap key — link()/unlink() fire no membership event a QuerySession
            // could intersect, and a cached operand would go stale silently. Same
            // no-stable-key story as the temporal and spatial families: mark
            // coarse so consumers re-resolve rather than key-invalidate.
            coarse = true;
            if (bitmap) { bitmap.andInPlace(relBitmap); } else { bitmap = relBitmap; }
            constrained = true;
        }

        // Literal id-set from an external producer (kNN results, sensor anchor
        // emissions, an agent-curated working set). No collection keys and never
        // coarse: the set only changes when the caller replaces it, so a live
        // QuerySession caches it with zero invalidation cost. [] constrains to
        // the empty set — distinct from absent (unconstrained).
        if (ids) {
            keys.push(`ids:${ids.length}`);
            const idBitmap = new RoaringBitmap32(ids);
            if (bitmap) { bitmap.andInPlace(idBitmap); } else { bitmap = idBitmap; }
            constrained = true;
        }

        if (paths.not.length > 0) {
            const excludeBitmap = await this.#buildPathsBitmap(paths.not, keys, collectionKeys);
            if (excludeBitmap && !excludeBitmap.isEmpty) {
                const base = bitmap || await this.allDocumentsBitmap();
                base.andNotInPlace(excludeBitmap);
                bitmap = base;
                constrained = true;
            }
        }

        // Apply the dataset selection: candidate ∩ (default ∪ OR(selected named)).
        // 'default' is virtual — candidate \ OR(all named dataset bitmaps). Until
        // the first dataset exists this is a no-op, preserving the bitmap:null
        // fast path for unconstrained listings.
        const allDatasetKeys = await this.#bitmapIndex.listBitmaps(DATASET_PREFIX);
        const defaultSelected = selectedDatasets.has(`${DATASET_PREFIX}default`);
        const namedSelected = [...selectedDatasets].filter((key) => key !== `${DATASET_PREFIX}default` && allDatasetKeys.includes(key));
        if (allDatasetKeys.length > 0 && !(defaultSelected && namedSelected.length === allDatasetKeys.length)) {
            collectionKeys.push(...allDatasetKeys);
            const base = bitmap || await this.allDocumentsBitmap();
            const selectedUnion = namedSelected.length > 0 ? await this.#bitmapIndex.OR(namedSelected) : null;
            if (defaultSelected) {
                // (candidate \ all-datasets) ∪ (candidate ∩ selected-datasets)
                const keep = selectedUnion ? RoaringBitmap32.and(base, selectedUnion) : null;
                base.andNotInPlace(await this.#bitmapIndex.OR(allDatasetKeys));
                if (keep) { base.orInPlace(keep); }
            } else if (selectedUnion) {
                // default deselected: only the selected datasets remain
                base.andInPlace(selectedUnion);
            } else {
                // nothing selected at all
                base.andInPlace(new RoaringBitmap32());
            }
            bitmap = base;
            constrained = true;
        }

        return {
            bitmap: constrained ? (bitmap || new RoaringBitmap32()) : null,
            keys,
            collectionKeys: Array.from(new Set(collectionKeys)),
            coarse,
        };
    }

    // Union bitmap for a set of {type, path} entries; null when there are none.
    // collectionKeys (optional) collects the real bitmap keys consulted per entry
    // (context/<treeId>/<layerId>, vfs/<treeId>/<nodeId>) for precise invalidation.
    async #buildPathsBitmap(entries = [], keys = [], collectionKeys = null) {
        if (!Array.isArray(entries) || entries.length === 0) { return null; }
        let result = null;
        for (const { type, path, tree, recursive } of entries) {
            keys.push(`${type}:${path}`);
            const selector = { path, ...(tree ? { tree } : {}), ...(recursive ? { recursive: true } : {}) };
            const bm = type === 'directory'
                ? await this.#buildDirectorySelectorBitmap(selector, collectionKeys)
                : await this.#buildContextSelectorBitmap(selector, collectionKeys);
            if (!bm) { continue; }
            if (result) { result.orInPlace(bm); } else { result = bm; }
        }
        return result;
    }

    async #combineTimelineFilters(timelineFilters) {
        return await this.#combineSigilFilters(timelineFilters, (f) => applyTimelineFilter(f, this.#getTimelineIndex()));
    }

    // One rel entry -> the sorted adjacency list for (of, p) in the requested
    // direction, lifted into an ephemeral bitmap. `new RoaringBitmap32(array)` is
    // fine here: the dupsort iteration is already sorted. A multi-id `of` unions
    // its adjacency lists into ONE operand (see parseRel) before the sigil
    // algebra runs.
    async #combineRelFilters(relFilters) {
        return await this.#combineSigilFilters(relFilters, (f) => {
            const anchors = Array.isArray(f.of) ? f.of : [f.of];
            const bitmap = new RoaringBitmap32();
            for (const anchor of anchors) {
                const iterator = f.dir === 'in'
                    ? this.#getEdges().incoming(anchor, f.p)
                    : this.#getEdges().outgoing(anchor, f.p);
                // Drain promptly — a live iterator pins an LMDB read txn.
                bitmap.orInPlace(new RoaringBitmap32([...iterator]));
            }
            return bitmap;
        });
    }

    async #combineGeoFilters(geoFilters) {
        return await this.#combineSigilFilters(geoFilters, async (f) => {
            const geo = this.#getGeoIndex();
            if (f.kind !== 'missing') { return applyGeoFilter(f, geo); }
            const missing = await this.allDocumentsBitmap();
            if (geo) { missing.andNotInPlace(await geo.locatedBitmap()); }
            return missing;
        });
    }

    // Shared sigil algebra for BSI-backed filter families (timeline, geo):
    // AND(allOf) ∩ OR(anyOf) \ OR(noneOf). Returns a bitmap (never null) when
    // given a non-empty filter set.
    async #combineSigilFilters(filters, apply) {
        const bySigil = { allOf: [], anyOf: [], noneOf: [] };
        for (const filter of filters) { bySigil[filter.sigil].push(filter); }

        const orOf = async (list) => {
            const result = new RoaringBitmap32();
            for (const filter of list) { result.orInPlace(await apply(filter)); }
            return result;
        };

        let positive = null;
        if (bySigil.allOf.length > 0) {
            for (const filter of bySigil.allOf) {
                const bm = await apply(filter);
                if (positive) { positive.andInPlace(bm); } else { positive = bm; }
            }
        }
        if (bySigil.anyOf.length > 0) {
            const anyBitmap = await orOf(bySigil.anyOf);
            if (positive) { positive.andInPlace(anyBitmap); } else { positive = anyBitmap; }
        }
        if (bySigil.noneOf.length > 0) {
            const base = positive || await this.allDocumentsBitmap();
            base.andNotInPlace(await orOf(bySigil.noneOf));
            positive = base;
        }

        return positive || new RoaringBitmap32();
    }

    #normalizeQueryFeatures(features) {
        if (!features) {
            return null;
        }

        if (Array.isArray(features)) {
            return {
                allOf: [],
                anyOf: normalizeBitmapKeys(features),
                noneOf: [],
            };
        }

        if (typeof features !== 'object') {
            throw new Error('list(): features must be an array or object');
        }

        return {
            allOf: normalizeBitmapKeys(features.allOf ?? []),
            anyOf: normalizeBitmapKeys(features.anyOf ?? []),
            noneOf: normalizeBitmapKeys(features.noneOf ?? []),
        };
    }

    async buildSelectorBitmap(selector = null) {
        if (!selector) {
            return null;
        }

        if (selector.context || selector.directory) {
            const contextBitmap = selector.context ? await this.#buildContextSelectorBitmap(selector.context) : null;
            const directoryBitmap = selector.directory ? await this.#buildDirectorySelectorBitmap(selector.directory) : null;

            if (contextBitmap && directoryBitmap) {
                contextBitmap.andInPlace(directoryBitmap);
                return contextBitmap;
            }
            return contextBitmap ?? directoryBitmap ?? null;
        }

        if (selector.type === 'context') {
            return await this.#buildContextSelectorBitmap(selector.spec);
        }
        if (selector.type === 'directory') {
            return await this.#buildDirectorySelectorBitmap(selector.spec);
        }

        const selection = this.#trees.resolveGenericSelection(selector, '/', 'context');
        return selection.type === 'directory'
            ? await this.#buildDirectorySelectorBitmap(selection.spec)
            : await this.#buildContextSelectorBitmap(selection.spec);
    }

    async #buildContextSelectorBitmap(contextSpec, collectionKeys = null) {
        if (!contextSpec) {
            return null;
        }

        const { tree, collection, path } = this.#trees.resolveSelection('context', contextSpec, '/');
        const pathLayersArray = parseContextSpecForInsert(path);
        const recordKey = (id) => { if (collectionKeys && id != null) { collectionKeys.push(collection.makeKey(id)); } };
        let resultBitmap = null;
        let sawExplicitPath = false;
        let sawExistingPath = false;

        for (const pathLayers of pathLayersArray) {
            if (pathLayers.length === 1 && pathLayers[0] === '/') {
                sawExplicitPath = true;
                if (tree.rootLayer) { recordKey(tree.rootLayer.id); }
                const rootBitmap = await this.#getContextRootBitmap(tree, collection);
                if (rootBitmap && !rootBitmap.isEmpty) {
                    if (resultBitmap) {
                        resultBitmap.orInPlace(rootBitmap);
                    } else {
                        resultBitmap = rootBitmap;
                    }
                    sawExistingPath = true;
                }
                continue;
            }

            sawExplicitPath = true;
            const pathString = pathLayers.join('/');
            if (!tree.getLayerForPath(pathString)) {
                continue;
            }

            sawExistingPath = true;
            const layerIds = tree.resolveLayerIds(pathLayers);
            // After resolveLayerIds drops canvas leaves and root, an empty result
            // means the path effectively reduces to root (e.g. /<canvas-leaf>).
            // Fall back to the root layer bitmap so canvases anchored directly
            // under '/' return all docs at the root, not zero.
            let pathBitmap;
            if (layerIds.length === 0) {
                if (tree.rootLayer) { recordKey(tree.rootLayer.id); }
                pathBitmap = await this.#getContextRootBitmap(tree, collection);
            } else {
                for (const id of layerIds) { recordKey(id); }
                pathBitmap = await collection.AND(layerIds);
            }
            if (!pathBitmap || pathBitmap.isEmpty) {
                continue;
            }

            if (resultBitmap) {
                resultBitmap.orInPlace(pathBitmap);
            } else {
                resultBitmap = pathBitmap;
            }
        }

        if (!sawExplicitPath) {
            return null;
        }

        return sawExistingPath ? (resultBitmap || new RoaringBitmap32()) : new RoaringBitmap32();
    }

    async #getContextRootBitmap(tree, collection) {
        if (!tree?.rootLayer) {
            return new RoaringBitmap32();
        }
        return await collection.OR([tree.rootLayer.id]);
    }

    async #buildDirectorySelectorBitmap(directorySpec, collectionKeys = null) {
        if (!directorySpec) {
            return null;
        }

        const { tree, collection, path } = this.#trees.resolveSelection('directory', directorySpec, '/');
        const directoryPaths = Array.isArray(path) ? path.filter(Boolean) : [path].filter(Boolean);
        if (directoryPaths.length === 0) {
            return null;
        }

        // Node-exact by default (folder listings); recursive widens to the whole
        // subtree (searches — docs tick only their leaf node, so a node-exact
        // scope at an ancestor folder would match nothing).
        const recursive = directorySpec?.recursive === true;

        let resultBitmap = null;
        let sawExistingPath = false;
        for (const directoryPath of directoryPaths) {
            if (!tree.pathExists(directoryPath)) {
                continue;
            }

            sawExistingPath = true;
            // find() reads exactly the path's own node bitmap (non-recursive) — the
            // same node a doc inserted at this path ticks. Record the consulted
            // collection keys so a write to this scope precisely invalidates the operand.
            if (collectionKeys) {
                for (const nodeId of tree.getNodeIdsForPath(directoryPath, { recursive })) {
                    collectionKeys.push(collection.makeKey(nodeId));
                }
            }
            const directoryBitmap = recursive
                ? await tree.findRecursive(directoryPath)
                : await tree.find(directoryPath);
            if (!directoryBitmap || directoryBitmap.isEmpty) {
                continue;
            }

            if (resultBitmap) {
                resultBitmap.orInPlace(directoryBitmap);
            } else {
                resultBitmap = directoryBitmap;
            }
        }

        return sawExistingPath ? (resultBitmap || new RoaringBitmap32()) : new RoaringBitmap32();
    }

    async buildFeaturesBitmap(features) {
        const normalizedFeatures = this.#normalizeQueryFeatures(features);
        if (!normalizedFeatures) {
            return null;
        }

        const { allOf, anyOf, noneOf } = normalizedFeatures;
        if (allOf.length === 0 && anyOf.length === 0 && noneOf.length === 0) {
            return null;
        }

        let featureBitmap = null;
        if (allOf.length > 0) {
            featureBitmap = await this.#bitmapIndex.AND(allOf);
        }

        if (anyOf.length > 0) {
            const anyBitmap = await this.#bitmapIndex.OR(anyOf);
            if (featureBitmap) {
                featureBitmap.andInPlace(anyBitmap);
            } else {
                featureBitmap = anyBitmap;
            }
        }

        if (noneOf.length > 0) {
            if (!featureBitmap) {
                featureBitmap = await this.allDocumentsBitmap();
            }
            const noneBitmap = await this.#bitmapIndex.OR(noneOf);
            if (noneBitmap && !noneBitmap.isEmpty) {
                featureBitmap.andNotInPlace(noneBitmap);
            }
        }

        return featureBitmap || new RoaringBitmap32();
    }

    // O(1): clone of the maintained live-document bitmap (internal/docs/all).
    // Callers mutate the result in place, hence the clone. Falls back to the
    // full document-store scan only if the maintained bitmap is unavailable.
    async allDocumentsBitmap() {
        if (this.#getLiveDocumentsBitmap()) {
            const bm = await this.#bitmapIndex.getBitmap(this.#getLiveDocumentsBitmap().key, false);
            if (bm) { return new RoaringBitmap32(bm); }
        }
        const ids = [];
        for await (const { key } of this.#documents.getRange()) {
            const id = Number(key);
            if (Number.isInteger(id) && id > 0) {
                ids.push(id);
            }
        }
        return new RoaringBitmap32(ids);
    }
}
