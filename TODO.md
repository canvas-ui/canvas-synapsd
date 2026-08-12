# TODO

Only open engine work belongs here. The current API and landed design live in
`README.md`.

## Semantic anchors

Inferd produces model output and codebook assignments. SynapsD only stores and
combines model/version-namespaced anchor membership. Settled: the wire format
decouples from storage — producers emit normalized 64-bit S2-shaped IDs (or
anchor paths) and whether SynapsD resolves them via a BSI range or an internal
context-tree layer stays an implementation detail behind the filter token.

- [ ] Benchmark the producer before choosing storage.
- [ ] Decide the cardinality contract first. A point BSI stores one value per
      document, while useful inputs will probably emit several anchors. Reusing
      `GeoIndex` without solving that mismatch would quietly recreate the
      multi-position timeline problem.
- [ ] Compare:
  - model-keyed anchor bitmaps or quantizer bands;
  - occurrence indirection plus a sortable 64-bit code (continuous widening via
    range queries, but high-D → 2-D locality is provably lossy (JL bound) —
    adjacency at a fixed level is partly fake; the codebook does the real work,
    not the curve);
  - engine-owned semantic dimension trees with ancestor widening (graded recall
    via ancestor ticking, backoff = parent-path cue swap, atomic v1→v2 tree
    rebuild; discrete taxonomy, no continuous neighborhoods).
- [ ] Treat S2/Hilbert as a storage encoding candidate, not evidence that a
      high-dimensional semantic manifold became two-dimensional without loss.
- [ ] Add an `anchor:` filter family. `geo:` remains physical GPS. Cell IDs are
      64-bit unsigned — parse as BigInt/hex in filter tokens, no float precision
      loss.
- [ ] Add model-keyed presence/seen ledgers and APIs to store, clear, inspect,
      and query anchors.
- [ ] Preserve the L3 invariant: anchor indexes are disposable and reproducible
      from documents plus a versioned external codebook.
- [ ] Support side-by-side model spaces and atomic active-space switching.

## QuerySession

- [ ] Exclude `internal/gc/deleted` in the session-wide combination so a
      literal ID-only cue cannot retain tombstones.
- [ ] Mark requested but nonexistent tree paths coarse. A path created later
      must invalidate and populate an already-open live session.
- [ ] Add a pure bitmap soft-overlap combinator if inferd/agentd measurements
      justify it. Keep clocks and decay outside the engine.
- [ ] Do not add weighted semantic scores here until their normalization across
      spaces is specified.

## Timelines

- [ ] Support several positions or ranges per document on one timeline.
- [ ] Keep the current BSI as the canonical sortable value plane.
- [ ] Choose a separate multi-position membership plane. Compare coarse
      coverings with row refinement against occurrence-ID indirection.
- [ ] Decide boundary precision before implementation.
- [ ] Batch timeline rebuilds before Wikipedia-scale ingestion.

## Schemas

- [ ] Point web consumers at the published JSON Schema endpoint and delete
      copied schema enums. Consumer work lives in Canvas.
- [ ] Design remote schema registration only when a real consumer needs it.
      Resolve persistence, scope, and checksum-identity changes first.
- [ ] Reduce app-specific bundled schemas as consumers take ownership.

## Trees and membership

- [ ] Repair legacy duplicate tree names created before uniqueness enforcement.
- [ ] Design context/directory subtree mountpoints:
  - same tree type only;
  - origin-path resolution;
  - lock lifecycle;
  - cycle rejection;
  - bounded nested mounts;
  - writes through a mount target the origin.
- [ ] Enforce locks for move, remove, delete, and rename.
- [ ] Define root-layer behavior instead of adding another decorative layer
      class.
- [ ] Finish label-layer semantics or remove the unused type.
- [ ] Extract shared document-target membership operations once mount work makes
      the duplication concrete.

## Query and write semantics

- [ ] Implement or remove recognized `g:` and `re:` filter syntax.
- [ ] Settle raw bitmap filter sigil consistency.
- [ ] Decide whether `list()` should stop returning runtime errors as an empty
      array with `.error`.
- [ ] Revisit replace-versus-patch writes as a dedicated API change.
- [ ] Add explicit result shaping for IDs, metadata, and full documents.
- [ ] Split `src/index.js`; start with maintenance/rebuild code and pure
      derivation helpers. Preserve the write and candidate-resolution choke
      points.

## Scale and operations

- [ ] Batch `rebuildL3()` bitmap replay. The current per-document loop is not
      viable at million-row scale.
- [ ] Add dump/import or snapshot/restore using LMDB's consistent copy.
- [ ] Add threshold-gated LMDB compaction based on reclaimable bytes.
- [ ] Audit batch methods for actual backend batch operations.
- [ ] Bound the BitmapIndex cache before Wikipedia-scale ingestion.

## Relations

- [ ] Add email recipient roles when reverse recipient queries are needed.
- [ ] Measure before adding per-identity bitmaps.
- [ ] Add coarse relation-presence bitmaps only with a measured query need.
- [ ] Keep traversal one-hop until a concrete multi-hop workload exists.
