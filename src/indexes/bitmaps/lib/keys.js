'use strict';

export const ALLOWED_BITMAP_PREFIXES = [
    'internal/',
    'context/',
    'vfs/',
    'feature/',
    'device/',
    'client/',
    'tag/',
    'data/',
    'custom/',
    // NOTE: 'rel/' is deliberately absent. Typed document<->document edges moved
    // to dupsort adjacency (indexes/edges/) in refactor-v3; keeping the prefix
    // out of this list makes any straggler bitmap write throw instead of
    // silently creating a second, stale relation store.
];

export function normalizeBitmapKey(key) {
    if (key === null || key === undefined) { return null; }
    if (typeof key !== 'string') { throw new Error('Bitmap key must be a string'); }

    const isNegated = key.startsWith('!');
    const rawKey = isNegated ? key.slice(1) : key;
    // Allowed charset: a-z 0-9 _ - . / @ : + — '@' and ':' keep backend addresses
    // readable (data/backend/imap/user@domain.tld, data/backend/workspace:home);
    // '+' keeps MIME subtypes intact (data/mime/image/svg+xml, application/ld+json)
    // so there's no vocabulary translation between a doc's contentType and its
    // bitmap key. '+' is only a query sigil in LEADING position (spec.js splitSigil
    // slices the first char only), so mid-key '+' never collides. '!' (negation),
    // '/' (hierarchy/range scans) and whitespace stay reserved.
    const normalized = rawKey
        .replace(/\\/g, '/')
        .replace(/\s+/g, '_')
        .toLowerCase()
        .replace(/[^a-z0-9_\-./@:+]/g, '_')
        .replace(/_+/g, '_')
        .replace(/\/+/g, '/');

    return isNegated ? `!${normalized}` : normalized;
}

/**
 * Non-throwing key check, for PREDICATES.
 *
 * "Is this key well-formed?" and "does this bitmap exist?" collapse to the same
 * answer for a malformed key — it cannot name anything — so a boolean question
 * deserves a boolean answer. Operations (tick, delete, create) still use
 * `validateBitmapKey` and throw, because WRITING a malformed key is a real error.
 *
 * @param {*} key
 * @returns {boolean}
 */
export function isValidBitmapKey(key) {
    if (!key || typeof key !== 'string') { return false; }

    const normalizedKey = normalizeBitmapKey(key);
    const keyWithoutNegation = normalizedKey.startsWith('!') ? normalizedKey.slice(1) : normalizedKey;
    return ALLOWED_BITMAP_PREFIXES.some(prefix => keyWithoutNegation.startsWith(prefix));
}

export function validateBitmapKey(key) {
    if (!key) { throw new Error('Bitmap key cannot be null or undefined'); }
    if (typeof key !== 'string') { throw new Error('Bitmap key must be a string'); }

    if (!isValidBitmapKey(key)) {
        throw new Error(`Bitmap key "${key}" does not follow naming convention. Must start with one of: ${ALLOWED_BITMAP_PREFIXES.join(', ')}`);
    }

    return true;
}

export function makeBitmapKey(prefix, key) {
    if (!prefix) { throw new Error('Bitmap key prefix required'); }

    const normalizedPrefix = normalizeBitmapKey(prefix).replace(/\/?$/, '/');
    if (key === '/') { return normalizedPrefix; }

    const isNegated = String(key).startsWith('!');
    const segment = normalizeBitmapKey(isNegated ? String(key).slice(1) : String(key));
    const fullKey = segment === '' ? normalizedPrefix : `${normalizedPrefix}${segment}`;

    return isNegated ? `!${fullKey}` : fullKey;
}

export function normalizeBitmapKeys(keys) {
    return (Array.isArray(keys) ? keys : [keys])
        .filter(Boolean)
        .map(normalizeBitmapKey);
}
