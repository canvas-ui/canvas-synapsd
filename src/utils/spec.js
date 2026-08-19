'use strict';

import { predicateId } from '../indexes/edges/predicates.js';
import { parseFilters as categorizeFilterTokens } from './filters.js';

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
// `recursive` (directory trees only) widens node-exact folder scoping to the
// whole subtree — searches want it, folder listings don't.
function treeEntry(type, selector) {
    if (selector && typeof selector === 'object' && !Array.isArray(selector)) {
        return {
            type,
            path: selector.path ?? selector[type] ?? '/',
            tree: selector.tree ?? selector.treeId ?? null,
            recursive: selector.recursive === true,
        };
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
        // Validate token SHAPE here, at spec-parse time, not at resolve time.
        // list() catches resolve-time errors into an `.error` array (a contract
        // three call sites rely on), so a malformed token thrown from there is
        // reported but still looks like "no results" to anyone not checking. A
        // malformed token is a caller bug, like the g:/re: cases above — fail it
        // the same way, before the query runs.
        categorizeFilterTokens(tokens);
    } else if (spec.filters && typeof spec.filters === 'object') {
        for (const v of legacyArray(spec.filters.timeline)) { tokens.push(`t:crud:updated:${v}`); }
        if (spec.filters.glob) { throw new Error('list(): unsupported filter "glob"'); }
        if (spec.filters.regexp) { throw new Error('list(): unsupported filter "regexp"'); }
    }
    return tokens;
}

// Graph-adjacency bucket: one hop from a known document.
//
//   rel: { p: 'mentions', of: 123 }               docs that 123 mentions
//   rel: { p: 'mentions', of: 123, dir: 'in' }    docs mentioning 123
//   rel: [ {p:'replies-to', of:55}, {op:'noneOf', p:'derived-from', of:55} ]
//
// DIRECTION IS AN AXIS, never a predicate name — `dir` selects which dupsort DBI
// is scanned. There are no inverse predicate names anywhere in the system.
//
// `op` is the same sigil trio as features: anyOf (default) / allOf / noneOf.
// Multi-hop traversal is deliberately out of scope for v3.
const REL_OPS = new Set(['anyOf', 'allOf', 'noneOf']);

export function parseRel(rawSpec = {}) {
    const base = typeof rawSpec.options === 'object' && rawSpec.options !== null ? rawSpec.options : {};
    const raw = rawSpec.rel !== undefined ? rawSpec.rel : base.rel;
    if (raw === undefined || raw === null) { return []; }

    const entries = Array.isArray(raw) ? raw : [raw];
    return entries.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error('rel entries must be objects of shape { p, of, dir?, op? }');
        }
        if (typeof entry.p !== 'string' || entry.p === '') {
            throw new Error('rel entry requires a predicate "p"');
        }
        // Validate here, not at scan time: the sigil combiner catches operand
        // errors and yields an empty bitmap, so an unknown or inverse-style
        // predicate would SILENTLY widen the result set instead of failing.
        predicateId(entry.p);
        // `of` may be one id or an array of ids ("any of these anchors"): the
        // combiner unions the adjacency lists BEFORE the sigil algebra, so an
        // allOf entry with three ids means "related to at least one of the
        // three" AND-ed with the other constraints — the shape a name resolving
        // to several identity documents needs. [] would be an always-empty
        // operand that silently blanks the result set, so it is rejected.
        const normalizeOf = (value) => {
            const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? parseInt(value, 10) : value;
            if (!Number.isInteger(n) || n <= 0) {
                throw new Error(`rel entry for predicate "${entry.p}" requires a positive integer document id as "of"`);
            }
            return n;
        };
        const of = Array.isArray(entry.of) ? entry.of.map(normalizeOf) : normalizeOf(entry.of);
        if (Array.isArray(of) && of.length === 0) {
            throw new Error(`rel entry for predicate "${entry.p}" has an empty "of" array`);
        }
        const dir = String(entry.dir || 'out').toLowerCase();
        if (dir !== 'out' && dir !== 'in') {
            throw new Error(`rel entry "dir" must be 'out' or 'in' (got ${JSON.stringify(entry.dir)})`);
        }
        const op = entry.op || 'anyOf';
        if (!REL_OPS.has(op)) {
            throw new Error(`rel entry "op" must be one of ${[...REL_OPS].join(', ')} (got ${JSON.stringify(entry.op)})`);
        }
        return { op, sigil: op, p: entry.p, of, dir };
    });
}

// ids: number[] — a literal candidate set supplied by an external producer
// (kNN results, sensor anchor emissions, an agent-curated working set). It
// resolves to a bitmap with no index dependency: no collection keys, never
// coarse. [] is a deliberately-empty constraint; absent means unconstrained.
function parseIds(spec) {
    const raw = spec.ids;
    if (raw === undefined || raw === null) { return null; }
    if (!Array.isArray(raw)) { throw new Error('spec.ids must be an array of document ids'); }
    return raw.map((v) => {
        const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? parseInt(v, 10) : v;
        if (!Number.isInteger(n) || n <= 0 || n > 0xFFFFFFFF) {
            throw new Error(`spec.ids entries must be positive uint32 document ids (got ${JSON.stringify(v)})`);
        }
        return n;
    });
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
        rel: parseRel(rawSpec),
        ids: parseIds(rawSpec),
        options: {
            mode: (pick('mode') || 'hybrid').toLowerCase(),
            // Listing order (no-match path only): 'asc' (id/insertion order,
            // default) or 'desc' (newest ids first). With sortBy, order applies
            // to the timeline sort key instead of the id.
            order: (String(pick('order') || 'asc').toLowerCase() === 'desc') ? 'desc' : 'asc',
            // Timeline to sort a listing by (e.g. 'content', 'crud:created').
            // Docs with no value on that timeline always trail the sorted ones.
            sortBy: pick('sortBy'),
            limit: pick('limit'),
            offset: pick('offset'),
            page: pick('page'),
            parse: pick('parse'),
            // Return the matching document ids only, skipping the LMDB fetch and
            // parse entirely. For callers that already hold the documents and
            // only need to know whether the result set moved (cache revalidation).
            idsOnly: pick('idsOnly'),
            groupBy: pick('groupBy'),
            // Optional cosine-distance floor for the dense side of vector/hybrid
            // search: drop kNN neighbours outside [minDistance, maxDistance] before
            // fusion. 0 = identical, 2 = opposite. Omit for no floor.
            minDistance: pick('minDistance'),
            maxDistance: pick('maxDistance'),
            // Calibration: attach raw (unfloored) image kNN distances to the result.
            debug: pick('debug'),
            // How many of them (default 25, capped at 500). The top-25 neighbours
            // of any query cluster tightly — locating where relevance actually
            // ends needs a deeper window.
            debugLimit: pick('debugLimit'),
        },
    };
}

export default parseSpec;
