# TODO

Only open engine work belongs here. The current API and landed design live in
`README.md`.

## Event payload contract (next up — 2026-08-18)

`reason` LANDED: 3.5.0 discriminated `document.updated`, 3.6.0 extended the axis
to every document event (`created` | `content` | `membership` | `deleted`,
exported as `DOCUMENT_EVENT_REASONS`) and pinned the whole contract in
`tests/event-payload-contract.test.js`. `batch` stays an orthogonal axis
(payload SHAPE, not what changed).

Anchor case, so the motivation does not get lost: a workspace hook rule matching
on `schema`/`mime` fired on insert and silently NEVER on a re-link, because the
membership-only `document.updated` carries no document and nothing said so. The
payload shape WAS the contract, undocumented and unasserted.

Settled principle — **events carry deltas, conditions ask about state**.
`memberships` / `contextArray` are the CHANGED placement, never the document's
full placement, so "is this filed under /x" can only be answered by reading the
bitmaps. Rejected: fattening events with full placement or loading documents at
emit sites that do not have them in hand (a 10k bulk link would become 10k reads
to serve consumers that may not care, and every socket subscriber pays the
serialization). Consumer-side hydration lives in canvas-server's hook dispatcher
and is the correct home for it.

- [ ] **Retire the membership-only `document.updated` alias.** It exists only
      for consumers predating `document.linked` / `document.unlinked`, which
      carry the full document and are strictly better. With `reason` shipped the
      migration is mechanical but needs a CONSUMER SURVEY first (canvas-server,
      apps/web, browser extension, agentd): emit both for one release with a log
      line whenever anything binds the alias, then drop it. Collapses four
      `document.updated` emit sites to two meanings and removes the trap at the
      source instead of documenting around it. The biggest of these three by
      blast radius, not by engine complexity.
- [ ] **Fix the membership payload vocabulary** (pairs with the above — one
      breaking pass, aliases kept for a release):
  - `memberships` reads as "the document's memberships" but means "the ones that
    changed" — rename to `changed` (or `membershipDelta`).
  - `contextArray` / `directoryArray` on removal events hold unticked LAYER
    NAMES (`'filed'`), not paths (`'/filed'`) — despite the field name and the
    `removedContextPaths` variable behind it both saying paths. Found
    2026-08-18 while writing the contract test; pinned there with a comment so
    the behaviour is at least asserted. A consumer reading it as paths matches
    nothing, silently.
- [ ] **Assert reserved keys in `createEvent`.** It spreads `...detail`, so an
      emit site can shadow envelope keys (`event`, `source`, `timestamp`,
      `eventId`) with no warning. Dev-mode throw, costs nothing, prevents the
      inverse of the bug the `reason` work just fixed. Independent of the two
      above; smallest of the three.

Note for consumers of this contract: payload reconstruction must be
inherit-by-default (spread, then subtract what does not apply), never a
hand-maintained allow-list. canvas-server's batch fan-out was an allow-list and
silently dropped `reason` for every batch write until it was inverted
(2026-08-18); `buildReplayEnvelope` there and `createEvent`/`createTreeEvent`
here already do it the right way.

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

Goal: several positions or ranges per document on one timeline. LANDED
2026-08-16 (see checked items below; design record kept for the rationale).
The doc model: `timelineEntrySchema` allows multiple entries per timeline name,
each entry optionally carrying an opaque `ref` anchor:

```js
timelines: [
  { timeline: 'wikipedia', start: '1769-08-15', ref: 'd1' },
  { timeline: 'wikipedia', start: '1799-11-09', end: '1804-05-18', ref: 'consulate' },
]
```

The document stays the source of truth and every timeline index stays
L3-derived. SynapsD never parses content to extract dates or resolve refs —
distillation (markup → entries) and the anchor convention are the app's
responsibility; the engine only stores and returns `ref` verbatim. `ref` also
points toward the semantic layer (an anchor is a position in content the same
way a cell is a position in a space), so keep it an opaque string, not a
timeline-specific format. The current dual-BSI stays the canonical sortable
value plane holding ONE primary interval per doc (first entry or explicit
`primary`), which keeps `sortBy` semantics unambiguous.

Settled — the membership plane is **tiled coverings, Pilosa time-quantum
shaped** (Pilosa/FeatureBase independently arrived at the same split: BSI for
single sortable values, per-granularity membership views for plural events):

- Per-cell doc-id bitmaps `internal/tsm/<timeline>/<scale>/<cellId>`, quantum
  depth configured per timeline (a YMDH analog: `wikipedia` ~year, deep-time
  axes ~Myr, `events` ~day). Intervals write a hierarchical covering (coarse
  cells mid-span, finer at boundaries) at ingest; range queries union the
  minimal cell covering of the query range.
- Precision = finest configured quantum, **no row refinement in v1** (Pilosa
  precedent: quantum queries don't refine). An `exact` opt-in flag can land
  later without a format change.
- Cell bitmaps hold doc ids, so they AND natively with context/feature/geo
  filters and spend cheap key space, not 32-bit id space.
- Rejected — occurrence-ID indirection. Packed `occId = (docId << k) |
  ordinal` is beautiful arithmetic but throws on legitimate fan-out (a
  meta-analysis citing 50 studies) and spends doc-id bits, the scarce
  currency; the BSI-translation-table variant resurrects allocation/GC
  bookkeeping. The per-occurrence chronological listing it uniquely enabled
  has no product surface; if one appears it can be added alongside tiling
  later, derived from the same `timelines[]`.
- Rejected — bitmasking multiple values into one BSI word: destroys the
  slice-comparison algebra that makes range queries work.
- App boundary: engine multi-position covers *positions of this document*
  (distilled dates in a note). Entity-worthy occurrences (a cited study, a
  referenced event) are promoted by the app to their own documents with
  edges to the source; fan-out beyond a dozen-ish entries is a modeling
  smell, not an engine limit.
- L4/L5 note: the agent recall structure (now-relative anchors, exponential
  falloff — itself a log-scale tiling anchored at the present) sits above
  this layer, consumes `(anchor, time-tag, pointer)` tuples, and unfolds
  into exact timelines on demand. It is representation-independent and
  constrains nothing here.

We are not building a generic DB (standalone-usable, yes); our zeitgeist
multi-timeline shape (`mode: 'grouped'` across named axes) stays as-is —
FeatureBase's frames-per-attribute layout is not an improvement on it. From
their code (archived clone in `_SCRATCH_/featurebase`) we ingest exactly two
things:

- [x] LANDED 2026-08-16 — covering decomposition ported from `viewsByTimeRange`
      (`time.go:158`) as one greedy loop (emit the coarsest cell that starts
      here and fits; equivalent to their up-then-down walk), generalized over
      our scale tiers (deep-time included) and used on BOTH sides: ingest-time
      interval coverings and query-time range decomposition. Their calendar
      edge cases live in `tests/timeline-quantum-covering.test.js`; porting
      them surfaced and fixed a latent December month→day boundary bug
      (`daysFromCivil(year, 13, 1)` threw, silently swallowed on query).
      Two planes (`internal/tsm/<tl>/<scale>/{c,a}/<cell>`): cover cells plus
      ancestor ticks — ancestor ticks are what let a coarse query cell match a
      fine-stored doc without either side enumerating the other's granularity;
      ancestors of query cells are probed in the cover plane only (an ancestor
      tick means "presence somewhere inside", which does not imply overlap).
- [x] DECIDED 2026-08-16 — FIXED quantum per timeline (FeatureBase precedent),
      constructor-deterministic like pointTimelines, nothing persisted.
      Defaults: 'day', `wikipedia`='year', deep-time axes opt into
      Gyr/Myr/Kyr via `timelineQuantum`; sub-day rejected until an hour/minute
      tier exists (day→second fan-out is 86400). Benchmarked
      (`scripts/bench-timeline-quantum.js`, Wikipedia-shaped mix): day quantum
      ≈2.3× cells and ≈4× insert time vs year, query throughput flat.
      **SUPERSEDED 2026-08-18 — see "Adaptive quantum" below.**
- [x] LANDED 2026-08-16 — recurring Event series expansion: bounded rules in
      the supported RRULE subset expand into per-occurrence entries (first
      occurrence = primary); unbounded/unsupported/over-cap rules keep the
      envelope (never-miss beats precision). See `src/schemas/core/Event.js`.
- [ ] Batch timeline rebuilds before Wikipedia-scale ingestion.
- [ ] Optional later: an `exact` opt-in flag (row refinement below quantum) —
      possible without a format change; and hour/minute tiers to legalize
      sub-day quantums for dense calendar corpora.

### Adaptive quantum (settled 2026-08-18, supersedes FIXED-per-timeline)

One timeline must carry geological eras (Myr), lifespans (year) and single
events (day) at once — Wikipedia distillation lands all three on `wikipedia` —
so ANY per-timeline floor is the wrong knob regardless of who sets it ('year'
discards event precision, 'day' explodes eras). The floor moves to the ENTRY:

- Covering floor derived from the entry's own notation: `'1769'` → year,
  `'1769-08'` → month, `'1769-08-15'` → day; explicit `scale` stays the
  override (deep time declares Myr/Gyr as today). Precision contract: you get
  out the precision you put in — quantum rounding at the entry's own
  precision, no configuration anywhere. Sub-day notation clamps to day until
  hour/minute tiers exist (unchanged). Query floor likewise from the query's
  notation (`1996..1999` decomposes at year).
- NO structural change: scales already nest into one hierarchy, tsm tiers are
  already lazy, the greedy covering already emits multi-scale cells, and the
  `{c,a}` two-plane rule already glues arbitrary scale gaps (query cells in
  c+a find same/finer-stored docs; ancestors of query cells in c find
  coarser-stored docs). FIXED quantum was a config bound, not a structural
  need; removing it costs ancestor ticks up the full 9-scale ladder per cover
  cell, nothing else.
- Pareto vs both fixed choices (per the existing bench): day cost is paid
  only by day-precise entries, era entries stay coarse, no precision lost.
- Restores full L3 purity: rebuilds derive everything from rows alone —
  `timelineQuantum` via constructor made rebuild output config-dependent.
- Deprecate: `timelineQuantum` constructor option, `PUT
  /timelines/:name/quantum`, `workspace.json` `timelines.quantum`
  persistence, web quantum select. CRUD timelines stay internal point-BSI
  (system-badged/hidden in UI); the user-facing default timeline type is the
  tiled multi-position ("S2") timeline — creation needs a name, nothing else.

- [x] LANDED 2026-08-18 (synapsd 3.7.0) — per-entry floors via `#tileFloor`
      (notation scale, day-clamped) on both `#tsmKeysForInterval` and
      `#queryMultiBitmap`; full-ladder ancestor ticks were already the
      existing `#ancestorCells` behavior, so no format change and no
      migration was needed for the {c,a} planes themselves. Quantum config
      deleted end-to-end: `timelineQuantum` option + get/setQuantum (engine),
      `PUT /timelines/:name/quantum` + workspace.json persistence (server
      2.5.45, verbose listing now returns observed `scales` via the new
      `getScales()`), quantum selects (web 2.7.36 — create row is name-only,
      per-timeline badge shows observed tiers). `decomposeRange` returns
      `{floor, cells}`. Tests updated; 414/414 synapsd, 382/382 server.
- [x] Bench re-run 2026-08-18 (`scripts/bench-timeline-quantum.js`, now
      notation-mix corpora): all-year 11.6 cells/entry, all-day 27.1, MIXED
      (Wikipedia-shaped) 14.85 with the best insert throughput (1739/s vs
      1301/814) — day cost only where data is day-precise, as designed.
- [ ] Migration: tsm coverings written under the fixed-quantum era re-derive
      at entry precision via rebuild — fold into the batch-rebuild work; land
      together with the open-interval sidecar BEFORE the 7M-doc wiki run.
- [ ] Web follow-up: crud:* are already surfaced as dedicated toggles, not in
      the deletable list; decide whether they need an explicit "system" badge.

### Open-interval sidecar (settled 2026-08-16, LANDED 2026-08-18, synapsd 3.8.0)

LANDED with ONE amendment for the adaptive-quantum era: "stored at the quantum
scale" had lost its referent, so sidecar values live in per-scale lazy tiers
(`internal/tsm/<tl>/open/<scale>/{start,end}`) at each entry's notation-derived
scale — structurally the primary plane's tiering, minus sortBy. Min/max
collapse is per (doc, scale, side); tiers union at query time, which preserves
losslessness (per-tier min + OR = global min semantics). Everything else
shipped as designed: ±∞ tiles stayed rejected, open-must-be-primary throw
removed in `#normalizeDocumentTimelineEntries`, `insertEntries`/`removeEntries`
partition open entries to the sidecar (removal clears the collapsed side —
exact for the row write path, tolerant for manual partial removals), queries/
histogram/grouped/layers inherit via `#querySidecar` in `#queryMultiBitmap`,
gated on tier ebm existence. Server 2.5.46 (comment-level only — the entry
grammar was already the whole surface). Tests: engine sidecar suite in
`tests/timeline-open-intervals.test.js` (collapse across inserts, mixed-scale
fan, open query sides, degenerate (-∞,+∞)), the Cenozoic+living-person doc
case + row-re-derivation in `tests/timeline-multi-position.test.js`, server
`tests/core/workspace/timelines.test.js`. 421/421 synapsd, 389/389 server.
The 7M-doc wiki run is now UNBLOCKED (batch rebuilds remain a perf item, not
a correctness gate; dev-env data will be wiped and rebuilt anyway).

Original design record (kept for rationale):

Lifts the last multi-position restriction: today an open-ended entry must be
the PRIMARY, so one document cannot carry two ongoing facts on one timeline
("still in the Cenozoic" + "person still alive", both distilled into
`wikipedia`). Wiki-scale distillation will hit this — parsed dates all land on
one timeline, and forcing the distiller to pick which ongoing fact gets the
primary slot (or to bound the other at snapshot date) is exactly the kind of
plane-routing knowledge the API must not leak. The entry grammar stays the
only surface; where an entry lives is the engine's business.

Design — a per-timeline BSI *sidecar inside the tsm plane*, NOT ∞ tiles:

- Rejected — literal ±∞ cells. Tiles match by key identity; overlap with
  `[s, +∞)` is the one-sided test `s <= query.end`, which no identity match
  can encode. A single `+∞` cell over-matches unboundedly (every open doc
  matches every query — not quantum rounding, wrong answers), and tiling the
  tail needs either infinitely many cells or a wall-clock write horizon
  (rebuild drift, already rejected). One-sided comparisons are what BSI slice
  algebra does; openness belongs to a BSI. (The primary plane's sentinels ARE
  the ±∞ "tiles" of the BSI world — this sidecar is the same move, scoped to
  the membership plane.)
- Storage: `internal/tsm/<tl>/open/start` — BSI holding, per doc, the start
  of its open-END entries; `internal/tsm/<tl>/open/end` — symmetric, the end
  of its open-START entries. Lazy like every tier; absent until first use, no
  format change, no migration.
- Collapse rule (what makes ONE value per doc lossless): for membership
  semantics `[s1,+∞) ∪ [s2,+∞) = [min(s1,s2), +∞)`, so any number of
  open-end entries per (doc, timeline) stores as min(start); open-start
  symmetrically as max(end). `(-∞,+∞)` = both sentinels, degenerate and
  fine. The ROW keeps every entry + ref verbatim — only the index collapses,
  and the index answers membership only.
- Scale: sidecar values are stored at ONE fixed scale per timeline — the
  quantum scale (convert on write like cell coverings do). Avoids per-scale
  sidecar fan-out; quantum-grade precision is the plane's contract anyway.
- Query: in `#queryMultiBitmap`, OR in `open/start <= enc(query.end)` and
  `open/end >= enc(query.start)` (skip the respective probe when the query
  side is itself open — it then matches all sidecar docs, which is correct:
  `[qs,+∞)` overlaps every `[s,+∞)`). Gated behind the sidecar's own ebm
  existence, so timelines without open entries pay nothing. histogram /
  grouped / layers / zeitgeist inherit it for free.
- Write path: `#normalizeDocumentTimelineEntries` drops the open-must-be-
  primary throw; non-primary open entries route to the sidecar (min/max
  merge on insert). Removal recomputes from the row like cell coverings —
  same tolerant on-the-way-out contract. `insertEntries`/`removeEntries`
  accept open intervals instead of throwing.
- Unchanged: primary stays the ONE sortable interval (`sortBy` untouched);
  an open primary keeps living in the main dual-BSI exactly as today.
- Tests to port the edge case: Cenozoic + living-person on one timeline in
  one doc; open + bounded mix; query windows before/inside the open span;
  removal restores empty; rebuild-from-rows reproduces the sidecar.

## Schemas

- [ ] Point web consumers at the published JSON Schema endpoint and delete
      copied schema enums. Consumer work lives in Canvas.
- [ ] Design remote schema registration only when a real consumer needs it.
      Resolve persistence, scope, and checksum-identity changes first.
- [ ] Reduce app-specific bundled schemas as consumers take ownership.

## Trees and membership

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
