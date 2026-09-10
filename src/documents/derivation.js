'use strict';

import debugInstance from 'debug';
import schemaRegistry from '../schemas/SchemaRegistry.js';
import { DERIVED_FEATURE_PREFIXES } from '../schemas/Document.js';
import { predicateId } from '../indexes/edges/predicates.js';
import { normalizeBitmapKeys, validateBitmapKey } from '../indexes/bitmaps/lib/keys.js';

const debug = debugInstance('canvas:synapsd');

// Presence bitmap for docs carrying a non-empty user-authored comment. A `feature/`
// key so it is non-internal (listed + user-filterable in the toolbox). Ticked/unticked
// from doc state on every write, so it is derived and can never drift.
//
// Also dropped + replayed by rebuildL3, like every other derived key. That is not
// redundant with the write-path untick: a comment is the one text class nothing can
// regenerate (a photo's "two minutes before the wine disaster" is not recoverable
// from any captioner), so the bitmap that makes it findable must be reconstructable
// from the row rather than trusting that no write path ever missed an untick.
export const COMMENT_BITMAP_KEY = 'feature/has-comment';

// Per-MIME-type presence bitmaps, derived from a doc's metadata.contentType. Two
// keys per doc: the top-level type ('data/mime/image') for modality-scoped scans
// (e.g. image-only reembed = iterate this bitmap instead of re-scanning every doc)
// and the full type ('data/mime/image/jpeg') for granular filtering. Like the
// comment bitmap these are derived from doc state each write (no synapse reverse
// index), so a backfill (reindexMimeBitmaps) reconstructs them for existing docs.
// The generic inline-JSON default is skipped: notes/tabs/emails are all
// application/json, so it would only shadow the schema bitmaps with no new signal.
export const MIME_BITMAP_PREFIX = 'data/mime/';
const GENERIC_MIME = 'application/json';
export function mimeBitmapKeys(doc) {
    const raw = typeof doc?.metadata?.contentType === 'string' ? doc.metadata.contentType : '';
    const clean = raw.split(';')[0].trim().toLowerCase(); // drop '; charset=...' params
    if (!clean || clean === GENERIC_MIME) { return []; }
    const slash = clean.indexOf('/');
    if (slash <= 0 || slash >= clean.length - 1) { return []; } // not a valid type/subtype
    const type = clean.slice(0, slash);
    return normalizeBitmapKeys([`${MIME_BITMAP_PREFIX}${type}`, `${MIME_BITMAP_PREFIX}${clean}`]);
}

// Facet bitmaps: data/<field>/<value>, derived from a schema-declared field
// ("who says so?" — the document; controlled vocabulary, always rederivable).
//
// Generalized 2026-08-03 from a bespoke status axis hardcoded to todo. A schema
// declares `static facetFields = ['data.status']` and the leaf field name becomes
// the namespace, so a consumer abstraction gets the same machinery without an
// engine change — the same "declare it on the class" pattern as indexOptions and
// mergeOnDedupe.
//
// Engine-owned namespaces are refused: a schema declaring `data.mime` would write
// into a derived axis, where it would be indistinguishable from a derived value
// while being immune to that derivation's stale-diff.
//
// `kind` stays listed although its axis was REMOVED 2026-08-04: a database
// migrated from v3 can still carry stale `data/kind/*` bitmaps, and a consumer
// facet writing into that namespace would be indistinguishable from the residue.
// Retired, not free.
//
// `abstraction` joined the retired set with `kind` (Rev B, 2026-08-05):
// `data/schema/*` became `data/schema/*`, a migrated database can still
// carry residue in the old namespace, and a consumer facet writing into it would
// be indistinguishable from that residue. Retired, not free.
//
// `schema` was sealed AHEAD of its own namespace existing (Rev A, 2026-08-04) and
// is now the live identity axis itself.
const ENGINE_OWNED_FACET_NAMESPACES = new Set([
    'abstraction', 'schema', 'kind', 'mime', 'backend', 'source', 'dataset', 'no-location',
]);

// Device documents are the source of truth for the derived device/os|type facets.
export const DEVICE_SCHEMA_NAME = 'data/schema/device';

// The orphan bitmap: a document that HAD a resolvable copy and lost it. Derived
// from `orphanedAt` (+ empty locations, which is what unticks it on re-bind).
// A `feature/` key for the same reason as feature/has-comment: an engine-observed
// boolean read off one row field, user-filterable in the toolbox.
//
// Deliberately NOT derived from the schema. A per-schema "owns locations" flag
// cannot answer this for Task: one typed into Canvas is complete without a copy,
// one mirrored from a deleted GitHub issue is not. Same schema, opposite answers,
// because the discriminator is per-row provenance.
//
// Named for the state it indexes, not for the field it reads. "Has no locations"
// is a different (much larger, much less useful) set that nothing materializes:
// every note and local task is in it. A File with no bytes and no orphan stamp is
// a broken row rather than an orphan, and would want its own key.
export const ORPHANED_FEATURE = 'feature/orphaned';

function facetFieldKeys(doc) {
    const fields = doc?.constructor?.facetFields;
    if (!Array.isArray(fields) || fields.length === 0) { return []; }

    const keys = [];
    for (const field of fields) {
        const segments = String(field).split('.');
        const namespace = segments[segments.length - 1];
        if (!namespace || ENGINE_OWNED_FACET_NAMESPACES.has(namespace)) {
            debug(`Skipping facet field "${field}" on ${doc?.schema} — "${namespace}" is engine-owned`);
            continue;
        }
        // One value or many. Multi-value is what lets a CAPABILITY facet exist at
        // all — an application runs on several platforms, a document is in several
        // states — and it costs nothing extra to keep truthful: every write path
        // diffs the previous key SET against the current one, so dropping a single
        // entry from the array unticks exactly that key and nothing else.
        const value = segments.reduce((acc, seg) => (acc == null ? acc : acc[seg]), doc);
        for (const entry of Array.isArray(value) ? value : [value]) {
            if (typeof entry !== 'string' || entry.trim() === '') { continue; }
            keys.push(`data/${namespace}/${entry.trim().toLowerCase()}`);
        }
    }

    return normalizeBitmapKeys(keys);
}

// Every `data/<facet>/` namespace any registered schema can emit, computed the
// same way facetFieldKeys computes it so the two cannot disagree about which
// namespace a facet field lands in.
function facetNamespacePrefixes() {
    const prefixes = new Set();
    for (const schemaId of schemaRegistry.listSchemas()) {
        const fields = schemaRegistry.getSchema(schemaId)?.facetFields;
        for (const field of Array.isArray(fields) ? fields : []) {
            const namespace = String(field).split('.').pop();
            if (!namespace || ENGINE_OWNED_FACET_NAMESPACES.has(namespace)) { continue; }
            prefixes.add(`data/${namespace}`);
        }
    }
    return [...prefixes];
}

// What rebuildL3 drops before replaying, and it is deliberately the same list
// Document strips on write: a namespace the engine derives is a namespace no row
// can assert, so rows are its only source and the rebuild must rebuild ALL of it.
// Skip a derived namespace here and the rebuild computes `stale ∪ derived(rows)`
// instead of `derived(rows)` — the replay only ticks — so the drift it was run to
// repair survives it. The converse is the sharper edge: everything dropped here
// MUST be reproducible by #replayDerivedPlane, or a rebuild destroys it.
//
// Asserted namespaces (tag/, custom/, client/, data/dataset/) are absent on
// purpose. link() ticks those without touching the row, so the rows are not their
// only source and dropping them would delete membership nothing can put back.
export function derivedBitmapPrefixes() {
    return [
        ...DERIVED_FEATURE_PREFIXES.map((prefix) => prefix.replace(/\/+$/, '')),
        ...facetNamespacePrefixes(),
    ];
}

// Retired axes: dropped one-way, because nothing derives them any more and a
// database migrated from an older version still carries the residue. A rebuild is
// how it sheds them. `data/kind` (2026-08-04) and `data/abstraction` (2026-08-05)
// lost to `data/schema`; the `no-location` spellings lost to `feature/orphaned`
// when the orphan axis moved off "empty locations" onto `orphanedAt`.
// Entries are namespaces OR bare keys, because listBitmaps() returns the
// prefix's own key alongside its children — `data/no-location` is a leaf with
// no children and lists as itself. It used to need a second, separate list for
// exactly that reason. (`data/backend/no-location` needs no entry: it sits
// under the live `data/backend` prefix and is dropped with it.)
export const RETIRED_BITMAP_PREFIXES = ['data/kind', 'data/abstraction', 'data/no-location'];

// A document's root `features` array is DECLARATIVE and authoritative: the
// document JSON says what it is, and bitmaps follow it 1:1. Every write path
// derives its tick set from this, so a feature stored on the document is always
// indexed — storing it IS the way to create/update the bitmap.
//
// v3 moved this off `metadata` (which holds EXTRACTED facts written by derivers)
// to a top-level array (ASSERTED membership written by humans/clients). The
// array is asserted-only: Document strips DERIVED prefixes on the way in, so
// this function never sees a `data/schema/*` or `device/*` key it would tick
// without owning the corresponding untick.
//
// Invalid keys are skipped rather than thrown: a document written by an older or
// third-party client must not turn every subsequent re-put into a hard failure.
export function documentFeatureKeys(doc) {
    const features = doc?.features;
    if (!Array.isArray(features)) { return []; }
    const keys = [];
    for (const feature of features) {
        try {
            validateBitmapKey(feature);
            keys.push(feature);
        } catch {
            debug(`Skipping document feature "${feature}" — not a valid bitmap key`);
        }
    }
    return keys;
}

// Asserted edges, declared by the document: `data.relations = [{p, to}]`.
// Validated at ingest rather than in Document, because the predicate registry
// is an index concern and this is where Phase 4 will derive the actual edges —
// one place, all write paths.
//
// Rejecting early is deliberate: a relation with an unknown predicate or a
// non-integer target can never become an edge, so storing it would leave the row
// claiming a relationship the graph does not have. Predicate errors from
// predicateId() are already precise (including the inverse-name case).
export function validateDocumentRelations(doc) {
    const relations = doc?.data?.relations;
    if (relations === undefined || relations === null) { return; }

    if (!Array.isArray(relations)) {
        throw new Error('data.relations must be an array of { p, to } entries');
    }

    for (const relation of relations) {
        if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
            throw new Error('data.relations entries must be objects of shape { p, to }');
        }
        // Throws on unknown predicates AND on inverse-style spellings: direction
        // is an axis expressed by which side declares the edge, never by a name.
        predicateId(relation.p);
        if (!Number.isInteger(relation.to) || relation.to <= 0) {
            throw new Error(
                `data.relations entry for predicate "${relation.p}" needs a positive integer document id ` +
                `as "to" (got ${JSON.stringify(relation.to)})`,
            );
        }
    }
}

// Normalized asserted relations of a document, as `{p, to}` pairs. Validation
// already happened at ingest (validateDocumentRelations), so this only shapes.
export function documentRelations(doc) {
    const relations = doc?.data?.relations;
    if (!Array.isArray(relations)) { return []; }
    return relations
        .filter((r) => r && typeof r === 'object' && typeof r.p === 'string' && Number.isInteger(r.to))
        .map((r) => ({ p: r.p, to: r.to }));
}

export const relationKey = (relation) => `${relation.p}\u0000${relation.to}`;

// Derived facet keys (mime + schema-declared facets) for one doc — ticked on every
// write, with stale keys from the previous doc state unticked, so they can't drift.
// Exported for tests: the facet derivation is pure and worth asserting directly,
// rather than only through a full put/read round-trip.

// Schema-declared feature bitmaps (`static getFeatureBitmapArray(doc)` — Email's
// `feature/email/*` mailbox flags). Derived from row state like every other facet,
// so they ride the facet plane's tick/stale-untick symmetry and #replayDerivedPlane
// reproduces them: before Rev B they were only ticked when ingest passed them as
// insert-time features, which made them tick-only (a flag change never unticked)
// and invisible to a rebuild.
function classDeclaredFeatureKeys(doc) {
    const cls = doc?.constructor;
    if (typeof cls?.getFeatureBitmapArray !== 'function') { return []; }
    const keys = cls.getFeatureBitmapArray(doc);
    return Array.isArray(keys) ? keys : [];
}

export function facetBitmapKeys(doc) {
    return [...mimeBitmapKeys(doc), ...facetFieldKeys(doc), ...classDeclaredFeatureKeys(doc)];
}

// ── Schema identity keys ─────────────────────────────────────────────────────
// Hierarchical expansion of a doc's schema id. One rule: EVERY segment below
// `data/schema/` is ticked — `data/schema/message/email` ticks
// `data/schema/message` AND itself. The parent key is always a roll-up.
// This is ancestor ticking of the ID PATH, not the class-chain expansion v3 killed.
//
// Tick and untick paths MUST both use this function (stale diffs are computed
// against the same expansion), or parent keys would never untick.
const SCHEMA_BITMAP_PREFIX = 'data/schema/';

export function schemaBitmapKeys(doc) {
    const id = doc?.schema;
    if (typeof id !== 'string' || id === '') { return []; }
    // Foreign/legacy id shapes (no hierarchy defined for them): tick verbatim,
    // exactly what the old single-push sites did.
    if (!id.startsWith(SCHEMA_BITMAP_PREFIX)) { return [id]; }

    const keys = [];
    let slash = id.indexOf('/', SCHEMA_BITMAP_PREFIX.length);
    while (slash !== -1) {
        keys.push(id.slice(0, slash));
        slash = id.indexOf('/', slash + 1);
    }
    keys.push(id);
    return keys;
}

