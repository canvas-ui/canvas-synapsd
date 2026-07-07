'use strict';

export const ALLOWED_BITMAP_PREFIXES = [
    'internal/',
    'context/',
    'vfs/',
    'feature/',
    'device/',
    'client/',
    'server/',
    'user/',
    'tag/',
    'data/',
    'nested/',
    'custom/',
    'rel/', // Typed directed document<->document relations (see indexes/inverted/Relations.js)
];

export function normalizeBitmapKey(key) {
    if (key === null || key === undefined) { return null; }
    if (typeof key !== 'string') { throw new Error('Bitmap key must be a string'); }

    const isNegated = key.startsWith('!');
    const rawKey = isNegated ? key.slice(1) : key;
    // Allowed charset: a-z 0-9 _ - . / @ : — '@' and ':' are kept so backend
    // addresses stay readable (data/backend/imap/user@domain.tld,
    // data/backend/workspace:home). '!' (negation), '/' (hierarchy/range
    // scans) and whitespace stay reserved.
    const normalized = rawKey
        .replace(/\\/g, '/')
        .replace(/\s+/g, '_')
        .toLowerCase()
        .replace(/[^a-z0-9_\-./@:]/g, '_')
        .replace(/_+/g, '_')
        .replace(/\/+/g, '/');

    return isNegated ? `!${normalized}` : normalized;
}

export function validateBitmapKey(key) {
    if (!key) { throw new Error('Bitmap key cannot be null or undefined'); }
    if (typeof key !== 'string') { throw new Error('Bitmap key must be a string'); }

    const normalizedKey = normalizeBitmapKey(key);
    const keyWithoutNegation = normalizedKey.startsWith('!') ? normalizedKey.slice(1) : normalizedKey;
    const isValid = ALLOWED_BITMAP_PREFIXES.some(prefix => keyWithoutNegation.startsWith(prefix));
    if (!isValid) {
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
