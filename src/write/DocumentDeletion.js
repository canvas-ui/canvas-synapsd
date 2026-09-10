import debugInstance from 'debug';
import { EVENTS, createEvent } from '../utils/events.js';
import { parseDocumentData } from '../utils/document.js';






import { normalizeProvenance } from './options.js';
const debug = debugInstance('canvas:synapsd');

export default class DocumentDeletion {
    #documents;
    #bitmapIndex;
    #writes;
    #derived;
    #vectors;
    #checksumIndex;
    #getTimeline;
    #getGeo;
    #getEdges;
    #getSynapses;
    #getLance;
    #getAllBitmap;
    #getDeletedBitmap;
    #retractIncoming;
    constructor({ documents, bitmapIndex, writes, derived, vectors, checksumIndex, getTimeline, getGeo, getEdges, getSynapses, getLance, getAllBitmap, getDeletedBitmap, retractIncoming }) {
        this.#documents = documents;
        this.#bitmapIndex = bitmapIndex;
        this.#writes = writes;
        this.#derived = derived;
        this.#vectors = vectors;
        this.#checksumIndex = checksumIndex;
        this.#getTimeline = getTimeline;
        this.#getGeo = getGeo;
        this.#getEdges = getEdges;
        this.#getSynapses = getSynapses;
        this.#getLance = getLance;
        this.#getAllBitmap = getAllBitmap;
        this.#getDeletedBitmap = getDeletedBitmap;
        this.#retractIncoming = retractIncoming;
    }


    async delete(id, options = {}) {
        if (!id) { throw new Error('Document id required'); }
        return await this.deleteOne(id, options);
    }

    async deleteMany(ids, options = {}) {
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

        // Batch-fetch all documents at once
        const validIds = validEntries.map(e => e.id);
        const rawDocs = await this.#documents.getMany(validIds);

        const toDelete = [];
        for (let i = 0; i < validEntries.length; i++) {
            const { index, id } = validEntries[i];
            const docData = rawDocs[i];
            if (!docData) {
                result.failed.push({ index, id, error: 'Document not found or already deleted' });
            } else {
                toDelete.push({ index, id, document: parseDocumentData(docData) });
            }
        }

        if (toDelete.length === 0) { return result; }

        const { emitEvent = true } = options;
        const now = new Date().toISOString();

        // Single transaction for all deletes
        try {
            await this.#writes.withDeferredMembership(async () => {
                const doomed = new Set(toDelete.map(({ id }) => id));
                for (const { id, document } of toDelete) {
                    await this.#deleteStored(id, document, now, doomed);
                }
            });
        } catch (error) {
            for (const { index, id } of toDelete) {
                result.failed.push({ index, id, error: error.message || 'Transaction failed' });
            }
            return result;
        }

        const deletedIds = toDelete.map(({ id }) => id);
        // Best-effort Lance cleanup (outside transaction — separate system).
        // Bulk delete is all-or-nothing, so free-pool admission is batch-wide:
        // recycle the ids only if both fts and vector cleanup succeed; otherwise
        // they leak (stay allocated) rather than risk reuse with stale residue.
        let lanceClean = true;
        try {
            lanceClean = await this.#getLance().deleteMany(deletedIds);
        } catch (e) {
            lanceClean = false;
            debug(`deleteMany: Lance deleteMany failed: ${e.message}`);
        }
        if (this.#vectors.openedCount > 0) {
            try {
                for (const vi of this.#vectors.openedIndexes()) {
                    const vecClean = await vi.deleteMany(deletedIds);
                    lanceClean = lanceClean && vecClean;
                }
            } catch (e) {
                lanceClean = false;
                debug(`deleteMany: Vector deleteMany failed: ${e.message}`);
            }
        }

        if (lanceClean) {
            try {
                // Persisting tick (Bitmap.tick is in-memory only); accepts the id array.
                await this.#bitmapIndex.tick(this.#getDeletedBitmap().key, deletedIds);
                debug(`deleteMany: ${deletedIds.length} ids admitted to free-id pool`);
            } catch (e) {
                debug(`deleteMany: free-pool admission failed (ids leak): ${e.message}`);
            }
        }

        for (const { index, id } of toDelete) {
            result.successful.push({ index, id });
        }

        // One event per op: single for a lone doc, batch otherwise (avoids a
        // socket-emit storm on large purges).
        if (emitEvent && result.successful.length > 0) {
            const ids = result.successful.map((e) => e.id);
            const provenance = normalizeProvenance(options.provenance) || {};
            if (ids.length === 1) {
                this.#writes.emit(EVENTS.DOCUMENT_DELETED, createEvent(EVENTS.DOCUMENT_DELETED, { id: ids[0], reason: 'deleted', ...provenance }));
            } else {
                this.#writes.emit(EVENTS.DOCUMENT_DELETED_BATCH, createEvent(EVENTS.DOCUMENT_DELETED_BATCH, { ids, reason: 'deleted', ...provenance }));
            }
        }

        return result;
    }

    // Deletes documents from all bitmaps and the main dataset
    async deleteOne(docId, options = {}) {
        if (!docId) { throw new Error('Document id required'); }
        const { emitEvent = true } = options;
        const provenance = normalizeProvenance(options.provenance);
        debug(`delete: Document with ID "${docId}" found (or context check passed), proceeding to delete..`);

        let document = null;
        let transactionSuccess = false;

        try {
            // Get document before deletion (outside transaction to check existence)
            const documentData = await this.#documents.get(docId);
            if (!documentData) {
                debug(`delete: Document with ID "${docId}" not found`);
                return false;
            }
            document = parseDocumentData(documentData);
            debug('delete > Document: ', document);

            // Wrap all critical database operations in a single transaction for atomicity
            await this.#writes.withDeferredMembership(async () => {
                await this.#deleteStored(docId, document, new Date().toISOString());
            });

            transactionSuccess = true;
            debug(`delete: All database operations completed atomically for document ID: ${docId}`);

        } catch (error) {
            debug(`delete: Transaction failed for document ID: ${docId}, error: ${error.message}`);
            // If transaction failed, ensure we don't attempt Lance cleanup
            transactionSuccess = false;
            throw new Error(`Failed to delete document atomically: ${error.message}`);
        }

        // Best-effort Lance delete (outside transaction since it's a separate system)
        if (transactionSuccess) {
            // Gate free-pool admission on lance cleanup: only recycle the id if
            // the fts (+ vector) rows are gone. If cleanup fails the id leaks
            // (stays allocated) but is never reused with a stale residue. The
            // crud:deleted timeline already serves any audit/tombstone need.
            let lanceClean = true;
            try {
                lanceClean = await this.#getLance().delete(docId);
                debug(`delete: LanceDB cleanup ${lanceClean ? 'completed' : 'FAILED'} for document ${docId}`);
            } catch (e) {
                lanceClean = false;
                debug(`delete: Lance delete failed for ${docId}: ${e.message}`);
            }
            if (this.#vectors.openedCount > 0) {
                try {
                    for (const vi of this.#vectors.openedIndexes()) {
                        const vecClean = await vi.deleteDoc(docId);
                        lanceClean = lanceClean && vecClean;
                    }
                } catch (e) {
                    lanceClean = false;
                    debug(`delete: Vector delete failed for ${docId}: ${e.message}`);
                }
            }

            if (lanceClean) {
                try {
                    // Persisting tick (Bitmap.tick is in-memory only); keeps the
                    // cached deletedDocumentsBitmap instance and the store in sync.
                    await this.#bitmapIndex.tick(this.#getDeletedBitmap().key, docId);
                    debug(`delete: Document ${docId} admitted to free-id pool`);
                } catch (e) {
                    debug(`delete: free-pool admission failed for ${docId} (id leaks): ${e.message}`);
                }
            }

            if (emitEvent) {
                this.#writes.emit(EVENTS.DOCUMENT_DELETED, createEvent(EVENTS.DOCUMENT_DELETED, { id: docId, reason: 'deleted', ...(provenance || {}) }));
            }
            debug(`delete: Successfully deleted document ID: ${docId}`);
            return true;
        }

        return false;
    }
    async #deleteStored(id, document, now, doomed) {
        await this.#retractIncoming(id, doomed);
        await this.#documents.delete(id);
        await this.#bitmapIndex.untick(this.#getAllBitmap().key, id);
        const cleared = await this.#getSynapses().clearSynapses(id, { syncBitmaps: false });
        await this.#writes.applyMembership('untick', id, cleared);
        this.#getEdges().deleteNode(id);
        await this.#derived.removeDocumentTimelines(id, document);
        await this.#getTimeline().removeFromAll(id);
        if (await this.#getGeo().has(id)) { await this.#getGeo().remove(id); }
        await this.#checksumIndex.deleteArray(document.checksumArray);
        await this.#getTimeline().insert('crud:deleted', id, document.updatedAt || now);
    }

}
