import debugInstance from 'debug';
import { parseLocationUrl } from '../utils/path-helpers.js';
import { parseContextSpecForInsert } from '../utils/parsing.js';
import { normalizeBitmapKeys, normalizeBitmapKey } from '../indexes/bitmaps/lib/keys.js';
import { deviceFacetKeys } from '../utils/device-facets.js';
import { DEVICE_SCHEMA_NAME, ORPHANED_FEATURE, relationKey, documentRelations, COMMENT_BITMAP_KEY } from '../documents/derivation.js';
const debug = debugInstance('canvas:synapsd');

// Row-derived indexes and tree membership selection. Native timeline/geo/edge
// writes join the caller's transaction; feature memberships use WriteCoordinator.
export default class DerivedIndexes {
    #documents; #bitmapIndex; #trees; #writes; #getTimeline; #getGeo; #getEdges; #list;
    #deviceFacets = new Map();
    constructor({ documents, bitmapIndex, trees, writes, getTimeline, getGeo, getEdges, list }) {
        this.#documents = documents;
        this.#bitmapIndex = bitmapIndex;
        this.#trees = trees;
        this.#writes = writes;
        this.#getTimeline = getTimeline;
        this.#getGeo = getGeo;
        this.#getEdges = getEdges;
        this.#list = list;
    }


    /**
     * Shared bitmap indexing for both insert and update operations.
     * Handles: context tree bitmaps, directory tree bitmaps, feature bitmaps, synapses.
     */
    async indexDocument(docId, contextSpec, directorySpec, featureBitmaps) {
        // Union device-presence tags derived from the document's locations so that
        // "what's on device X" is a single bitmap intersection. Conservative: only
        // file://<deviceId>/… locations tick device/id/<deviceId>; non-device URLs
        // (stored://, s3://, http://, imap://) and {WORKSPACE_ROOT}-style placeholders
        // are skipped — their authority is a backend/bucket/host, not a device.
        // Additive (matches existing feature-bitmap semantics); the document is
        // already persisted before this runs in every write path, so we read it back
        // for the canonical location set.
        const features = Array.isArray(featureBitmaps) ? [...featureBitmaps] : [];
        try {
            const stored = await this.#documents.get(docId);
            // A Device document defines the os/type facets other documents derive.
            // Runs before the derivation below so a device's own write sees itself.
            if (stored?.schema === DEVICE_SCHEMA_NAME) { await this.syncDeviceFacets(stored); }
            for (const tag of this.locationDerivedFeatures(stored)) {
                if (!features.includes(tag)) { features.push(tag); }
            }
        } catch (error) {
            // Best-effort: presence tags must never block indexing. But LOG it —
            // this catch silently ate a TypeError for several debugging rounds on
            // 2026-08-03, which looked exactly like "the feature derivation is
            // wrong" rather than "the derivation threw and never ran".
            debug(`Device feature derivation failed for doc ${docId}: ${error.message}`);
        }

        const allSynapseKeys = await this.resolveDocumentMembershipKeys(contextSpec, directorySpec, features);
        await this.#writes.addDocumentMembership(docId, allSynapseKeys);
    }

    /**
     * Derive device feature tags from a document's locations:
     *   device/id/<deviceId>   — presence, one per distinct device-local copy
     *   device/os/<chain>      — family/distro/version of each device it is on,
     *                            every prefix ticked (see deviceFacetKeys)
     *   device/arch/<arch>     — os.machine() vocabulary (x86_64, aarch64)
     *   device/type/<type>     — the type (laptop/desktop/server/…) of each
     *
     * This is the MACHINE axis, not the addressing one — `data/backend/file/<id>`
     * says the bytes are reached as a local path, `device/id/<id>` says which box
     * they are on, and for file:// the two coincide. `device/id` earns its keep as
     * the union over file:// AND device:// and as the join anchor below.
     *
     * Everything past `device/id` is OPTIONAL ENRICHMENT, present only if the app
     * registered a Device document: they resolve through that document (the single
     * source of truth) via #deviceFacets, so "all applications available on
     * Windows" is a plain bitmap AND rather than a join. An unregistered device
     * contributes only its id — the facets appear once its Device document lands
     * and #syncDeviceFacets reconciles. A new facet slots in by being added to
     * deviceFacetKeys; the reconcile is a set difference and needs no per-facet
     * knowledge.
     *
     * @param {Array<{url:string}>} locations
     * @returns {string[]}
     */
    deviceFeaturesFromLocations(locations) {
        const tags = new Set();
        for (const loc of Array.isArray(locations) ? locations : []) {
            const parsed = parseLocationUrl(loc?.url);
            // file://<deviceId>/<path> — the bytes live at a known path on a device.
            // device://<deviceId>      — present on the device with no portable path
            //                            (flatpak/snap/system installs). Without this
            //                            arm, exactly the pathless install types are
            //                            invisible to "what's on device X".
            if (!parsed || (parsed.scheme !== 'file' && parsed.scheme !== 'device')) { continue; }
            const authority = parsed.backend;
            // Skip {WORKSPACE_ROOT}/{VAR} placeholders — workspace-relative, not a device.
            if (!authority || /^\{.*\}$/.test(authority)) { continue; }
            // Normalize to the bitmap-key form the index actually stores (lowercased,
            // sanitized) so derivation, add, and untick all compare apples-to-apples.
            const idKey = normalizeBitmapKey(`device/id/${authority}`);
            tags.add(idKey);

            for (const key of this.#deviceFacets.get(idKey.slice('device/id/'.length)) ?? []) {
                tags.add(key);
            }
        }
        return [...tags];
    }

    /**
     * Load every registered device's queryable facets into memory.
     *
     * Small by construction (a workspace has devices, not documents-worth of
     * them), and read on every write, so it is a Map rather than a lookup.
     */
    async loadDeviceFacets() {
        this.#deviceFacets.clear();
        try {
            const result = await this.#list({ features: [DEVICE_SCHEMA_NAME] });
            const docs = Array.isArray(result) ? result : (result?.data ?? []);
            for (const doc of docs) { this.cacheDeviceFacets(doc); }
            debug(`Loaded facets for ${this.#deviceFacets.size} device(s)`);
        } catch (error) {
            debug(`Device facet preload skipped: ${error.message}`);
        }
    }

    cacheDeviceFacets(deviceDoc) {
        const deviceId = deviceDoc?.data?.deviceId;
        if (!deviceId) { return null; }
        // Key by the normalized form, matching how it appears in device/id/<x>.
        const key = normalizeBitmapKey(`device/id/${deviceId}`).slice('device/id/'.length);
        const facets = deviceFacetKeys(deviceDoc.data);
        this.#deviceFacets.set(key, facets);
        return { key, facets };
    }

    /**
     * Keep derived device facets truthful when a Device document changes.
     *
     * The accepted cost of deriving os/type into stored bitmaps (rather than
     * expanding them at query time) is drift: reinstall a laptop from Windows to
     * Linux and every document on it carries a stale device/os/windows tick. This
     * closes that hole at the only moment it can open — the `device/id/<x>` bitmap
     * names the affected set exactly, so the repair is proportional to the
     * documents on that one device, not to the corpus.
     *
     * Called from #indexDocument, which every write path already goes through.
     */
    async syncDeviceFacets(deviceDoc) {
        const deviceId = deviceDoc?.data?.deviceId;
        if (!deviceId) { return; }

        const key = normalizeBitmapKey(`device/id/${deviceId}`).slice('device/id/'.length);
        const previous = this.#deviceFacets.get(key) ?? [];
        const { facets } = this.cacheDeviceFacets(deviceDoc) ?? {};
        if (!facets) { return; }

        // Both sides come from deviceFacetKeys, so ordering is deterministic and
        // a join-compare is a whole-set equality test.
        if (previous.join('\u0000') === facets.join('\u0000')) { return; }
        debug(`Device ${key} facets changed: ${JSON.stringify(previous)} -> ${JSON.stringify(facets)}`);

        // Recompute per affected document rather than blanket-swapping keys: a
        // document may sit on several devices, and another of them may still
        // legitimately imply the old facets.
        const idKey = `device/id/${key}`;
        const bitmap = await this.#bitmapIndex.getBitmap(idKey, false);
        if (!bitmap || bitmap.isEmpty) { return; }

        // Set difference, so this needs no per-facet knowledge: an OS upgrade
        // retires device/os/linux/ubuntu/22.04 while keeping the two prefixes
        // above it, and a new facet inherits the reconcile by existing.
        const staleKeys = previous.filter((k) => !facets.includes(k));

        for (const docId of bitmap.toArray()) {
            // NB: documents.get() is SYNCHRONOUS (lmdb-js returns the value, not a
            // promise) — do not attach .catch() to it.
            const stored = await this.#documents.get(docId);
            if (!stored) { continue; }
            const current = new Set(this.deviceFeaturesFromLocations(stored.locations));
            const drop = staleKeys.filter((k) => !current.has(k));
            if (drop.length) { await this.#writes.applyMembership('untick', docId, drop); }
            const add = [...current].filter((k) => !k.startsWith('device/id/'));
            if (add.length) { await this.#writes.applyMembership('tick', docId, add); }
        }
    }

    /**
     * Untick device-presence tags a write dropped from the document's locations.
     * Powers dedup/cleanup: when a copy disappears from locations (an agent prunes a
     * stale path, a device loses the file), its device/id/<id> bitmap is removed so
     * "what's on device X" stays accurate. A tag the caller explicitly re-asserts in
     * this write (assertedFeatures, e.g. the writing-client tag) is never unticked.
     * @param {number} docId
     * @param {Array<{url:string}>} previousLocations  locations before the write
     * @param {Array<{url:string}>} currentLocations   locations after the write
     * @param {string[]} assertedFeatures              tags explicitly set this write
     */
    /**
     * Derive backend feature tags from a document's locations:
     *   data/backend/<scheme>              — roll-up ("everything from IMAP")
     *   data/backend/<scheme>/<authority>  — the specific store/account/bucket
     *
     * Deliberately GENERIC: synapsd knows nothing about `stored`, S3 or IMAP — it
     * parses a URL into scheme + authority exactly as it already does for
     * file://<deviceId>. That keeps the storage subsystem's vocabulary out of the
     * index, which is the reason this replaced the parent asserting the tags.
     *
     * Hierarchical (tick parent AND child), same contract as data/mime/*:
     * "everything from IMAP" is one key with no enumeration of accounts. Note the inherited caveat — listBitmaps(prefix) range-scans
     * `prefix + '/'`, so a bare `data/backend/imap` is invisible to a prefix
     * listing of its own namespace; list `data/backend/` instead. Safe here
     * because the parent is ALWAYS ticked.
     *
     * NO scheme is exempt, including `file://` and `device://`. They were skipped
     * until 2026-08-25 on the grounds that `device/id/*` already answered "where
     * do these bytes live" for device-local copies, which conflated two axes:
     * `data/backend/*` is the ADDRESSING mode (how the bytes are reached),
     * `device/*` is the MACHINE (which box, and what that box is). A local
     * filesystem is an addressing mode like any other, so `file://laptop1/x`
     * ticks `data/backend/file` + `data/backend/file/laptop1`.
     *
     * The exemption also cost a query nothing else could answer: `data/backend/file`
     * AND NOT `data/backend/stored` is "exists only as a loose local file",
     * i.e. backup coverage. Under the skip that needed every device enumerated.
     *
     * `device/id/*` stays, and is not made redundant by this: it is the UNION of
     * the file:// and device:// keys for one authority, so "on laptop1" remains a
     * single key, and it is the anchor #syncDeviceFacets joins os/type onto.
     *
     * `data/source/*` is GONE, folded into this axis (decided 2026-08-03): once
     * both derive from locations[] they are two projections of the same fact, and
     * the provider is a property of the backend, not of the document.
     */
    backendFeaturesFromLocations(locations) {
        const tags = new Set();

        for (const loc of Array.isArray(locations) ? locations : []) {
            // An explicitly declared backend REPLACES the URL's answer rather than
            // adding to it, because the case it exists for is the URL lying: a NAS
            // mounted at /mnt/nas is addressed `file://<deviceId>/mnt/nas/…` but
            // the bytes are not on that device. Reading it here is still generic
            // (a location-metadata key, not a `stored` concept).
            //
            // Wart: a declared name is flat (`homenas`), so it lands at the level
            // where every other entry is a scheme. Harmless while the two
            // vocabularies do not collide, and not worth a `declared/` prefix that
            // every consumer would have to learn.
            const declared = typeof loc?.metadata?.backend === 'string' ? loc.metadata.backend.trim() : '';
            if (declared) {
                tags.add(`data/backend/${declared}`);
                continue;
            }

            const parsed = parseLocationUrl(loc?.url);
            if (!parsed) { continue; }

            tags.add(`data/backend/${parsed.scheme}`);
            const authority = parsed.backend;
            // Skip {WORKSPACE_ROOT}/{VAR} placeholders — workspace-relative, not an
            // addressable store (same guard as the device derivation).
            if (authority && !/^\{.*\}$/.test(authority)) {
                tags.add(`data/backend/${parsed.scheme}/${authority}`);
            }
        }

        return normalizeBitmapKeys([...tags]);
    }

    /**
     * Derive asserted edges from `data.relations`, as a DIFF against the document's
     * previous relations.
     *
     * Asserted edges are OWNED by the row: an update that drops an entry drops the
     * edge. But it must not touch a DERIVED edge between the same pair — an
     * extractor's `mentions` edge is not the client's to delete. Provenance
     * distinguishes them: an asserted edge has no meta row (`edge().meta.src` is
     * the synthesized `'doc'`), a derived one always does.
     *
     * Dangling `to` ids are allowed and logged at debug: edges to documents that do
     * not exist yet are filtered at query time by candidate-set intersection
     * anyway, and forbidding them would make ingest order significant.
     *
     * Runs inside the caller's transaction, alongside the bitmap/timeline writes.
     */
    syncDocumentRelations(docId, previousRelations, currentRelations) {
        const previous = new Map((previousRelations || []).map((r) => [relationKey(r), r]));
        const current = new Map((currentRelations || []).map((r) => [relationKey(r), r]));

        for (const [key, relation] of current) {
            if (previous.has(key)) { continue; }
            this.#getEdges().link(docId, relation.p, relation.to);
            if (!this.documentExistsSync(relation.to)) {
                debug(`Relation ${docId} --${relation.p}--> ${relation.to} targets a document that does not exist (allowed)`);
            }
        }

        for (const [key, relation] of previous) {
            if (current.has(key)) { continue; }
            const existing = this.#getEdges().edge(docId, relation.p, relation.to);
            // Only asserted edges are the row's to remove.
            if (existing && existing.meta?.src === 'doc') {
                this.#getEdges().unlink(docId, relation.p, relation.to);
            }
        }
    }

    // Cheap existence probe for the dangling-target debug log. `documents.get` is
    // SYNCHRONOUS (lmdb-js returns the value) — attaching .catch() throws.
    documentExistsSync(id) {
        try { return this.#documents.get(id) !== undefined; } catch { return false; }
    }

    // Every feature derived from locations[], in one place — so the stale-diff
    // below can never cover one axis and silently miss another.
    locationDerivedFeatures(doc) {
        const list = Array.isArray(doc?.locations) ? doc.locations : [];
        if (list.length === 0) {
            // The empty-locations guard is what unticks on re-bind; orphanedAt alone
            // would leave the key set on a document that regained a copy.
            return doc?.orphanedAt ? [ORPHANED_FEATURE] : [];
        }
        return [
            ...this.deviceFeaturesFromLocations(list),
            ...this.backendFeaturesFromLocations(list),
        ];
    }

    async removeStaleLocationMembership(docId, previousDoc, currentDoc, assertedFeatures = []) {
        const previous = this.locationDerivedFeatures(previousDoc);
        if (previous.length === 0) { return; }
        const current = new Set(this.locationDerivedFeatures(currentDoc));
        const asserted = new Set((Array.isArray(assertedFeatures) ? assertedFeatures : []).map(normalizeBitmapKey));
        const stale = previous.filter((tag) => !current.has(tag) && !asserted.has(tag));
        if (stale.length > 0) { await this.#writes.removeDocumentMembership(docId, stale); }
    }

    // Geo membership is fully derived from metadata.geo (lat/lon — populated by
    // stored-ingest / embed-time EXIF extraction): valid coords → (re)index the
    // S2 cell, coords gone → drop. The ebm probe keeps the no-geo common case
    // at one cached-bitmap lookup instead of 65 slice unticks.
    async indexDocumentGeo(docId, document) {
        if (!this.#getGeo()) { return; }
        const geo = document?.metadata?.geo;
        const lat = Number(geo?.lat);
        const lon = Number(geo?.lon);
        // Reject out-of-range and exact (0,0): `Number(null)` is 0 and finite, so
        // a { lat: null, lon: null } record would otherwise be indexed on "Null
        // Island" off the Gulf of Guinea and answer bbox queries covering it.
        // That's sentinel data meaning "no location", not a fix at the equator.
        const usable = Number.isFinite(lat) && Number.isFinite(lon)
            && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
            && !(lat === 0 && lon === 0);
        if (usable) {
            await this.#getGeo().insert(docId, lat, lon);
        } else if (await this.#getGeo().has(docId)) {
            await this.#getGeo().remove(docId);
        }
    }

    async indexDocumentTimelines(docId, document) {
        const grouped = this.normalizeDocumentTimelineEntries(document);
        for (const [name, { primary, extras }] of grouped) {
            // The dual-BSI stays the canonical sortable value plane: ONE primary
            // interval per (timeline, doc) — first entry, or the one flagged
            // `primary: true` — which keeps sortBy semantics unambiguous. Every
            // additional entry lands in the tiled membership plane (tsm).
            await this.#getTimeline().insert(name, docId, primary.interval);
            if (extras.length > 0) {
                await this.#getTimeline().insertEntries(name, docId, extras.map((e) => e.interval));
            }
        }
    }

    async removeDocumentTimelines(docId, ...documents) {
        // Per-entry and tolerant, NOT all-or-nothing: this runs on the way OUT
        // (update/delete), where a row written by an older version (or by hand)
        // must still be cleaned up rather than throwing. BSI removal is by name;
        // membership cells are recomputed from EVERY entry (primary included —
        // unticking a cell the doc never occupied is a no-op) so overwrites and
        // primary-flag changes cannot strand cells.
        const names = new Set();
        const cellIntervals = new Map(); // name -> raw intervals
        for (const document of documents) {
            const timelines = Array.isArray(document?.timelines) ? document.timelines : [];
            for (const entry of timelines) {
                const name = entry?.name ?? entry?.timeline;
                if (!name) { continue; }
                names.add(name);
                try {
                    const interval = this.documentEntryInterval(entry);
                    if (!cellIntervals.has(name)) { cellIntervals.set(name, []); }
                    cellIntervals.get(name).push(interval);
                } catch { /* malformed legacy entry — name-level BSI removal still applies */ }
            }
        }

        for (const name of names) {
            await this.#getTimeline().remove(name, docId);
            const intervals = cellIntervals.get(name);
            if (intervals?.length) {
                // removeEntries is itself per-interval tolerant (malformed
                // intervals are skipped, unticks of absent cells are no-ops,
                // open intervals clear their sidecar side).
                await this.#getTimeline().removeEntries(name, docId, intervals);
            }
        }
    }

    // entry {start, end?, scale?} -> the interval value TimelineIndex accepts.
    documentEntryInterval(entry) {
        if (!('start' in entry)) { throw new Error('Document timeline entry requires start'); }
        const start = entry.scale ? { scale: entry.scale, value: entry.start } : entry.start;
        // `undefined` (absent) => instant; explicit `null` => OPEN end, the
        // Timeline index's "ongoing" sentinel. This must not be `??`: that
        // collapses null into start, so no document could ever declare an
        // ongoing interval even though TimelineIndex.insert supports it.
        const rawEnd = (entry.end === undefined) ? entry.start : entry.end;
        const end = entry.scale ? { scale: entry.scale, value: rawEnd } : rawEnd;
        return { start, end };
    }

    /**
     * Group a document's timelines[] by timeline name and pick each timeline's
     * PRIMARY entry: the one flagged `primary: true` (first such wins) or the
     * first entry. Multiple entries per timeline are supported — the primary
     * goes to the dual-BSI (sortable value plane), the rest to the tiled
     * membership plane, where open-ended intervals land in its open-interval
     * sidecar (so a document can carry several ongoing facts on one timeline;
     * the entry grammar is the only surface, plane routing is the engine's
     * business).
     *
     * @returns {Map<string, { primary, extras: Array }>}
     */
    normalizeDocumentTimelineEntries(document) {
        const timelines = Array.isArray(document?.timelines) ? document.timelines : [];
        const grouped = new Map();
        for (const entry of timelines) {
            const name = entry.name ?? entry.timeline;
            if (!name) { throw new Error('Document timeline entry requires name or timeline'); }
            const item = {
                interval: this.documentEntryInterval(entry),
                primary: entry.primary === true,
            };
            if (!grouped.has(name)) { grouped.set(name, { entries: [] }); }
            grouped.get(name).entries.push(item);
        }

        const result = new Map();
        for (const [name, { entries }] of grouped) {
            let primaryIndex = entries.findIndex((e) => e.primary);
            if (primaryIndex === -1) { primaryIndex = 0; }
            const extras = entries.filter((_, i) => i !== primaryIndex);
            result.set(name, { primary: entries[primaryIndex], extras });
        }
        return result;
    }

    async resolveDocumentMembershipKeys(contextSpec, directorySpec, featureBitmaps) {
        const allSynapseKeys = [];

        if (contextSpec) {
            const { tree: contextTree, collection, path: contextPath } = this.#trees.resolveSelection('context', contextSpec, '/');
            const pathLayersArray = parseContextSpecForInsert(contextPath);
            for (const pathLayers of pathLayersArray) {
                const pathString = pathLayers.join('/');
                await contextTree.insertPath(pathString);

                const layerIds = contextTree.resolveLayerIds(pathLayers);
                // Always tick root layer for universal membership bitmap (O(1) path='/' queries)
                if (contextTree.rootLayer && !layerIds.includes(contextTree.rootLayer.id)) {
                    layerIds.unshift(contextTree.rootLayer.id);
                }
                allSynapseKeys.push(...layerIds.map((layerId) => collection.makeKey(layerId)));
            }
        }

        if (directorySpec) {
            const { tree: directoryTree, path: directoryPath } = this.#trees.resolveSelection('directory', directorySpec, null);
            const dirs = Array.isArray(directoryPath) ? directoryPath : [directoryPath];
            const nodeIds = typeof directoryTree.ensurePaths === 'function'
                ? await directoryTree.ensurePaths(dirs)
                : [];
            const collection = this.#trees.directoryCollection(directoryTree.id);
            allSynapseKeys.push(...nodeIds.map((nodeId) => collection.makeKey(nodeId)));

            // Directory-only inserts surface at the default context root unless
            // the tree opts out (settings.linkContextRoot === false) — e.g. a
            // backend-mirror tree whose documents should stay out of the user's
            // context until explicitly filed.
            if (!contextSpec && directoryTree.settings?.linkContextRoot !== false) {
                const contextTree = this.#trees.getDefaultContextTree();
                if (contextTree?.rootLayer) {
                    const collection = this.#trees.contextCollection(contextTree.id);
                    allSynapseKeys.push(collection.makeKey(contextTree.rootLayer.id));
                }
            }
        }

        allSynapseKeys.push(...normalizeBitmapKeys(featureBitmaps ?? []));
        return Array.from(new Set(allSynapseKeys));
    }
    // Shared by single, batch, and multi-directory document commits.
    async applyChange(change) {
        const { id, before, after, features, context, directories, staleFeatures, facetKeys, staleFacets } = change;
        if (staleFeatures.length) { await this.#writes.applyMembership('untick', id, staleFeatures); }
        if (before) { await this.removeDocumentTimelines(id, before, after); }
        await this.indexDocumentTimelines(id, after);
        await this.indexDocumentGeo(id, after);
        this.syncDocumentRelations(id, before?.relations, documentRelations(after));
        for (const directory of directories) { await this.indexDocument(id, context, directory, features); }
        if (before) { await this.removeStaleLocationMembership(id, before, after, features); }
        await this.#writes.applyMembership(after.hasComment ? 'tick' : 'untick', id, [COMMENT_BITMAP_KEY]);
        if (staleFacets.length) { await this.#writes.applyMembership('untick', id, staleFacets); }
        if (facetKeys.length) { await this.#writes.applyMembership('tick', id, facetKeys); }
    }

}
