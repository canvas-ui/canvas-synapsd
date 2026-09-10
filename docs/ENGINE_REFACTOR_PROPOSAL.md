# SynapsD engine refactor proposal

Review date: 2026-09-10. Scope: current `src/index.js` and its collaborating
indexes, backend, schemas, views, sessions, tests, and selected server callers.
The assessment and source line references below describe the original review
snapshot. Steps 1–4 have since been implemented; see the implementation
record at the end for changes and validation.

## Assessment

`src/index.js` is 6,253 lines. Its size reflects several distinct responsibilities:
resource initialization, tree registration, document preparation and deduplication,
write coordination, membership and derived indexes, query resolution, ranking,
vector administration, event delivery, and maintenance.

The highest cost is duplicated consistency logic. `putMany` (line 1342),
`#putOne` (2705), and `#updateOne` (4112) independently coordinate snapshots,
checksums, timelines, geo, relations, memberships, facets, search, and events.
`#replayDerivedPlane` (5956) separately reconstructs part of that state.
Adding a new derived field requires remembering several paths and their ordering.

There are useful existing boundaries: storage/index classes, pure spec utilities,
and `QuerySession`, which already composes `resolveCandidates()` and `rank()`.
Preserve those investments. `semantic/index.js` is currently an initialization
stub holding the whole DB reference; actual search ownership remains in the facade.

## Findings to address before consolidating writes

### High: single updates retain stale checksum mappings

In `#updateOne`, `storedDocument.update(updateData)` mutates and returns
the original instance. At `src/index.js:4184` the code deletes
`storedDocument.checksumArray`, which now contains the new checksums. The old
ones remain. The batch path correctly snapshots previous checksums first.

Confirmed on a temporary DB: insert a note, record its primary checksum, then
`put({ id, schema, data: changedData })`. `checksumIndex.get(oldChecksum)` still
returns the edited document's ID. Subsequent ingestion of the old content can
therefore deduplicate against a document whose content has changed.

Add the single-write equivalent of the checksum regression in
`tests/update-id-preservation.test.js`, then fix the snapshot separately from
structural moves.

### High: deferred membership does not cover all bitmap writes

`#withDeferredMembership` (5616) buffers only operations routed through
`#applyMembership`. `putMany` directly ticks `internal/docs/all` inside its
transaction at line 1533; single put and update have equivalent direct calls.
BitmapIndex mutates cached instances and persists using `putSync`.

Confirmed by throwing on the second `documents.put` of a two-item batch:
the failed operation leaves both allocated IDs in `allDocumentsBitmap`, including
an ID with no document row. The probe also observed the first row still readable
immediately after failure, so transaction behavior needs investigation beyond
merely deferring this one bitmap. Do not claim whole-write atomicity from the
current tag-membership rollback test.

Expand fault injection to assert rows, checksums, all-doc membership, timelines,
geo, edges, tree caches, reverse memberships, and events, both immediately and
after reopen. Audit every direct bitmap mutation in write paths.

### Medium: startup refuses old schemas after performing initialization writes

`start()` creates/backfills bitmaps and Lance, loads device rows, and ensures
default trees before checking the schema version at line 860. An incompatible
database can be modified before it is refused. Move compatibility checking ahead
of derived-index initialization/backfills; test refusal leaves logical stored
state unchanged. Define cleanup for partially initialized resources.

### Additional review risks, not reproduced failures

- `#membershipBuffer` is instance-global. Its reentrancy test cannot distinguish
  intentional nesting from overlapping async operations. Test concurrent writes
  and aborts before choosing transaction-local context or explicit serialization.
- Single and batch writes differ in search-index refresh, embedding seen-ledger
  invalidation, and event ordering. For example, `#updateOne` clears seen keys for
  opened vector spaces, while `putMany` has no corresponding loop. Establish the
  intended external embedding contract before unifying these paths.
- Several Lance failures are swallowed, leaving durable rows and search at
  different states. Preserve current best-effort behavior during extraction;
  observable repair/retry policy is a separate behavioral change.

## Proposed ownership

Keep `SynapsD` as the public EventEmitter facade and composition root. Retain
existing method signatures, return shapes, exports, getters, and public handles
such as `documents` and `bitmapIndex` during this work. Server and tree callers
already depend on that surface. Target roughly 500–800 facade lines, as a design
guide rather than a hard limit.

| Module | Owns | Existing code to move |
| --- | --- | --- |
| `documents/derivation.js` | Pure schema/facet/feature keys, relation validation, dedup merge helpers, immutable before-state snapshots | Top-level document helpers; repeated write snapshots |
| `trees/TreeRegistry.js` | Tree metadata/cache/defaults, creation/deletion, selection, event forwarding | Public tree methods at 900; registry helpers at 4681 |
| `query/CandidateResolver.js` | Scope/dataset algebra, bitmap selectors, temporal/geo/relation filters, invalidation dependencies | `resolveCandidates`, `#resolveParsed`, selector builders |
| `query/QueryEngine.js` | Ranking, pagination, compound/refined queries, FTS/vector fusion | `rank` through `openSession`, image query helpers |
| `search/VectorSpaces.js` | Space configuration, lazy index instances, ledgers, model/table names, vector administration | Vector methods at 1703–2074; semantic configuration |
| `documents/DocumentWriter.js` | Preparation, ID/dedup semantics, batched persistence, update/delete orchestration | `putMany`, single put/update/delete and batch delete |
| `membership/MembershipService.js` | Asserted membership, reverse-index updates, link/unlink, transaction-bound pending changes | Membership/link/unlink methods and deferred membership helpers |
| `documents/DerivedIndexes.js` | Before/after diffs and replay of row-derived indexes | Location/device facets, schema/facet/comment membership, timelines/geo, asserted relation synchronization |
| `maintenance/MaintenanceService.js` | Rebuild/reindex/backfill orchestration and progress | `rebuildL3`, reindexers, export/dump operations |

Do not immediately create a class for every helper. Keep pure functions together
by domain and split large services further only when ownership demands it.
Keep low-level `EdgeIndex`, `TimelineIndex`, `GeoIndex`, `LanceIndex`, and
`VectorIndex` intact initially.

Dependencies should be explicit: stores, indexes, tree resolver, document reader,
and event publishing functions. Do not pass the entire facade to every new
service or use prototype mixins to bypass private fields. Move private state to
its owner and delegate through ordinary methods. Existing tree-to-facade calls
can remain compatibility adapters initially; avoid new service cycles.

The query boundary must retain `{ bitmap, collectionKeys, coarse }` semantics,
including null versus empty candidate sets, since QuerySession invalidation
depends on them. The vector service stores/searches vectors; embedding generation
continues to belong to the injected external service.

## Shared write design

After behavior is characterized, introduce an explicit prepared change:

```js
// Schematic contract, not an implementation.
{
  id,
  operation,            // insert, explicit update, checksum dedup, delete
  before,               // independent snapshot, never a mutable doc alias
  after,
  membershipIntent,     // caller assertions and tree selections
  provenance,
  searchChanged,
}
```

Single and batch APIs should share preparation and index-diff logic. Keep batch
ID allocation, in-batch checksum dedup, deferred membership aggregation, and one
Lance batch write. Implementing `putMany` as a loop over `put` would lose those
properties. Preserve deliberate single/batch result and event differences through
adapters until an explicitly separate API change is justified.

Give each write a clear sequence: prepare and validate, commit authoritative
state, apply derived/cache effects, perform best-effort search updates, and publish
the documented event sequence. This is a target contract: current behavior differs
and changing ordering requires consumer tests, especially for embedding events.
Inventory which indexes are transaction-bound versus cached or external before
assigning operations to those phases. LMDB commit cannot imply Lance atomicity.

Rebuild should reuse the same row derivations as incremental writes. Keep asserted
memberships distinct: `link()` can create state not present in rows, so replaying
documents cannot reconstruct every tree/tag/dataset membership. Preserve the
existing derived-versus-asserted namespace rules and reverse-index source of truth.

## Delivery sequence

1. **Regression coverage and isolated fixes.** Add the two reproduced cases,
   startup refusal invariants, and write/event behavior characterization. Fix
   correctness separately so extraction reviews remain mechanical.
2. **Pure document helpers.** Extract derivation, snapshots, and dedup helpers.
   Preserve named helper exports from `index.js` as compatibility re-exports.
3. **Query and vector ownership.** Extract VectorSpaces, CandidateResolver, then
   QueryEngine. Keep public query wrappers and QuerySession working unchanged.
4. **Tree registry.** Move tree state and selection together, preserving default
   trees, metadata keys, cache identity, and forwarded event payloads.
5. **Membership and derived indexes.** Establish explicit transaction ownership
   and common before/after derivations; audit direct cached-index mutations.
6. **Document writer.** Consolidate single/batch orchestration around prepared
   changes while retaining batch optimizations and compatibility adapters.
7. **Maintenance and lifecycle cleanup.** Delegate rebuilds/backfills to the
   extracted owners; simplify startup/shutdown and document dependency ordering.

Each step should be independently reviewable and runnable. No schema migration,
backend replacement, TypeScript conversion, generic plugin framework, or public
API redesign is needed for this refactor.

## Validation and completion criteria

Baseline executed during review: `npm test -- --runInBand` passed **60 suites /
481 tests** in approximately 49 seconds. Separate temporary-database probes
confirmed the stale checksum and phantom all-doc bitmap cases. These probes were
diagnostic, not permanent regression tests. Native Lance deprecation warnings
were emitted; they did not fail the suite.

Use the existing tests for scopes/datasets, sessions, ranking/refinement, vector
provenance/ledgers, tree semantics, relations, derived facets, rebuild, ID reuse,
and event contracts as extraction gates. Add tests for the gaps above rather than
tests that simply assert calls to newly introduced helpers.

Before consolidating write paths, characterize repeated explicit IDs within a
batch, cross-schema checksum collisions, partial preparation failures, event
listener failures, overlapping transactions, and post-commit search failure.
Use `scripts/bench-putmany.js` on a disposable DB for before/after throughput;
also compare query latency on the same fixture. Do not benchmark user workspaces.

Completion means each mutable subsystem has an owner, document-derived rules
are shared between writes and replay, transaction/event contracts are explicit,
and existing clients can use the same facade. Reducing the line count follows
from those changes.

## Implementation record — steps 1 and 2

Implemented on 2026-09-10. Public signatures and existing named helper exports
are preserved. `src/index.js` is now 5,947 lines (formerly 6,253).

### Step 1: regression coverage and isolated fixes

- Single updates snapshot old checksums before mutating the document, so old
  content can be reimported without overwriting the edited document.
- The LMDB wrapper now uses abortable child transactions. The original
  `transaction()` callback batching did not abort earlier writes on failure;
  this explains the partially committed row observed during review.
- On rollback, invalidate native dataset caches, restore bitmap objects from
  persisted state in place, reload existing tree objects, and refresh device
  facets. Direct all-doc, timeline, and geo bitmap writes stay transaction-bound;
  cache restoration covers their in-memory mutations without copying the entire
  bitmap cache on every successful write.
- Public document/relation mutations queue from preparation through publication.
  Transaction-local membership/event buffers distinguish internal nesting from
  independent calls, including writes initiated by event listeners. Serializing
  preparation is necessary: an overlapping insert otherwise allocates its ID
  inside an unrelated suspended native transaction and loses that reservation
  when the other operation aborts.
- Tree and document events generated inside a write transaction publish after
  commit and membership flush. Aborted writes discard them. Existing document
  event shapes and single/batch compatibility emissions remain covered by tests.
  A throwing post-commit listener still rejects the API call without undoing
  committed data; it does not strand the write queue.
- Schema compatibility is checked before bitmap/tree/search initialization.
  Failed `start()` retains the constructor-opened LMDB handle for inspection,
  as before; callers must `await shutdown()` in cleanup. Automatic lifecycle
  cleanup/restart redesign remains step 7.

The transaction coverage concerns engine-managed document writes with the bundled
LMDB store. It does not promise read isolation from in-flight cached mutations,
coordinate direct writes through exposed low-level handles, or make external
Lance updates atomic with LMDB. Maintenance and embedding APIs still need the
ownership/concurrency review in later steps.

### Step 2: extracted document helpers

- `src/documents/derivation.js`: schema, MIME, facet and asserted-feature keys;
  relation validation/shaping; derived and retired namespace definitions.
- `src/documents/deduplication.js`: schema-declared field merging and location
  union. These retain their existing intentional mutation of the incoming doc.
- `src/documents/snapshot.js`: detached, frozen before-state records and the
  batch search-content change predicate. Single and batch updates share the
  snapshot; the eleven separately managed batch snapshot fields are gone.
- `index.js` re-exports `derivedBitmapPrefixes`, `facetBitmapKeysForTest`, and
  `schemaBitmapKeysForTest` for compatibility.

### Validation

- Full suite: **61 suites / 497 tests passed** (16 added tests).
- The three initial regression tests failed against the pre-fix implementation
  and passed after fixes. The overlapping-ID test additionally demonstrated
  reservation loss before preparation was included in the write queue.
- New coverage includes aborted inserts/updates/deletes, rows and index state
  after reopen, existing bitmap/tree references, incoming asserted relations,
  overlapping writes, events, early schema refusal, and snapshot independence.
- ESLint on all changed/new JavaScript files passes with no output.
  Repository-wide `npm run lint` still reports 14 pre-existing errors in
  unrelated legacy/ignored files; these were not changed.
- `git diff --check` passes.

A disposable-database comparison against the original HEAD used three fresh runs
of 250 deterministic notes, batch insert followed by batch update, with Lance
writes skipped, plus 100 ID-only bitmap queries. Median batch insert time was
approximately **135 → 158 ms** and update **175 → 204 ms** (about **17%** higher
write time); 100 queries took **3.8 → 4.1 ms**. This is a small local smoke
benchmark, not a production throughput estimate. Correct rollback and write
coordination add overhead that should remain visible during subsequent writer
work. The existing benchmark script uses a retired schema ID, so the comparison
used an isolated temporary harness with current note schemas instead.

At completion of steps 1–2, steps 3–7 remained proposed. Shared write orchestration, broader
failure-policy changes, and search/embedding event-order unification are still
separate work.


## Implementation record — steps 3 and 4

Implemented on 2026-09-10. `src/index.js` is now **4,064 lines**, down from
5,947 after steps 1–2 (a further 32% reduction), and 6,253 at the original review.
Public method signatures and named helper exports remain intact.

### Step 3: query and vector services

- `src/search/VectorSpaces.js` owns vector configuration, opened indexes,
  model-specific tables, embedding ledgers, and vector administration.
- `src/query/CandidateResolver.js` resolves tree, dataset, feature, relation,
  timeline, and geo scopes. It retains the consulted membership keys and coarse
  dependencies used by sessions, including unconstrained versus empty candidates.
- `src/query/QueryEngine.js` owns ranking, pagination, FTS/vector fusion, and
  compound/refined searches. It reads current vector configuration and indexes
  through VectorSpaces, so model switches and live tuning remain visible.
- The facade constructs these services with explicit dependencies. Runtime index
  getters avoid capturing uninitialized indexes. QuerySession still uses the
  public facade's `resolveCandidates()` and `rank()` methods.
- Corrupt-row-tolerant parsing is shared through `src/utils/document.js` by query
  materialization and maintenance.

### Step 4: tree registry

- `src/trees/TreeRegistry.js` owns tree metadata, defaults, cached instances,
  selection, collection access, and event forwarding.
- The facade supplies tree construction and event publication callbacks. Existing
  tree document APIs retain their facade access, and transactional events still
  flow through the existing deferred publication mechanism.
- Rollback reloads the registry's existing cached tree instances, preserving
  references held by callers. Storage prefixes, names, default selection, and
  settings retain their existing semantics.

Steps 5–7 remain proposed: membership and derived-index ownership, shared writer
orchestration, and maintenance/lifecycle cleanup. These extractions do not change transaction policy
or broaden the atomicity guarantees documented for steps 1–2.


### Validation

- Full suite: **63 suites / 501 tests passed**.
- Four new integration tests cover context/directory rename and reopen, cached
  identity and forwarded events, default-tree replacement/deletion, and vector
  model switching with search, stats, ledgers, inactive-table cleanup, and reopen.
- Existing session invalidation, tree settings, linked queries, vector provenance,
  refined searches, and transaction rollback tests remain green.
- AST comparison against the steps 1–2 checkpoint confirms all **97 public
  method/getter signatures** are unchanged, including defaults and async flags.
- ESLint on changed/new JavaScript and `git diff --check` pass.

A local comparison against the completed steps 1–2 checkpoint used five fresh
runs per version, each with 1,000 deterministic notes, batch insert/update with
Lance writes skipped, and 100 ID-only bitmap queries. Median timings:

| Operation | After steps 1–2 | After steps 3–4 |
| --- | ---: | ---: |
| Insert 1,000 documents | 852 ms | 874 ms |
| Update 1,000 documents | 1,115 ms | 1,169 ms |
| 100 bitmap queries | 7.28 ms | 7.66 ms |

Measured write differences were about 2.5% and 4.8% (22 ms and 54 ms per batch).
The runs varied substantially, so this smoke benchmark cannot distinguish small
refactor overhead from local timing noise. It does not measure production
throughput or embedding/FTS ingestion. No transaction or batching policy changed.
