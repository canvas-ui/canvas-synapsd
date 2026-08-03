'use strict';

/**
 * Edge predicates — a closed, append-only registry.
 *
 * Ids are persisted inside LMDB keys, so they are APPEND-ONLY: never renumber,
 * never reuse a retired id. Adding a predicate is a deliberate code change.
 *
 * Direction is an AXIS, not a name. There are no inverse predicate names
 * anywhere in the system — not here, not in persisted data, not in the query
 * grammar. You express direction by which method you call (`outgoing` /
 * `incoming`) or by a `dir` parameter. An earlier draft resolved inverse names
 * (`mentioned-by` -> `mentions`); that was rejected because it erases direction
 * at the callsite and silently produces wrong forward scans.
 *
 * Kebab-case is the wire/persisted form: predicate strings appear in
 * `data.relations` payloads and query specs alongside the codebase's existing
 * kebab-cased data strings (`derived-from`, `t:crud:updated`).
 *
 * Every predicate takes the DOCUMENT as subject, never the entity it points at
 * ("message authored-by identity", not "identity authors message"). The passive
 * reading of `derived-from` / `authored-by` is that convention, not an inverse
 * name.
 *
 * Two deliberate non-entries, so nobody re-proposes them (decided 2026-08-03):
 *
 * - `snapshot-of` is `derived-from`. The predicate answers "where did this come
 *   from"; WHAT it is is already on the target (`kind`, mime, stored:// location).
 *   A separate id would split one provenance axis in two forever.
 * - `depicts` and `authored-by` are NOT `mentions`, and cannot be folded into it
 *   later. `src` separates DERIVED edges by producer (a face detector from an NER
 *   pass), but a human face-tagging a photo writes an ASSERTED edge — and the
 *   asserted convention is the absence of a meta row, so a hand-tagged face and a
 *   hand-written mention would be byte-identical in the index with nothing to tell
 *   them apart. Conflating is a lossy one-way door; appending an id is one line.
 *
 * Recipients (email To/Cc -> identity) are deferred, not rejected: the role is
 * distinct from authorship and cannot live in edge meta without colliding with the
 * asserted-edge convention above. `data.to`/`data.cc` stay ordinary fields until
 * the reverse query ("everything sent to Alice") is actually wanted. Deferring is
 * safe here precisely because there is no conflation risk — unlike the two above.
 */

export const PREDICATES = {
    'includes': { id: 1 },      // composition: email -> attachments, tab -> offline file
    'references': { id: 2 },    // soft link
    'derived-from': { id: 3 },  // provenance: thumbnail -> image, offline file -> tab
    'mentions': { id: 4 },      // entity mention: message -> identity
    'replies-to': { id: 5 },    // threading: message -> message
    'depicts': { id: 6 },       // media subject: image -> identity (face tags)
    'authored-by': { id: 7 },   // authorship: message/document -> identity (sender, author)
};

// id -> name, built once. Used to decode ids read back out of keys.
const NAME_BY_ID = new Map(
    Object.entries(PREDICATES).map(([name, { id }]) => [id, name]),
);

// Inverse-style spellings someone will inevitably reach for. They are NOT
// resolved to their forward form — they throw, with a pointer to the axis.
const INVERSE_STYLE = new Set([
    'included-by',
    'referenced-by',
    'derives',
    'mentioned-by',
    'replied-to-by',
    'replied-by',
    'depicted-by',
    'depicted-in',
    'authors',
    'authored',
]);

/**
 * Resolve a predicate name to its persisted id.
 * @param {string} predicate kebab-case predicate name
 * @returns {number} 1-byte predicate id
 * @throws if the name is unknown or is an inverse-style spelling
 */
export function predicateId(predicate) {
    if (typeof predicate !== 'string' || predicate === '') {
        throw new Error('Predicate must be a non-empty string');
    }

    if (INVERSE_STYLE.has(predicate)) {
        throw new Error(
            `Inverse predicate "${predicate}" is not a predicate. Direction is an axis, not a name: ` +
            'use the forward predicate with incoming()/dir:\'in\' instead.',
        );
    }

    const entry = PREDICATES[predicate];
    if (!entry) {
        throw new Error(
            `Unknown predicate "${predicate}". Allowed: ${Object.keys(PREDICATES).join(', ')}`,
        );
    }

    return entry.id;
}

/**
 * Decode a persisted predicate id back to its name.
 * @param {number} id
 * @returns {string}
 */
export function predicateName(id) {
    const name = NAME_BY_ID.get(id);
    if (!name) { throw new Error(`Unknown predicate id ${id}`); }
    return name;
}

/** All predicate ids, ascending. */
export function allPredicateIds() {
    return [...NAME_BY_ID.keys()].sort((a, b) => a - b);
}

export default PREDICATES;
