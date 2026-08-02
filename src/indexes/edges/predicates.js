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
 */

export const PREDICATES = {
    'includes': { id: 1 },      // composition: email -> attachments, tab -> offline file
    'references': { id: 2 },    // soft link
    'derived-from': { id: 3 },  // provenance: thumbnail -> image, offline file -> tab
    'mentions': { id: 4 },      // entity mention: message -> identity
    'replies-to': { id: 5 },    // threading: message -> message
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
