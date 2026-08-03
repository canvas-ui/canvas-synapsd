# Notes

To eval
https://docs.lancedb.com/geneva/udfs/providers/sentence-transformers


RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval
https://arxiv.org/html/2401.18059v1

Spatial representation relies on two primary frameworks:
Allocentric: A map-like perspective centered on external landmarks (e.g., "The coffee shop is north of the park").

Egocentric: A self-centered perspective based on your own body axis (e.g., "The coffee shop is to my immediate left")

place cells (fire at specific locations), grid cells (form a repeating, triangular-shaped coordinate grid), and head direction cells (act as an internal compass)


The high-dimensional space you are thinking of is a neural manifold (specifically, a low-dimensional attractor manifold or toroidal manifold). [1, 2, 3] 
While the brain contains billions of neurons—creating a massive, high-dimensional neural firing space—the activity of spatial cells is tightly constrained. The collective firing patterns map onto a highly organized, lower-dimensional geometric shape. [1, 4, 5] 
## The Toroidal Manifold (T²)
Because grid cells fire in a repeating, hexagonal lattice across space, their population activity does not stretch out into infinite Euclidean space. Instead, mathematically, if you "glue" the periodic edges of their firing fields together, the activity wraps into a two-dimensional torus (a donut shape). [1, 2, 6, 7] 

* 
* The Structure: As you walk through a flat room, the high-dimensional neural state vector moves like a continuous trajectory tracing the surface of this donut. [2, 8] 
* Discovery: This was experimentally proven in 2022 by researchers at the Kavli Institute using topological data analysis, showing that even during sleep, the internal network dynamics of grid cells maintain this rigid, toroidal structure. [2] 
* 

## Continuous Attractor Networks (CANs)
The mechanism keeping the brain's data on this manifold is a Continuous Attractor Network. [1, 9] 

* 
* In this high-dimensional state space, the physical constraints of the neural wiring create "valleys" of stable energy.
* The system is "attracted" to these valleys, restricting the chaotic possibilities of billions of firing neurons into a smooth, structured mathematical surface that directly corresponds to physical coordinates. [1, 4] 
* 

## Hyperbolic Space
For complex, multi-layered environments or hierarchical mental maps, neuroscientists have also discovered that the hippocampus encodes information using hyperbolic geometry (a non-Euclidean space with negative curvature, resembling a saddle). This allows the brain to exponentially pack scale and distant landmarks into a compact network. [10, 11, 12, 13] 
If you'd like, we can look deeper into how topological data analysis (TDA) was used to pull that donut shape out of messy brain signals, or explore how continuous attractors prevent us from instantly forgetting our location. [1, 2] 

[1] [https://pmc.ncbi.nlm.nih.gov](https://pmc.ncbi.nlm.nih.gov/articles/PMC11620739/)
[2] [https://www.youtube.com](https://www.youtube.com/watch?v=0eW4w3zl7JY&t=13)
[3] [https://medium.com](https://medium.com/@wickjparabellum/lost-in-high-dimensions-the-manifold-hypothesis-offers-a-map-6aab6a9af46d)
[4] [https://elifesciences.org](https://elifesciences.org/reviewed-preprints/89851v1)
[5] [https://eureka.patsnap.com](https://eureka.patsnap.com/article/manifold-learning-why-high-dimensional-data-lives-on-low-dimensional-curves)
[6] [https://www.youtube.com](https://www.youtube.com/watch?v=4oIH6Rzp96Y&t=1)
[7] [https://www.quantamagazine.org](https://www.quantamagazine.org/how-animals-map-3d-spaces-surprises-brain-researchers-20211014/)
[8] [https://www.sciencedirect.com](https://www.sciencedirect.com/science/article/abs/pii/S1571064519300089)
[9] [https://arxiv.org](https://arxiv.org/abs/2507.00598)
[10] [https://arxiv.org](https://arxiv.org/html/2409.12990v1)
[11] [https://ijrar.org](https://ijrar.org/papers/IJRAR19D6761.pdf)
[12] [https://www.wall.org](https://www.wall.org/~aron/blog/curvature-i-space/)
[13] [https://www.salk.edu](https://www.salk.edu/news-release/the-brains-ability-to-perceive-space-expands-like-the-universe/)


---

# SynapsD

## Proper synapse support + schema refactor

(partially implemented, needs to be extended)

### L0 "storage" centric
Resources, where the physical bits of the full objects are stored and can be retrieved from
data/resource/blob or file or url/uri? - points to a local or remote resource (immutable)
data/resource/reference - points to a external source(db, s3)

### L1 Semantics 
data/entity/file ? (blob)
data/entity/document (JSON doc)
data/entity/message
data/entity/event (type: calendar, alert, activity)
data/entity/task
data/entity/identity (type: person, organization, service, bot)
data/entity/device
data/entity/application
data/entity/dotfile
? data/entity/organization

### L2 Relations (would require some cleanup)
SUPERSEDED by the closed predicate registry (src/indexes/edges/predicates.js), which is
append-only and ids-in-keys: includes 1, references 2, derived-from 3, mentions 4, replies-to 5,
depicts 6, authored-by 7. Notes on the ones sketched here that did NOT survive:
  generated-from  -> folded into derived-from
  executed-on     -> never modelled
  installed-on    -> REJECTED. Device presence is not an edge: "what is on device X" is already
                     answered schema-agnostically by the device/id/* bitmaps derived from
                     locations[], which drop straight into the paths ∩ features ∩ filters
                     pipeline. Rule of thumb: edges are for document-to-document facts with no
                     derivable location; anything expressible as "these bytes live here" stays in
                     locations[] and its derived bitmaps.

### L3 Semantic anchors
Specially generated semantic anchors/chunks and summaries with several sub-layers (more on that later)
Hierarchical semantic tree(s) on top of semantic layers

## Spatial GeoIndex (S2)

**IMPLEMENTED 2026-07-13** as designed below (preferred shape): `indexes/inverted/GeoIndex.js`,
single point-BSI `internal/geo/s2` over level-21 cell ids (nodes2ts, pure JS, BigInt-native —
unsigned face-4/5 ids verified), derived from `metadata.geo` on put/update/delete (ebm probe
guards the no-geo common case), `geo:bbox:` / `geo:near:` / `geo:cell:` filter tokens through
the shared sigil combiner. Tests: `tests/geo-index.test.js`. Deferred from the notes below:
polygon coverings (viewport bbox covers the mapbox case; nodes2ts has no S2Polygon), the
`geo/hasLocation` prefilter micro-opt (ebm already serves that role).

- A lossy spatial index for candidate sets only — display/rendering reads raw GPS coords from
  the doc (exif → OSM etc.); the index never needs to reproduce coordinates.
- **Preferred shape: single BSI over the S2 cellId, not per-level membership bitmaps.** Store
  one full-precision cellId per geotagged doc in a point-style BSI (same machinery as point
  timelines). S2 containment is an id-range: every ancestor cell covers the contiguous interval
  `[rangeMin, rangeMax]` of its descendants — so "in cell X" = one BSI range query, any level,
  no per-level index at all. Region query: S2 region coverer → k cells → k range queries ORed →
  AND into `resolveCandidates` like any other bucket.
- This dissolves the how-many-levels question: bitmap count is fixed at the BSI slice width
  (~2×maxLevel + 3 face bits), independent of precision and of which levels queries use.
- Precision cap: level 30 (~1 cm) is fake precision for GPS (~3–10 m accuracy). Cap stored ids
  at **level 21 (~5 m)** — honest for exif, trims the BSI to ~45 slices. Same no-fake-precision
  stance as the timeline scales.
- Alternative (fallback if BSI range perf disappoints): per-level cell-membership bitmaps
  `geo/s2/<level>/<cellId>` at 3–4 fixed levels (e.g. 6 ~150 km region, 10 ~10 km city,
  13 ~1 km neighborhood, 16 ~150 m venue), coverer snapped to indexed levels. Cheaper single-AND
  per cell, but level grid is frozen at index time and occupied-cell key count grows with data.
- Optional micro-opt on top of the BSI: one coarse presence/prefilter bitmap (`geo/hasLocation`)
  to skip the BSI entirely for non-geo corpora.

## Semantic layer

To test *7M wikipedia articles, ~2 milion files ingestion
- en wikipedia dataset converted to thousands of markdown files ingested into a workspace > synapsd
This is pure text so the current embedding model should be sufficient, dataset a bit too clean so not really a prod test yet
- Dataset will be post-processed by a local LLM to associate its content with a dedicated "wikipedia" timeline (naive, simple, stupid for round 1, we'll get to the more interesting hierachical vector trees later)
- embedding path: ensure wikipedia text lands in a server-embeddable schema (derived `document`/`note`, registered in `embeddableSchemas`) - as `data/abstraction/file` you'd embed `locationUrls`, not the article.
- [Input Chunk] ➔ [Qwen3-VL (64d)] ➔ [PCA (e.g., 16d or 32d)] ➔ [Scalar Quantizer (Bands)] ➔ [Roaring Bitmap Index]

### Semantic dimension trees (reuse ContextTree test)

The anchor layer is NOT a new index — it's tree construction. Reuse the existing tree module:
one internal context-type tree per semantic dimension (topic, visual, episode, …), anchors are
ordinary layers, queried alongside user trees via multi-spec AND:
`semantic:/…/… ∩ semantic-visual:/…/… ∩ ctx:/work/dc-migration`.

- **Graded recall for free:** ticking along the path makes ancestor bitmaps ⊇ descendants, so
  walking root-ward widens the candidate set *semantically* (zoom-out / deep-recall). Backoff
  loop: deepest matching anchors → `count()` → too thin? replace cue with parent path, recount —
  one operand re-resolve per step in a QuerySession; `materialize()` = escalate to exact docs.
- **Derived, disposable:** semantic trees are engine-owned (locked, hidden from user edit),
  rebuilt as a whole — build `semantic-topic@v2` alongside, atomic swap, drop v1. Docs untouched.
- Machine-generated layer names prefixed per type/modality (shared-layer-by-name stays a
  context-tree feature; prefixes just keep anchor vocabularies from colliding across dimensions).
- Relations stay flat bitmap keys / L2 relation schemas, not tree layers — except identity
  special cases (contacts/persons) where a per-entity dimension layer is warranted.
- Payoff: anchor-construction strategies (clustering, layered summaries, quantizer bands,
  LLM taxonomy) are swappable tree builders producing the same artifact — benchmark against the
  same gold set, engine unchanged.

## Refactor v3 — LANDED 2026-08-03

Shipped across 7 phases + 2b. The implementation plan (`TODO.refactor-v3.md`) has been deleted: it
was a working document for one week's work and stopped being useful once the code landed. What
follows is only what is still OPEN. The code and `README.md` are the reference for what exists.

**What landed, in one paragraph.** Typed doc↔doc edges moved from bitmaps to a dupsort adjacency
index (`src/indexes/edges/`, 7 predicates, direction as an axis). `data.relations` on a row is
derived into asserted edges on write; the `rel` query bucket composes adjacency into the normal
candidate pipeline. Schemas got a runtime registry (`registerSchema`, core/app/internal tiers) with
`kind` as a derived hierarchical axis (`data/kind/*`). `indexOptions` left the row for a class
static (~414 B/row, 43% of a note). `metadata.features` became a root-level asserted `features[]`
with derived prefixes stripped. `data/backend/*` became derived from `locations[]` and absorbed
`data/source/*`. `data/status/*` generalized to schema-declared `facetFields`. Dotfile identity
became a normalized URI. `contact`→`identity`, `bucket` deleted, `event` added. Schema version 2
with `scripts/migrate-v3.js`, and `rebuildL3()` makes the rebuild invariant executable.

**D1 stands: schema ids stay `data/abstraction/*`.** `kind` is the migration path — see the rename
rev below.

### Open: the `data/entity/*` rename (its own rev)

Deferred, not cancelled. **Entry criterion: the five sibling submodules read `data/kind/*` rather
than `data/abstraction/*`.** The rename cost ~272 occurrences across `ui/web`, `browser-extensions`,
`ui/fuse`, `ui/cli`, `ui/shell`, plus a public route path (`/data/abstraction/:abstraction`), the
embedd router and a shipped config — while delivering none of v3's value. The decisive case is the
browser extension: installed in users' browsers, not atomically upgradable, so it keeps writing
`data/abstraction/tab` after any cutover.

Carries with it: `todo`→`task` (Task.js), `email`→`message kind:email` (fold Email.js),
`note`/`tab`/`link`→`document` + kind, the route path, the embedd router + shipped config, and the
test-suite port. **`dotfile` does NOT fold into `file`** — a dotfile can be a directory (no bytes,
no content checksum) and its identity is a repo URI, not a content hash.

Sweep target for that rev: every `data/abstraction/*` read in the submodules has moved to
`data/kind/*`.

### Open: timeline coverings (S2-shaped) — blocks the wikipedia corpus

**A document occupies ONE position per timeline.** The tier is a BSI keyed `id -> a single value`,
so a second `insert(name, id, …)` overwrites the first. Declaring two entries for one timeline name
now THROWS rather than silently keeping the last (which is how it failed before, invisibly: the row
kept every entry and `db.get()` re-rendered them all while the index held one).

**This is what the wikipedia import needs.** An article about ancient Egypt carries several ranges;
one-doc-per-range or a single collapsed envelope are the only options until coverings land.

Design settled 2026-08-03 — **reuse the `GeoIndex` covering pattern for time.** Spatial and temporal
representation sharing one underlying structure is the goal, not a shortcut (place/grid-cell
literature: projecting data into low-dimensional structures, recall generative at its core).

- **Declarative side needs no new field** — `timelines[]` already accepts N entries; the guard's
  throw becomes support.
- **Derived side:** `internal/ts/<timeline>/cover/<scale>/<bucket>` roaring bitmaps. Each range
  ticks the coarsest containing buckets plus finer boundary buckets — the S2 covering algorithm in
  1-D, over the existing `SCALES` hierarchy (`Gyr…ns`).
- **Cheap because** bucket-key count is bounded by *timespan ÷ granularity*, not by document count.
  All of human history at year scale is ~5k keys shared across every article.
- **The BSI stays** for exact `getSortKeys` and `histogram`; coverings become the membership
  structure. L3 by construction — droppable, rebuildable, slots into `rebuildL3()`.

**⚠️ OPEN, decide before building: boundary precision.** If an article says "Old Kingdom,
2686–2181 BC", must a query for exactly 2181 BC match, or is year-level overshoot acceptable? That
decides whether coverings need boundary refinement or can stop at the containing bucket.

Already supported, do not rebuild: wipeable datasets (`deleteDataset(name, {dropDocuments})` +
`data/dataset/*`) and layered zeitgeist queries (`RANGE_MODES` includes `layers`/`grouped`, so
`wikipedia,personal` against a birthdate works today).

Rejected: occurrence sub-ids (adds an id space + a translation step on every timeline query) and a
time-bucketed dupsort index (re-implements range querying that coverings get from bitmap unions).

### Open: consumer-registered abstractions

Already works: a subclass declaring `static indexOptions` gets its own fts/vector/checksum fields
(JS static inheritance, resolved via `this.constructor` — no registry import, no cycle); one
declaring none inherits its parent's; base mandatory fields stay enforced; `registerSchema()`
accepts it. `kindField`/`kindPrefix`/`facetFields`/`mergeOnDedupe` are all schema-declared.

Two gaps:

1. **No parent-aware data-schema helper.** `Phone.dataSchema` inherits `Device.dataSchema`
   unchanged, so a consumer's own fields are accepted (passthrough) but never *validated*.
   `extendDataSchema()` builds a fresh wrapper rather than extending the parent's payload. ⚠️ Fixing
   it needs care: `Document.dataSchema.shape.data` is a `z.record`, not a `z.object`, so a naive
   `.merge()` breaks every schema currently calling `Document.extendDataSchema`. Add a separate
   explicit helper. Small; can ride any commit.
2. **No registration ROUTE.** Registration is in-process JS only. Its own rev — an API design
   problem more than an engine one: a class cannot be transmitted over HTTP, so it needs a
   declarative descriptor compiled server-side into a zod schema + index options. Open questions:
   persistence across restarts, per-user vs per-workspace scoping, and the sharp one — **what
   happens to stored documents when a consumer re-registers a schema with different
   `checksumFields`**, since that silently changes document identity.

⚠️ Not to be confused with the superseded "schema inheritance" decision. What v3 killed is *bitmap
ancestor-chain ticking* (a tab ticking `data/abstraction/link` so "all links finds tabs"); `kind`
replaced that. CLASS extension for validation and index-option inheritance is alive and wanted.

### Open: post-v3 rough edges

Collected during the rev and the pre-prod migration. None are blocking; several are worth a
deliberate decision rather than a drive-by fix.

- **`update()` is replace, not patch, when a schema is supplied.** `put({id, schema, data})` clears
  `features[]` it does not resend (preserved prefixes excepted); the schema-LESS form
  (`put({id, data})` / `put({id, features})`) patches. Same footgun as dotfile `links`, which got a
  schema-declared `mergeOnDedupe` workaround. Fixing it globally is its own rev — the semantics are
  load-bearing for the stored-index reconciliation path.
- **`list()` swallows every resolve-time error into an empty array with `.error`.** Three call sites
  read `.error` (`routes/workspaces/documents.js:333,:612`, `Workspace.js:1526`), so the contract is
  deliberate — but a direct caller that does not check it sees "no results". Spec-shape errors now
  throw at parse time (outside the try), which covers the common case; whether the runtime contract
  should become an exception is open.
- **A declared backend key does not roll up.** `location.metadata.backend` emits a single-segment
  `data/backend/<declared>` (seen in pre-prod as `data/backend/fs:data:email`), while URL-derived
  keys are hierarchical (`data/backend/imap` + `data/backend/imap/<account>`). So a declared backend
  is invisible to "everything from X" roll-ups. If declared backends become common, the derivation
  should split them the way the URL path does.
- **`data/no-location` is asserted, not derived.** Nothing in synapsd derives it; the parent's
  orphan lifecycle writes it alongside `orphanedAt`. Deriving it from `locations.length === 0` is an
  open question — it would make the marker rebuildable, but the orphan lifecycle also carries
  intent ("kept deliberately") that a pure derivation would lose.
- **`kind` is absent rather than `null` on migrated rows with no kind axis.** The migration only
  writes the field when it changes, and `undefined ?? null === null`, so it skips. Anything built
  through `BaseDocument` gets an explicit `null`. Functionally identical; inconsistent if you grep
  raw rows.
- **Migration and rebuild are single-document loops.** The v3 row pass does a per-document `put`
  rather than one batched transaction, and the reverse scan holds a `docId → tags` Map in memory for
  the whole run. Fine at ~5k (pre-prod: 4953 docs, instant); neither is designed for 1M.
  `rebuildL3()` has the same shape. Measure on the wikipedia set before relying on it.
- **`reindexSearchIndex({rebuild:true}) is owed on migrated databases.** The FTS fix (objects were
  indexed as the literal `"[object Object]"`) changes indexed content for `data/abstraction/document`,
  Identity `identifiers`/`channels`/`links` and Email `from`/`to`. The migration deliberately does
  not force it — it is a content change, not a structural one.

### Open: parked additions

- **Email recipients (To/Cc → identity).** `authored-by` covers `From`. The *role* is distinct from
  authorship and cannot live in edge meta without colliding with the asserted-edge convention
  (asserted ⇒ no meta row), so it needs its own predicate ids or a role field. Deferred safely: ids
  are append-only and nothing is being written under a wrong predicate meanwhile.
- **Selected identities as persistent bitmaps.** `identity/id/<x>` derived like `device/id/*` would
  put frequently-queried identities straight into the `paths ∩ features ∩ filters` pipeline with no
  adjacency scan. Tradeoff is unbounded key cardinality — hence "selected" (pin/star), long tail
  stays on edges. Measure first; at ~1–2k contacts a bitmap per identity is likely the wrong call.
- **`rel/has/*` coarse bitmaps** — additive later, deliberately not built.
- **Multi-hop traversal** — one hop only in v3.
- **Predicate registry** is closed and append-only: `includes` 1, `references` 2, `derived-from` 3,
  `mentions` 4, `replies-to` 5, `depicts` 6, `authored-by` 7. Never renumber. `snapshot-of` was
  folded into `derived-from` (the predicate says where something came from; *what* it is lives on
  the target).

### Non-goals (explicitly out)

Version chains / same-path-new-checksum successor migration (the reconciliation design owns it);
MDB_DUPFIXED packing; token-string sugar for the `rel` bucket; any back-compat shim inside the DB.


## Doc-declared features — LANDED in v3

`features[]` is a root-level asserted array on the document; derived prefixes are stripped on the
way in, `data/dataset/*` is preserved across updates, and the schema-id unshift is gone. See
`README.md` and `tests/root-features.test.js`.

**The pre-prod migration validated the premise**: of 4,953 documents, **1,435 (29%) carried tags
that existed ONLY in bitmaps** with no doc-side record. Those were unrebuildable — a `rebuildL3()`
would have silently dropped a third of the tagging. The reverse scan recovered them onto the rows.


## Session support

The "Why"

**Conversational drill-down (REPL / the expansion UI you sketched).**  
In a user-session query:  
"car" → add "red" → add "near the market" → drop "red." *Why a session:* per-spec operand cache - each cue is resolved to a bitmap once, every refinement is just a re-AND, and removing a cue is free. Stateless re-resolves the whole conjunction on every keystroke; a 5-step refinement costs 5 resolves instead of 1+2+3+4+5.

**Agent working memory across turns (canvas-agentd).**  
Turn 1 commits `ctx:/work/dc-migration`, turn 3 adds `t:crud:updated:thisWeek`, turn 5 patches in a person. The session *is* the accumulated retrieval context you hand the LLM each turn - the agent mutates it in place instead of reconstructing the full spec every turn. *Bonus:* because the spec list is the only authoritative state, `serialize()` gives you durable agent working memory that survives a process restart for a few hundred bytes.

**A read-only stream that converges (camera at `/work`, `journalctl -u apache2 -f`).** Each frame or log line becomes a fading spec; the session holds the decaying accumulation of the last few seconds and emits related docs continuously. Continuity over a stream is intrinsically stateful - you're maintaining a running result, debounced and decayed, not answering one-shot questions. A burst of related apache errors *converges* on the right runbook instead of flickering one doc per line.

**A standing live view (invalidation).** Leave "everything about project-foo" open while ingestion runs; new foo docs appear the moment they land, no re-query, no polling. "Did the dc-migration reply arrive yet" flips empty→non-empty on ingest. *Why a session:* event-driven invalidation makes the open result a live view; stateless `query()` is a snapshot frozen at call time.

**Cheap probing, expensive only at commit.** Across a whole exploration the session answers `count()`, "is there anything," and "which cue narrows most" from the combined bitmap with zero document loads, and materializes actual docs exactly once, at "show me." *Why a session:* lazy materialization at *session* granularity - your 90%-without-the-doc goal at the interaction level. "Do we have new emails for foo" is a `count()`, never a fetch.

**Lens toggling and what-if branching.** Hold named specs as lenses - wikipedia / personal / work - and toggle one off without restating the rest, or fork the spec list to compare two refinements' overlap counts before committing. *Why a session:* cached operands plus an authoritative, forkable spec list make add/remove/branch nearly free.

And the honest counterweight: **a one-shot lookup - "find acme's latest invoice" - should stay a stateless `query()`.** There's no continuity to amortize, so the session is pure overhead. The abstraction earns its complexity only when there's continuity in the access pattern: iterative refinement, a stream, a standing live view, multi-turn agent context, or repeated cheap probing of one candidate set. If a use-case has none of those, it's a query, not a session.

A session pays off exactly when *the candidate set outlives a single question* 

Not on the table yet, but landing shortly: the focus shift to canvas-agentd needs durable per-turn retrieval context, which is exactly a session. Build the `resolveCandidates`/`rank` seam now so the session is a thin layer on top, not a rewrite.

### Session modes

The dividing line is whether real-time streaming is supported out of the box. Two cuts, same container:

- **Frozen-in-time (v1, default, easiest).** Relative timeframes resolve to absolute bounds at `add()` time and stay put; operands are pure cached bitmaps; invalidation is optional. This is agent working memory: `thisWeek` means the week the cue was added, and the session is a stable snapshot you keep handing the LLM.
- **Live / streaming (v2).** Operands re-resolve against the snapshot at query-run time; relative timeframes slide; this is where the invalidation path below earns its keep. Target optimizations beyond the raw API (dirty-key subscriptions, debounce, decay) so a stream converges instead of re-resolving the whole conjunction per event.

### Session container
- [ ] Keyed, ordered map `label -> querySpec` - the spec list is the ONLY authoritative state.
- [ ] Per-spec cached operand bitmap (from `resolveCandidates`) + a `dirty` flag.
- [ ] Combined result bitmap, recomputed lazily from operands.
      Default combinator: intersection across specs.
      (Optional flag: soft overlap - rank docs by how many specs they hit, a cheap bitmap sum. Ship hard-AND first.)

### Mutation (hydrate / drain / refine)
- [ ] `add(spec, label?) -> label`   (resolve operand, mark combined dirty)
- [ ] `remove(label)`                (drop operand, recombine)
- [ ] `patch(label, partialSpec)`    (re-resolve just that operand)
- [ ] `clear()`

### Read (lazy materialization)
- [ ] `count()` / `ids()` - from the combined bitmap, no doc load.
- [ ] `materialize(match?, {limit,offset,mode}) -> docs` - `rank` the combined survivors, then fetch docs.
      Ranking match is a materialize-time arg (default: most-recently-added spec's match).

### Invalidation (thin, live — streaming mode only)
- [ ] Each operand records the bitmap keys it touched (the `keys` from `resolveCandidates`).
- [ ] Precise invalidation only covers path/feature operands (stable keys). Temporal (BSI range), glob, and regexp operands have no stable key set: mark them coarse and re-resolve on read.
- [ ] Subscribe to existing write events; a write hitting a dependent key dirties that operand; recompute on next read.
      (v1 shortcut acceptable: dirty the whole session on any write + a manual `refresh()`.)

### Lifecycle (falls out of the authoritative-spec-list rule)
- [ ] `serialize()` -> spec list + labels + combinator (+ ttl). Tiny.
- [ ] `rehydrate(serialized)` -> rebuild operands lazily on first read.
- [ ] TTL governs residency, not identity: idle -> drop operands + unsubscribe, keep specs; rebuild on touch.

### Deliberately NOT in this cut (they slot onto the above unchanged)
- co-occurrence `suggest()` (reads combined bitmap + synapses)
- decay / streaming driver (a per-spec weight + a quantize→spec feeder)
- zoom aggregates / centroids on nodes
- anchor/quantizer operand sources (a spec's operand can later come from band-bitmaps instead of paths/features - the container doesn't change)


## TODO

### Enforce name-unique trees per workspace

Trees within a workspace must have unique `name`s (DB-level constraint on create/rename).
Today a workspace can hold two trees both named `context` (observed on `universe`:
ids `…XMXK` and `…QQSH`), so `name` cannot reliably address a tree — only `id` can.

**Why:** human-readable deep links. The webui addresses trees by name in the URL
(`/workspaces/:ws/trees/:treeName/path/...`) and the browser extension links by tree
*type name* (`directory`). Both break if names collide. Uniqueness lets `treeNameOrTreeId`
resolve a name unambiguously instead of falling back to id-only.

- [ ] Reject create/rename when a sibling tree in the same workspace shares the name.
- [ ] Migration: de-dup existing collisions (the stray second `universe` `context` tree).
- [ ] Keep `treeNameOrTreeId` resolution accepting both, but name now guaranteed unique.


### Support context and directory tree mountpoints

This feature stems from a requirement of Canvas to enable `Project` and `Task` abstractions on top of existing tree structures without the need to replicate whole subtrees "the standard way".

A project path `/projects/dc-migration` should not need to recreate exiting paths

```
/infra/dc/frankfurt
/infra/dc/sindelfingen
/devops/jira-1234
/reports/projects/2026/dc-migration
```

as its subtrees, we should just be able to mount those paths directly, creating

```
/projects/dc-migration/dc/frankfurt # whole /dc subtree mounted 
/projects/dc-migration/dc/sindelfingen # whole /dc subtree mounted 
/projects/dc-migration/tasks/jira-1234 # Standard context path, mount not necessary
/projects/dc-migration/reports # standard context path
```

While still allowing normal sub-tree paths to be created.
In general, we should support 2 types of mounts:

- Intra-workspace/tree
- External workspace or a subtree of an external workspace (descoped for now, this would be a mere link for the app to take care of)

We are leaking app abstractions into the db layer but having a layer type `project` and type `task` means, we get this "for free" from our JSON tree structures in one go, much easier to work with, esp given that we already support several layer types defined in `src/schemas/internal/layers`

Functional requirements:

- Mounts can not cross the tree-type boundary, context trees can only mount context trees, directory trees directory subtrees
- Tree mounts lock mounted tree paths, mounting `/infra/dc` into `/projects/dc-migration/dc` will lock `/infra/dc`, unmounting releases the lock; deleting a Project releases all locks its mounts held
- Mounted children resolve in origin context (no bitmap contribution) while its native children resolve normally
  - `/projects/dc-migration/foo` where foo is a standard context layer/canvas etc, does a logical AND of all 3 layers
  - `/projects/dc-migration/dc/frankfurt` where `dc` is a mountpoint to `/infra/dc` does a AND on `/infra/dc`, inserting(linking) data to `/projects/dc-migration/dc/frankfurt` ticks `/infra/dc/frankfurt`
- Creating a subtree `/projects/dc-migration/dc/frankfurt/foo` in a mounted path creates it in the source path `/infra/dc/frankfurt/foo` to keep things simple(tm) but not secure(tm), easy to forget that your agent bound to /infra/dc now also sees foo, in phase II we should definitely implement mount permissions
- Cycle prevention - Reachability check: cycle prevention is a reachability check at mount-creation time - reject a mount O→D if D is reachable from O in the mount graph; this guarantees the mount graph is a DAG - iow - when creating a mount from origin O into destination D, walk O's transitive mount-graph and confirm D (and D's mount-ancestors) are not reachable from O. If D is reachable from O, mounting O into D closes a loop - reject.
- Nested mounts: Allow with configurable depth cap (lets say 2 as the default)
- Synapsd must expose the origin path of any resolved node
- All project and task metadata(timelines, milestones, deadlines, dates) live as the app concern in the layers `metadata` object, db does not care here

--------------


### Generic

- [x] **`hasByChecksumString` silently drops its `features` arg** — **FIXED 2026-07-17.**
      Collapsed to `hasByChecksumString(checksum, spec = {})`. Blast radius verified nil: every
      live caller routes through `Workspace.hasByChecksumString`, which already passed a proper
      spec object as arg 2 (so those feature gates were honored all along). The broken 3-arg path
      was `ContextTree.has`/`ContextTree.hasByChecksumString` — themselves zero-caller wrappers
      that ALSO passed their `{tree, path}` selector unwrapped (so tree scope was dropped too);
      both DELETED. Regression test in query-and-membership.test.js asserts the gate filters.
- [] Ensure all batch methods are using the accompanied backend(LMDB/Lance) batch methods too whereever it makes sense
- [] Add backup/restore or dump/import functionality internally
- [] Add DB snapshot/restore option(on top of versioning? fetaures) to enable undo/redo ops || db op logs + traversal
LMDB copy/snapshot - mdb_copy (or the env .copy() API) gives a consistent point-in-time snapshot of the whole store without stopping writers. Wire it to a workspace.snapshot() that copies the data dir to a timestamped folder. Simplest possible "undo" net.

- [] Add proper support for Layer of type "label", this type of layer is not bound to a bitmap, hence not processed when supplied via contextSpec/contextArray
- [] Ensure locked layers can not be moved/removed/deleted/renamed
- [] Add a new "root" (universe) layer type, prevent all ops on the root layer, root "/" layer should always be locked
- [] Add support the following format option
  - Ids
  - metadata portion only 
  - full document

## Canonical V2 API leftovers

- [] Finalize canonical query object shape:
  - [ ] `filters.glob`
  - [ ] `filters.regexp`

## Membership Engine Extraction

- [ ] Extract shared document-target linking into one internal module/service.
- [ ] Support linking targets for:
  - [ ] context paths
  - [ ] directory paths
  - [ ] attributes
  - [ ] future document relations if needed
- [ ] Make trees translate path semantics into generic membership operations.
- [ ] Keep document-to-document relations out of tree APIs.

## Schema and Adapter Cleanup

- [ ] Reduce app-specific abstractions inside `synapsd`.
- [ ] Move source-specific normalization/mapping to app/workspace layer.
- [ ] Keep `synapsd` input shape generic and canonical.

### BaseDocument v3 — LANDED

`indexOptions` off the row (measured 414 B/row, 43% of a note; ~2.9 GB at 7M rows), root `features[]`,
top-level `kind`, `data.relations` excluded from whole-`data` projections via `contentData()`.
Resolution moved to a `static indexOptions` on the schema class rather than a registry lookup —
BaseDocument cannot import SchemaRegistry (the registry imports every schema, which import
BaseDocument), but `this.constructor.indexOptions` reaches the subclass with no import at all.
Per-document overrides are deliberately impossible: the field is not persisted, so an override would
apply on write and vanish on read.


### Schema simplification — PARTIALLY LANDED

Done in v3: `contact` → `identity` (with `data.kind` → `data.type`, `identities[]` → `identifiers[]`),
`bucket` deleted (folders are tree nodes), `event` added, `message` registered (it declared an id but
was never in the registry, so `getSchema()` threw while the parent chat service wrote that schema),
all core schemas at `schemaVersion 3.0` (which fixed `document` being stamped 2.0 while validating
against the 2.2 shape).

**Still open, and it belongs to the rename rev above**: `tab` and `link` are the same document with
different field names (`data.uri`/`data.label` vs `data.url`/`data.title`), and folding them means
touching `tab` (83 external hits) and `link`. `kind` already makes them queryable as one axis, which
is the point of doing the fold *after* consumers migrate.


### Schema registration facility — LANDED

`registerSchema(id, SchemaClass, {kind|kindField, kindPrefix, indexOptions})`, plus
`unregisterSchema`, `getSchemaEntry`, `resolveKind`. Three tiers: **core** (sealed against
re-registration), **app** (note/tab/link/dotfile, bundled but registered through the same public
path a third party would use, so the eventual move out is a deletion not a rewrite), **internal**
(tree layers). Enforced at registration: core ids are sealed, `kind` and `kindField` are mutually
exclusive, `kindField` REQUIRES `kindPrefix` (kind values are persisted in bitmap keys and therefore
append-only — an unprefixed generic value that later collides is not fixable without a migration),
and a supplied `indexOptions` writes the class static rather than a parallel registry copy.

Remaining gaps are in **Open: consumer-registered abstractions** above.


## Tests

- [ ] Add a proper test suite for the current API


## Optional

- [ ] BitmapIndex cache is an unbounded Map (every bitmap ever touched stays resident) - fine at KB sizes, needs a cap/eviction before wikipedia-scale ingest.
