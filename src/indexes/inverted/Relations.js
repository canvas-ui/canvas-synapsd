'use strict';

// Utils
import debugInstance from 'debug';
const debug = debugInstance('canvas:synapsd:relations');

/**
 * Relations — typed, directed, N:N edges between documents.
 *
 * An edge `from --predicate--> to` is stored as roaring bitmaps in the reserved
 * `rel/` namespace, reusing the BitmapIndex engine (no new storage primitive):
 *
 *   rel/<predicate>/<fromDocId>  → bitmap of toDocIds     (forward)
 *   rel/<inverse>/<toDocId>      → bitmap of fromDocIds    (reverse, for O(predicates) delete)
 *
 * The predicate set is intentionally small and *structural* — domain meaning
 * (e.g. "attachment #3, inline") lives on the viewing document's `data`, never
 * on the edge. Bitmaps carry no per-edge payload; if edge-intrinsic data is ever
 * needed, add a separate edge-record store and keep these bitmaps for traversal.
 *
 * Predicate ⇄ inverse:
 *   includes      ⇄ included-by    (composition: email→attachments, tab→offline file)
 *   references    ⇄ referenced-by  (soft link)
 *   derived-from  ⇄ derives        (provenance: offline file→tab, thumbnail→image)
 */

// Public predicates accepted by relate()/unrelate()/getRelated().
export const RELATION_PREDICATES = {
    'includes': 'included-by',
    'references': 'referenced-by',
    'derived-from': 'derives',
};

// Every namespace segment (forward + inverse) mapped to its opposite — used to
// walk both directions on delete.
const INVERSE = Object.entries(RELATION_PREDICATES).reduce((acc, [fwd, rev]) => {
    acc[fwd] = rev;
    acc[rev] = fwd;
    return acc;
}, {});

export default class Relations {

    constructor(bitmapIndex, synapses = null) {
        if (!bitmapIndex) { throw new Error('BitmapIndex instance required'); }
        this.bitmapIndex = bitmapIndex;
        this.synapses = synapses; // optional, for inheritMemberships
        debug('Relations index initialized');
    }

    #key(predicate, docId) { return `rel/${predicate}/${docId}`; }

    #normId(value) {
        const id = Number(value);
        if (!Number.isInteger(id) || id <= 0) { throw new Error(`Invalid document id: ${value}`); }
        return id;
    }

    #assertPredicate(predicate) {
        if (!Object.prototype.hasOwnProperty.call(RELATION_PREDICATES, predicate)) {
            throw new Error(`Unknown relation predicate "${predicate}". Allowed: ${Object.keys(RELATION_PREDICATES).join(', ')}`);
        }
        return RELATION_PREDICATES[predicate];
    }

    /**
     * Create a typed edge from --predicate--> to (idempotent).
     * @param {number} fromId
     * @param {string} predicate one of RELATION_PREDICATES keys
     * @param {number} toId
     * @param {{inheritMemberships?: boolean}} [options] when true, `to` inherits
     *        `from`'s layer/context/tag memberships (via Synapses).
     */
    async relate(fromId, predicate, toId, options = {}) {
        const inverse = this.#assertPredicate(predicate);
        const from = this.#normId(fromId);
        const to = this.#normId(toId);

        await this.bitmapIndex.tick(this.#key(predicate, from), to);
        await this.bitmapIndex.tick(this.#key(inverse, to), from);
        debug(`relate: ${from} --${predicate}--> ${to}`);

        if (options.inheritMemberships && this.synapses) {
            await this.synapses.createSynapsesFromDocs(to, [from]);
        }
        return true;
    }

    /**
     * Remove a typed edge from --predicate--> to.
     */
    async unrelate(fromId, predicate, toId) {
        const inverse = this.#assertPredicate(predicate);
        const from = this.#normId(fromId);
        const to = this.#normId(toId);

        await this.bitmapIndex.untick(this.#key(predicate, from), to);
        await this.bitmapIndex.untick(this.#key(inverse, to), from);
        debug(`unrelate: ${from} --${predicate}--> ${to}`);
        return true;
    }

    /**
     * List documents related to `docId` under `predicate`.
     * @param {number} docId
     * @param {string} predicate one of RELATION_PREDICATES keys
     * @param {{reverse?: boolean}} [options] reverse:true walks the inverse edge
     *        (e.g. getRelated(attachmentId, 'includes', { reverse:true }) → emails).
     * @returns {Promise<number[]>}
     */
    async getRelated(docId, predicate, options = {}) {
        const inverse = this.#assertPredicate(predicate);
        const id = this.#normId(docId);
        const segment = options.reverse ? inverse : predicate;
        const bitmap = await this.bitmapIndex.getBitmap(this.#key(segment, id), false);
        return bitmap ? bitmap.toArray() : [];
    }

    /**
     * Drop every edge touching `docId` (called on document delete). Walks each
     * namespace segment, unticks `docId` from each partner's inverse bitmap, then
     * removes `docId`'s own anchor bitmaps. O(predicates), not O(all bitmaps).
     */
    async clearRelations(docId) {
        const id = this.#normId(docId);
        for (const segment of Object.keys(INVERSE)) {
            const key = this.#key(segment, id);
            const bitmap = await this.bitmapIndex.getBitmap(key, false);
            if (!bitmap || bitmap.isEmpty) { continue; }
            const inverseSegment = INVERSE[segment];
            for (const partnerId of bitmap.toArray()) {
                await this.bitmapIndex.untick(this.#key(inverseSegment, partnerId), id);
            }
            await this.bitmapIndex.deleteBitmap(key);
        }
        debug(`clearRelations: dropped all edges for doc ${id}`);
    }
}
