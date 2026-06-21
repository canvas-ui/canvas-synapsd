'use strict';

// Canonical query/spec parser. Pure and stateless: turns the public spec shape
// into an internal { paths, features, filters, options } structure. Tree->bitmap
// resolution stays in the db; this module only parses strings and sigils.
//
// Sigil algebra (uniform across buckets):
//   default -> anyOf (OR)
//   '+'     -> allOf (required gate)
//   '!'     -> noneOf (exclude)
//
// Path grammar: 'ctx:/a/b' (context tree) and 'dir:/a/b' (directory tree).
// Bare paths default to context.

const SIGIL = { PLUS: '+', BANG: '!' };

function splitSigil(token) {
    const t = String(token).trim();
    if (t.startsWith(SIGIL.PLUS)) { return { sigil: 'allOf', body: t.slice(1).trim() }; }
    if (t.startsWith(SIGIL.BANG)) { return { sigil: 'noneOf', body: t.slice(1).trim() }; }
    return { sigil: 'anyOf', body: t };
}

function parsePathToken(token) {
    const { sigil, body } = splitSigil(token);
    let type = 'context';
    let path = body;
    if (body.startsWith('ctx:')) { type = 'context'; path = body.slice(4); }
    else if (body.startsWith('dir:')) { type = 'directory'; path = body.slice(4); }
    if (!path) { path = '/'; }
    return { type, path, exclude: sigil === 'noneOf' };
}

// paths: string[] sigil tokens | { in, not } | tree-qualified context/directory
// selectors. The ctx:/dir: string grammar targets default trees; the
// context/directory selector objects carry an explicit tree id.
function parsePaths(spec) {
    const inEntries = [];
    const notEntries = [];

    const pushToken = (token) => {
        const entry = parsePathToken(token);
        (entry.exclude ? notEntries : inEntries).push({ type: entry.type, path: entry.path });
    };

    if (Array.isArray(spec.paths)) {
        for (const token of spec.paths.filter(Boolean)) { pushToken(token); }
    } else if (spec.paths && typeof spec.paths === 'object') {
        for (const token of (spec.paths.in ?? []).filter(Boolean)) { pushToken(token); }
        for (const token of (spec.paths.not ?? []).filter(Boolean)) {
            const entry = parsePathToken(token);
            notEntries.push({ type: entry.type, path: entry.path });
        }
    }

    if (spec.context != null) { inEntries.push(treeEntry('context', spec.context)); }
    if (spec.directory != null) { inEntries.push(treeEntry('directory', spec.directory)); }

    return { in: inEntries, not: notEntries };
}

// Tree-qualified selector -> path entry, preserving the tree id when present.
function treeEntry(type, selector) {
    if (selector && typeof selector === 'object' && !Array.isArray(selector)) {
        return { type, path: selector.path ?? selector[type] ?? '/', tree: selector.tree ?? selector.treeId ?? null };
    }
    return { type, path: selector ?? '/' };
}

function legacyArray(value) {
    if (value == null) { return []; }
    return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

// features: string[] (sigil tokens) | { allOf, anyOf, noneOf }
function parseFeatures(spec) {
    const source = spec.features ?? null;
    const out = { allOf: [], anyOf: [], noneOf: [] };
    if (!source) { return out; }

    if (Array.isArray(source)) {
        for (const token of source.filter(Boolean)) {
            const { sigil, body } = splitSigil(token);
            out[sigil].push(body);
        }
        return out;
    }
    if (typeof source !== 'object') {
        throw new Error('spec.features must be an array or object');
    }
    out.allOf = [...(source.allOf ?? [])];
    out.anyOf = [...(source.anyOf ?? [])];
    out.noneOf = [...(source.noneOf ?? [])];
    // '!'-prefixed entries inside allOf/anyOf are sugar for noneOf.
    for (const bucket of ['allOf', 'anyOf']) {
        out[bucket] = out[bucket].filter((k) => {
            if (typeof k === 'string' && k.startsWith('!')) { out.noneOf.push(k.slice(1)); return false; }
            return true;
        });
    }
    return out;
}

// filters: string[] tokens | { timeline } legacy | legacy filterArray
function parseFilters(spec) {
    const tokens = [];
    if (Array.isArray(spec.filters)) {
        for (const token of spec.filters.filter(Boolean)) {
            // g:/re: are recognised but not yet implemented; reject at parse time.
            const body = typeof token === 'string' ? token.replace(/^[+!]/, '').trim() : '';
            if (body.startsWith('g:')) { throw new Error('list(): unsupported filter "glob" (not yet implemented)'); }
            if (body.startsWith('re:')) { throw new Error('list(): unsupported filter "regexp" (not yet implemented)'); }
            tokens.push(token);
        }
    } else if (spec.filters && typeof spec.filters === 'object') {
        for (const v of legacyArray(spec.filters.timeline)) { tokens.push(`t:crud:updated:${v}`); }
        if (spec.filters.glob) { throw new Error('list(): unsupported filter "glob"'); }
        if (spec.filters.regexp) { throw new Error('list(): unsupported filter "regexp"'); }
    }
    return tokens;
}

export function parseSpec(rawSpec = {}) {
    if (!rawSpec || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
        throw new Error('spec must be an object');
    }

    const base = typeof rawSpec.options === 'object' && rawSpec.options !== null ? rawSpec.options : {};
    const pick = (key) => rawSpec[key] !== undefined ? rawSpec[key] : base[key];

    return {
        paths: parsePaths(rawSpec),
        features: parseFeatures(rawSpec),
        filters: parseFilters(rawSpec),
        options: {
            mode: (pick('mode') || 'hybrid').toLowerCase(),
            limit: pick('limit'),
            offset: pick('offset'),
            page: pick('page'),
            parse: pick('parse'),
            groupBy: pick('groupBy'),
        },
    };
}

export default parseSpec;
