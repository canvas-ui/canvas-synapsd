import { preparedChange, writeFeatureKeys } from './PreparedChange.js';
import debugInstance from 'debug';
import { EVENTS, createEvent } from '../utils/events.js';
import { parseInitializeDocument } from '../utils/document.js';
import { parseBitmapArray } from '../utils/parsing.js';

import { isDocumentInstance } from '../schemas/SchemaRegistry.js';
import { validateDocumentRelations } from '../documents/derivation.js';
import { mergeDedupePreservedFields, mergeDocumentLocations } from '../documents/deduplication.js';
import { snapshotDocument } from '../documents/snapshot.js';
import { isDocumentOperationOptions, normalizeDocumentOperationSpec, normalizeProvenance, documentNotFound } from './options.js';
const debug = debugInstance('canvas:synapsd');
const INTERNAL_BITMAP_ID_MAX = 100000;

export default class DocumentWriter {
    #documents;
    #bitmapIndex;
    #trees;
    #writes;
    #derived;
    #vectors;
    #checksumIndex;
    #internalStore;
    #getTimeline;
    #getLance;
    #getAllBitmap;
    #getDeletedBitmap;
    #getById;
    #getByChecksumString;
    constructor({ documents, bitmapIndex, trees, writes, derived, vectors, checksumIndex, internalStore, getTimeline, getLance, getAllBitmap, getDeletedBitmap, getById, getByChecksumString }) {
        this.#documents = documents;
        this.#bitmapIndex = bitmapIndex;
        this.#trees = trees;
        this.#writes = writes;
        this.#derived = derived;
        this.#vectors = vectors;
        this.#checksumIndex = checksumIndex;
        this.#internalStore = internalStore;
        this.#getTimeline = getTimeline;
        this.#getLance = getLance;
        this.#getAllBitmap = getAllBitmap;
        this.#getDeletedBitmap = getDeletedBitmap;
        this.#getById = getById;
        this.#getByChecksumString = getByChecksumString;
    }


    async put(document, spec = {}) {
        const normSpec = normalizeDocumentOperationSpec(spec);

        if (!document || typeof document !== 'object' || Array.isArray(document)) {
            throw new Error('Document object is required');
        }

        // A supplied id names the document the caller means to write. If it is
        // gone, falling through to insert would mint a DIFFERENT id and answer
        // as though the update succeeded — "update 42" silently becomes
        // "created 137", and the caller has no way to tell. Content-addressed
        // dedup remains the path for id-less writes (that is what makes a
        // re-import of the same bytes resolve to one document); naming an id
        // that does not exist is an error.
        if (document.id !== undefined && document.id !== null) {
            const existing = await this.#getById(document.id).catch(() => null);
            if (existing) {
                return await this.updateOne(document.id, document, normSpec);
            }
            throw documentNotFound(document.id);
        }

        return await this.putOne(document, normSpec);
    }

    async putMany(documents, spec = {}) {
        const skipLance = spec.skipLance === true;
        const deferredLanceBuffer = spec.deferredLanceBuffer;

        const normSpec = normalizeDocumentOperationSpec(spec);
        if (!Array.isArray(documents)) {
            throw new Error('Document array must be an array');
        }
        if (documents.length === 0) { return []; }

        debug(`putMany: Attempting to store ${documents.length} documents`);

        // ── Phase 1: Parse, validate, dedup ──────────────────────────────

        const contextSpec = normSpec.context ?? null;
        const directorySpec = normSpec.directory ?? null;

        const featureBitmaps = parseBitmapArray(normSpec.features);
        const prepared = [];
        // In-batch content dedup: two identical files in one batch both miss the
        // checksum lookup (nothing is written until phase 2), so without this they
        // fork into two docs and the checksum index keeps only the last id —
        // corrupting the one-blob-one-doc model. Keyed by primary checksum.
        const batchByChecksum = new Map();

        for (let i = 0; i < documents.length; i++) {
            try {
                const doc = documents[i];

                let parsed;
                let existing = null;
                let isUpdate = false;
                let previous = null;

                // Dedup priority: a supplied id is an UPDATE of exactly that
                // document — the id is the stable key every bitmap/timeline/
                // checksum reference hangs off, so it must be preserved (no new
                // id minted), and an id that resolves to nothing is an error
                // rather than a silent insert. Content-addressed (checksum)
                // dedup is the path for ID-LESS writes, which is what makes a
                // re-import of the same content resolve to one document.
                // Ids are integers; a numeric-string id is normalized before
                // lookup so the update path resolves and the id is preserved.
                const suppliedId = (doc && doc.id !== undefined && doc.id !== null)
                    ? (typeof doc.id === 'string' ? parseInt(doc.id, 10) : doc.id)
                    : null;
                if (suppliedId !== null) {
                    existing = Number.isNaN(suppliedId)
                        ? null
                        : await this.#getById(suppliedId).catch(() => null);
                    if (existing) {
                        isUpdate = true;
                        // Snapshot previous state BEFORE update() mutates in place,
                        // so stale checksums/timelines/device tags can be cleaned.
                        ({ parsed, previous } = this.#prepareUpdate(existing, doc, { canonicalId: suppliedId }));
                    } else {
                        // Same rule as put(): a named id that is not here is an
                        // error, never a silent insert under a fresh id.
                        throw documentNotFound(doc.id);
                    }
                }

                if (!parsed) {
                    ({ parsed, existing, previous } = await this.#prepareInsert(doc, { ignoreLookupErrors: true }));
                }

                // In-batch dedup (content-addressed only; explicit id-updates are
                // intentional and never folded). Merge this doc's locations into
                // the earlier identical entry instead of minting a second doc.
                if (!isUpdate) {
                    const primaryChecksum = parsed.getPrimaryChecksum();
                    if (primaryChecksum) {
                        const dup = batchByChecksum.get(primaryChecksum);
                        if (dup) {
                            mergeDocumentLocations(dup.parsed, parsed.locations);
                            continue;
                        }
                    }
                }

                // Per-doc declarative features unioned with the batch-level list
                // (which applies to every doc) — this is what lets one putMany
                // batch carry different tags per document.
                const docFeatures = writeFeatureKeys(parsed, featureBitmaps);

                validateDocumentRelations(parsed);

                const entry = { parsed, existing: !!existing, isUpdate, previous, docFeatures };
                prepared.push(entry);
                if (!isUpdate) {
                    const primaryChecksum = parsed.getPrimaryChecksum();
                    if (primaryChecksum) { batchByChecksum.set(primaryChecksum, entry); }
                }
            } catch (error) {
                const contextualError = new Error(`Failed to prepare document at index ${i}: ${error.message}`);
                contextualError.cause = error;
                contextualError.failedItem = documents[i];
                contextualError.failedIndex = i;
                throw contextualError;
            }
        }

        // Batch-generate IDs for new documents in one transaction
        const newDocs = prepared.filter(p => !p.existing);
        if (newDocs.length > 0) {
            const ids = this.allocateDocumentIDs(newDocs.length);
            for (let i = 0; i < newDocs.length; i++) {
                newDocs[i].parsed.id = ids[i];
            }
        }

        // Validate all (now that IDs are assigned)
        for (let i = 0; i < prepared.length; i++) {
            try {
                prepared[i].parsed.validate();
            } catch (error) {
                const contextualError = new Error(`Validation failed for document at index ${i}: ${error.message}`);
                contextualError.cause = error;
                contextualError.failedIndex = i;
                throw contextualError;
            }
        }

        // ── Phase 2: Batch write ─────────────────────────────────────────

        const changes = prepared.map(({ parsed, isUpdate, previous, docFeatures }) => preparedChange({
            after: parsed, before: previous, features: docFeatures, context: contextSpec,
            directories: [directorySpec], operation: isUpdate ? 'update' : 'insert',
        }));
        try {
            await this.#commitChanges(changes, { batchTick: true });

        } catch (error) {
            throw new Error(`putMany transaction failed: ${error.message}`);
        }

        // ── Phase 3: Lance (best-effort, single batch add) ───────────────

        // Re-index FTS/vectors only for genuinely new or content-changed docs.
        // A membership-only re-tick (same content added to another tree path —
        // e.g. multi-path "Sync To") keeps identical checksums, so its Lance row
        // and embedding already exist. Re-adding them is wasteful and, because
        // phase 3 is awaited, was making each extra path's insert slow enough to
        // blow the client's 10s timeout (only the first path stuck → "order
        // decides the folder").
        const reindexDocs = changes.filter(change => change.searchChanged);

        const needLanceRows = !skipLance || Array.isArray(deferredLanceBuffer);
        const lanceDocs = needLanceRows
            ? reindexDocs.map(({ after }) => parseInitializeDocument(after))
            : [];
        if (skipLance) {
            if (Array.isArray(deferredLanceBuffer)) {
                deferredLanceBuffer.push(...lanceDocs);
            }
        } else if (lanceDocs.length > 0) {
            try {
                await this.#getLance().addMany(lanceDocs);
            } catch (_) { }
        }

        // ── Phase 3.5: Dense vectors ─────────────────────────────────────
        // Embedding is owned by the external embedd service, driven off the
        // DOCUMENT_INSERTED event below — synapsd no longer enqueues here.

        // ── Phase 4: Events ──────────────────────────────────────────────

        const storedIds = prepared.map(p => p.parsed.id);

        if (storedIds.length > 0) {
            // Emit for whichever tree(s) the docs landed in so cross-client
            // auto-open fires on both context and directory inserts.
            this.#trees.emitDocumentEvent(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, 'context', contextSpec, storedIds);
            this.#trees.emitDocumentEvent(EVENTS.TREE_DOCUMENT_INSERTED_BATCH, 'directory', directorySpec, storedIds);
        }

        // Split inserts from updates so consumers (ws bridge, UIs) can tell an
        // edit from a new document — an in-place update keeps the same id.
        const insertedIds = prepared.filter(p => !p.isUpdate).map(p => p.parsed.id);
        const updatedIds = prepared.filter(p => p.isUpdate).map(p => p.parsed.id);

        if (insertedIds.length > 0) {
            // Singular event with `batch: true` kept for pre-batch consumers
            // (ws bridge, embedd enqueue); the .batch event is the canonical
            // one for batch-aware consumers (workspace hooks).
            this.#writes.emit(EVENTS.DOCUMENT_INSERTED, createEvent(EVENTS.DOCUMENT_INSERTED, {
                ids: insertedIds,
                count: insertedIds.length,
                batch: true,
                context: contextSpec,
                directory: directorySpec,
                reason: 'created',
                ...(normSpec.provenance || {}),
            }));
            this.#writes.emit(EVENTS.DOCUMENT_INSERTED_BATCH, createEvent(EVENTS.DOCUMENT_INSERTED_BATCH, {
                ids: insertedIds,
                count: insertedIds.length,
                context: contextSpec,
                directory: directorySpec,
                reason: 'created',
                ...(normSpec.provenance || {}),
            }));
        }
        if (updatedIds.length > 0) {
            this.#writes.emit(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, {
                ids: updatedIds,
                count: updatedIds.length,
                batch: true,
                reason: 'content',
                ...(normSpec.provenance || {}),
            }));
            this.#writes.emit(EVENTS.DOCUMENT_UPDATED_BATCH, createEvent(EVENTS.DOCUMENT_UPDATED_BATCH, {
                ids: updatedIds,
                count: updatedIds.length,
                context: contextSpec,
                directory: directorySpec,
                reason: 'content',
                ...(normSpec.provenance || {}),
            }));
        }

        return storedIds;
    }

    async putOne(document, contextSpec = { path: '/' }, featureBitmapArray = [], emitEvent = true) {
        if (!document) { throw new Error('Document is required'); }

        // Canonical document insert signature accepts a selector/options object.
        let directorySpec = null;
        let provenance = null;
        if (isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            // Preserve an explicit null context (consistent with #updateOne /
            // putMany / link): a directory-only insert into the backends tree should NOT
            // tick the context root — see #resolveDocumentMembershipKeys, which
            // skips root for backends directory paths when contextSpec is falsy.
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
            emitEvent = opts.emitEvent ?? emitEvent;
            provenance = normalizeProvenance(opts.provenance);
        }

        const featureBitmaps = parseBitmapArray(featureBitmapArray);
        const { parsed: parsedDocument, existing: storedDocument } = await this.#prepareInsert(document);
        if (!storedDocument) { parsedDocument.id = this.allocateDocumentIDs(1)[0]; }

        parsedDocument.validate();

        // The document's own features are declarative — bitmaps follow them, so
        // union them with any caller-supplied ones (tree/insert-time + device
        // tags). Schema is always among them (Document guarantees it); the
        // explicit push covers pre-built Document instances.
        const change = preparedChange({
            after: parsedDocument, before: snapshotDocument(storedDocument),
            features: writeFeatureKeys(parsedDocument, featureBitmaps),
            context: contextSpec, directories: [directorySpec],
            operation: 'insert',
            replaceChecksums: false,
        });

        try {
            await this.#commitChanges([change]);
        } catch (error) {
            throw new Error('Error inserting document atomically: ' + error.message);
        }

        // Best-effort Lance upsert
        try { await this.#getLance().upsert(parseInitializeDocument(parsedDocument)); } catch (_) { }

        if (emitEvent) {
            const { tree: contextTree } = this.#trees.resolveSelection('context', contextSpec, '/');
            contextTree.emit(EVENTS.TREE_DOCUMENT_INSERTED, createEvent(EVENTS.TREE_DOCUMENT_INSERTED, {
                documentId: parsedDocument.id,
                contextSpec,
                directorySpec,
                source: 'tree',
            }));
            this.#writes.emit(EVENTS.DOCUMENT_INSERTED, createEvent(EVENTS.DOCUMENT_INSERTED, {
                id: parsedDocument.id,
                document: parsedDocument,
                context: contextSpec,
                directory: directorySpec,
                reason: 'created',
                ...(provenance || {}),
            }));
        }

        return parsedDocument.id;
    }

    async updateOne(docIdentifier, updateData = null, contextSpec = null, featureBitmapArray = []) {
        if (!docIdentifier) { throw new Error('Document identifier required'); }
        if (typeof docIdentifier !== 'number') { throw new Error('Document identifier must be a numeric ID'); }
        if (!Array.isArray(featureBitmapArray)) { featureBitmapArray = [featureBitmapArray].filter(Boolean); }

        // Canonical update signature accepts a selector/options object.
        let directorySpec = null;
        let provenance = null;
        let emitEvent = true;
        if (isDocumentOperationOptions(contextSpec)) {
            const opts = contextSpec;
            contextSpec = opts.context ?? null;
            directorySpec = opts.directory ?? null;
            featureBitmapArray = opts.features ?? featureBitmapArray;
            provenance = normalizeProvenance(opts.provenance);
            emitEvent = opts.emitEvent !== false;
        }

        const docId = docIdentifier;
        const featureBitmaps = parseBitmapArray(featureBitmapArray);

        const storedDocument = await this.#getById(docId);
        if (!storedDocument) { throw new Error(`Document with ID "${docId}" not found`); }
        const { parsed: updatedDocument, previous } = this.#prepareUpdate(storedDocument, updateData, { parseSchema: true });
        validateDocumentRelations(updatedDocument);
        updatedDocument.validate();

        // Bitmaps follow the document's features — union the updated document's
        // own array with any caller-supplied keys.
        const change = preparedChange({
            after: updatedDocument, before: previous,
            features: writeFeatureKeys(updatedDocument, featureBitmaps),
            context: contextSpec, directories: [directorySpec],
            operation: 'update',
            replaceChecksums: true,
        });

        try {
            await this.#commitChanges([change]);

            if (emitEvent) {
                this.#writes.emit(EVENTS.DOCUMENT_UPDATED, createEvent(EVENTS.DOCUMENT_UPDATED, { id: updatedDocument.id, document: updatedDocument, reason: 'content', ...(provenance || {}) }));
            }

            // Best-effort Lance upsert
            try {
                await this.#getLance().upsert(parseInitializeDocument(updatedDocument));
            } catch (e) {
                debug(`put/update: Lance upsert failed for ${updatedDocument.id}: ${e.message}`);
            }
            // Content changed → the doc must be re-embedded. The external embedd
            // service reacts to DOCUMENT_UPDATED; here we drop it from the seen
            // ledger so a reconcile re-embeds it even if the live event is missed.
            for (const space of this.#vectors.openedNames()) {
                try { await this.#bitmapIndex.untick(this.#vectors.seenKey(space), Number(updatedDocument.id)); } catch (_) { }
            }

            return updatedDocument.id;
        } catch (error) {
            debug(`put/update: Error during update: ${error.message}`);
            throw error;
        }
    }

    async putManyDirectoryPaths(items, treeName, featureArray = [], options = {}) {
        const skipLance = options.skipLance === true;
        const deferredLanceBuffer = options.deferredLanceBuffer;
        const emitEvent = options.emitEvent !== false;

        if (!Array.isArray(items) || items.length === 0) {
            return [];
        }

        const featureBitmaps = parseBitmapArray(featureArray);

        const prepared = [];
        // In-batch content dedup: identical blobs at different directory paths in
        // one batch would otherwise fork into separate docs (checksum not yet
        // written). Fold them into a single doc linked under every path.
        const batchByChecksum = new Map();

        for (let i = 0; i < items.length; i++) {
            const { document, path: dirPath } = items[i];
            try {
                const { parsed, existing } = await this.#prepareInsert(document, { ignoreLookupErrors: true, skipExisting: true });
                if (existing) { continue; }
                const primaryChecksum = parsed.getPrimaryChecksum();

                const directorySpec = { tree: treeName, path: dirPath };

                // Fold an earlier identical blob: merge locations + add this path.
                const dup = primaryChecksum ? batchByChecksum.get(primaryChecksum) : null;
                if (dup) {
                    mergeDocumentLocations(dup.parsed, parsed.locations);
                    dup.directorySpecs.push(directorySpec);
                    continue;
                }

                const docFeatures = writeFeatureKeys(parsed, featureBitmaps);

                validateDocumentRelations(parsed);
                const entry = { parsed, docFeatures, directorySpecs: [directorySpec] };
                prepared.push(entry);
                if (primaryChecksum) { batchByChecksum.set(primaryChecksum, entry); }
            } catch (error) {
                const contextualError = new Error(`Failed to prepare document at index ${i}: ${error.message}`);
                contextualError.cause = error;
                throw contextualError;
            }
        }

        if (prepared.length === 0) { return []; }

        const ids = this.allocateDocumentIDs(prepared.length);
        for (let i = 0; i < prepared.length; i++) {
            prepared[i].parsed.id = ids[i];
        }

        for (let i = 0; i < prepared.length; i++) {
            prepared[i].parsed.validate();
        }

        try {
            await this.#commitChanges(prepared.map(({ parsed, docFeatures, directorySpecs }) => preparedChange({
                after: parsed, features: docFeatures, directories: directorySpecs,
            })), { batchTick: true });
        } catch (error) {
            throw new Error(`putManyDirectoryPaths transaction failed: ${error.message}`);
        }

        const needLanceRows = !skipLance || Array.isArray(deferredLanceBuffer);
        const lanceDocs = needLanceRows
            ? prepared.map(({ parsed }) => parseInitializeDocument(parsed))
            : [];
        if (skipLance) {
            if (Array.isArray(deferredLanceBuffer)) {
                deferredLanceBuffer.push(...lanceDocs);
            }
        } else {
            try {
                await this.#getLance().addMany(lanceDocs);
            } catch (_) { }
        }

        const storedIds = prepared.map(p => p.parsed.id);

        if (emitEvent) {
            const directoryPaths = [...new Set(prepared.flatMap(p => p.directorySpecs.map(d => d?.path)).filter(Boolean))];
            this.#writes.emit(EVENTS.DOCUMENT_INSERTED, createEvent(EVENTS.DOCUMENT_INSERTED, {
                ids: storedIds,
                count: storedIds.length,
                batch: true,
                directory: { tree: prepared[0]?.directorySpecs[0]?.tree, paths: directoryPaths },
                reason: 'created',
            }));
        }

        return storedIds;
    }

    /**
     * Allocate `count` document IDs, reusing freed IDs before minting new ones.
     *
     * `internal/gc/deleted` (this.#getDeletedBitmap()) is a strict free-id
     * pool: ids land there only after a delete fully cleans (incl. lance). We pop
     * densest-first (minimum()) so reused ids cluster low → best roaring density,
     * then top up the shortfall from the monotonic counter.
     *
     * Pool pop + counter bump + pool persist run in ONE LMDB transactionSync.
     * The datasets share a single env (see LmdbBackend), so the writes commit
     * atomically; and because the callback is fully synchronous, no other async
     * writer can interleave and grab the same freed id (the allocation lock).
     *
     * @param {number} count
     * @returns {number[]} allocated ids (length === count)
     */
    allocateDocumentIDs(count) {
        if (!Number.isInteger(count) || count <= 0) { return []; }
        const counterKey = 'internal/document-id-counter';
        const pool = this.#getDeletedBitmap();

        return this.#internalStore.transactionSync(() => {
            const ids = [];

            // 1. Reuse freed ids, densest-first.
            if (pool) {
                while (ids.length < count && !pool.isEmpty) {
                    const id = pool.minimum();
                    pool.remove(id);
                    ids.push(id);
                }
            }
            const popped = ids.length;

            // 2. Top up the remainder from the monotonic counter.
            const need = count - popped;
            if (need > 0) {
                let currentCounter = this.#internalStore.get(counterKey);
                if (currentCounter === undefined || currentCounter === null) {
                    currentCounter = INTERNAL_BITMAP_ID_MAX;
                }
                const firstId = currentCounter + 1;
                this.#internalStore.putSync(counterKey, currentCounter + need);
                for (let i = 0; i < need; i++) { ids.push(firstId + i); }
            }

            // 3. Persist the shrunken pool in the SAME tx as the counter bump so a
            //    crash can't leave a popped id both reused and still in the pool.
            if (pool && popped > 0) {
                this.#bitmapIndex.saveBitmapSync(pool.key, pool);
            }

            return ids;
        });
    }
    async #commitChanges(changes, { batchTick = false } = {}) {
        await this.#writes.withDeferredMembership(async () => {
            if (batchTick) {
                await this.#bitmapIndex.tick(this.#getAllBitmap().key, changes.map(change => change.id));
            }
            for (const change of changes) {
                const { id, after, before, operation } = change;
                await this.#documents.put(id, after);
                if (!batchTick) { await this.#bitmapIndex.tick(this.#getAllBitmap().key, id); }
                const drop = change.replaceChecksums ? before.checksums : change.staleChecksums;
                if (drop.length) { await this.#checksumIndex.deleteArray(drop); }
                await this.#checksumIndex.insertArray(after.checksumArray, id);
                if (operation === 'insert') {
                    await this.#getTimeline().insert('crud:created', id, after.createdAt || new Date());
                }
                if (after.updatedAt) { await this.#getTimeline().insert('crud:updated', id, after.updatedAt); }
                await this.#derived.applyChange(change);
            }
        });
    }

    async #prepareInsert(document, { ignoreLookupErrors = false, skipExisting = false } = {}) {
        const parsed = isDocumentInstance(document) ? document : parseInitializeDocument(document);
        parsed.validateData();
        validateDocumentRelations(parsed);
        const lookup = this.#getByChecksumString(parsed.getPrimaryChecksum(), { parse: true, schema: parsed.schema });
        const existing = await (ignoreLookupErrors ? lookup.catch(() => null) : lookup);
        const previous = snapshotDocument(existing);
        if (existing && !skipExisting) {
            parsed.id = existing.id;
            mergeDedupePreservedFields(parsed, existing);
            if (existing.createdAt) { parsed.createdAt = existing.createdAt; }
            if (existing.updatedAt) { parsed.updatedAt = existing.updatedAt; }
        }
        return { parsed, existing, previous };
    }

    #prepareUpdate(storedDocument, updateData, { parseSchema = false, canonicalId = null } = {}) {
        const previous = snapshotDocument(storedDocument);
        if (updateData === null) { updateData = storedDocument; }
        else if (parseSchema && typeof updateData === 'object' && !isDocumentInstance(updateData) && updateData.schema) {
            updateData = parseInitializeDocument(updateData);
        }
        const parsed = storedDocument.update(updateData);
        if (canonicalId !== null) { parsed.id = canonicalId; }
        return { parsed, previous };
    }

}
