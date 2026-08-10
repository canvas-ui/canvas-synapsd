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

## Apply a configurable layered mode view to returned documents
- Good for AR

## Proper synapse support + schema refactor

(partially implemented, needs to be extended)

### L0 "storage" centric
Resources, where the physical bits of the full objects are stored and can be retrieved from
data/resource/blob or file or url/uri? - points to a local or remote resource (immutable)
data/resource/reference - points to a external source(db, s3)

### L1 Semantics / L2 Relations — LANDED

Entity set and predicate registry both shipped. The entity list and its subtype shape now live in
"Open: schema hierarchy + `data/schema/*` rename"; the predicates are closed and append-only in
`src/indexes/edges/predicates.js` (7 of them, direction is an axis). One rejection worth keeping:
`installed-on` is NOT a predicate — device presence is answered by `device/id/*` bitmaps derived
from `locations[]`. Rule: edges are for document-to-document facts with no derivable location;
anything expressible as "these bytes live here" stays in `locations[]` and its derived bitmaps.

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

Shipped across 7 phases + 2b; `TODO.refactor-v3.md` deleted. `README.md` and the code are the
reference for what exists. Only OPEN items follow.


### Schema hierarchy + `data/schema/*` rename — LANDED IN FULL 2026-08-05

Rev A landed 2026-08-04, Rev B steps 1–5 landed 2026-08-04/05. What shipped in the final cut
(2026-08-05), beyond what the sections below already record:

- Ids are hierarchical `data/schema/*`; `schemaBitmapKeys()` ticks EVERY segment below the prefix
  (registered children like `message/email` AND derived subtype segments like
  `application/flatpak`), with tick/untick symmetry through the same expansion. This is ID-PATH
  ancestor ticking, NOT a reversal of v3's class-chain kill — each segment is a modelling decision
  in the id, never an accident of class reuse.
- **Registry lookup stays EXACT-MATCH** (decided 2026-08-05, reviewed): no `getSubschema()`, no
  last-segment fallback (an unknown subtype would silently construct as the parent).
  `getSchema()` throws on a derived key naming the real schema; `resolveSchemaId(key)` is the
  explicit bitmap-key -> registered-ancestor bridge. Enumerate schemas from `listSchemas()`,
  never from bitmap keys.
- **Email flags moved to `feature/email/*`** (decided 2026-08-05): under the hierarchy,
  `data/schema/message/email/sent` would read as a subtype. They are schema-declared derived
  facets now (`classDeclaredFeatureKeys` rides the facet plane), so flag changes untick and
  `rebuildL3()` reproduces them — both were broken before (tick-only, invisible to rebuild).
- **Task stays core; the `pointTimelines: ['tasks']` hardcode is declared legitimate** (decided
  2026-08-05). No schema-declared timeline mechanism until a second schema needs one.
- **No `message/chat` class** this round — the chat service keeps writing `data/schema/message`.
- Migration is `scripts/migrate-schema-v3.js` (schema version 3): raw row rewrite via exported
  `SCHEMA_ID_RENAMES`, plus the id-bearing CONFIG nothing would ever error about — canvas layer
  `querySpec.features` and workspace hook `rules.json` — then stamp LAST, reopen, `rebuildL3()`,
  FTS rebuild (the one owed since the object-flattening fix). Verified: idempotent second run,
  kill between row pass and stamp leaves the DB refused by the gate, not half-open.
- Consumers cut in the same release: browser-extensions, ui/shell, ui/cli, ui/fuse (incl. the
  `ends_with("todo")` write-path trap), ui/web (incl. the inlined anyOf/allOf prefix test),
  parent (incl. the splat rewrite of `routes/schemas.js`, `classifier.js` short-name map now
  carrying `email -> message/email` and `todo|task -> task`, webdav folder-from-last-segment).

Historical design notes follow, unedited where already marked landed.

Supersedes the earlier "`data/entity/*` rename" entry. Two revs: a local cleanup with no consumer
impact, then the cross-repo rename. **Do them in that order** — the cleanup produces the property
that makes the rename safe.

#### The shape

One hierarchical axis. `kind` as a separate namespace goes away; the schema id carries it:

```
data/schema/note                      note, no subtype
data/schema/application/flatpak       ticks .../application AND .../application/flatpak
data/schema/dotfile/folder
data/schema/message/email             Email keeps its OWN class, checksum and FTS fields
data/schema/message/chat
```

**Register-vs-derive — the rule that makes one namespace hold both cases:**

> Needs its own validation or identity -> **register** it as a schema id with a class.
> Just a discriminator on one class -> **leave it derived** from a field (`kindField`).

`application/flatpak` is derived (one `Application` class, one identity rule, discriminated by
`data.type`). `message/email` is registered (verified disjoint: Email checksums
`messageId + from.address + subject`, Message checksums `text + sender.id + channel.id + timestamp
+ platform`). Consumers query identically either way and never need to know which mechanism made
the key — which is exactly what `kindField` was invented to provide, now falling out of the id
shape instead of a second axis.

**The facet boundary:**

> The schema hierarchy is what a thing IS. Anything that cuts across entities is a FACET.

`platform` (slack/teams/irc/whatsapp) belongs in `facetFields: ['data.platform']` ->
`data/platform/slack`, NOT in the hierarchy — "everything from Slack" spans messages, files and
identities. Same reasoning retired `browser/*`: a synced tab behaves like a bookmark, so `browser`
was never an entity grouping, it was provenance/behaviour. Use a facet or `tag/*`.

#### Rev A — local cleanup — LANDED 2026-08-04

Shipped exactly as scoped; 352 tests green (350 before, +2 regressions below).

- ~~`kind` fallback~~ — **DROPPED 2026-08-03.** It existed to complete `data/kind/*` so consumers
  could migrate to it before the rename. `kind` is being removed entirely instead, so there is
  nothing to complete and Rev A has no prerequisite left to produce. Rev A is now pure cleanup and
  the two revs are independent (still do A first, it is smaller).
- [x] **Folder layout.** `schemas/abstractions/` is gone: 8 core schemas -> `schemas/core/`, the 4
      bundled app schemas (note, tab, link, dotfile) -> `schemas/app/`, `schemas/internal/`
      unchanged. The tier is now the FOLDER, so moving a bundled app schema out of this repo is a
      directory-level move rather than a hunt through one flat folder.
- [x] **`Document` is the base class**, `schemas/Document.js`; the `BaseDocument` name is gone
      repo-wide (src, tests, README). Most schema files already imported the base *as* `Document`,
      so this mostly deleted an alias.
      ⚠️ `abstractions/Document.js` was DELETED, not moved: it was a subclass that pinned the schema
      id/version the base already defaults to, restated the default `indexOptions`, and forwarded
      validate/validateData to `super` — no behaviour at all. `data/abstraction/document` now
      registers the base class itself (asserted in `schema-registry.test.js`). Base `fromData()`
      gained the schema-id default the subclass used to provide.
- ~~Internal-schema audit~~ **LEAVE AS-IS 2026-08-03 (user-verified).** The `internal/layers/*`
  schema IDS look unused (~1 hit each, the registry itself), but trees instantiate layers by TYPE
  NAME (`'canvas'`, `'context'`) — so the id count undercounts, and 2 of them are genuinely in use.
  Not worth pruning the rest for now. Do NOT delete on the id count alone.
- [x] **`data/backend/` added to `DERIVED_FEATURE_PREFIXES`** — legitimate since v3 made it derived
      from `locations[]`. Verified first that no consumer still asserts it (zero hits outside
      synapsd's own tests). Regression test in `backend-features.test.js` asserts an asserted
      `data/backend/*` is stripped AND does not survive a backend move (the negative half — an
      asserted copy was immune to the derivation's stale-diff, so it could never be unticked).
      **`data/no-location` deliberately NOT added**, still app-asserted.
- [x] **`schema` sealed in `ENGINE_OWNED_FACET_NAMESPACES`** — reserved AHEAD of the namespace
      existing, so nobody can squat `facetFields: ['data.schema']` and land inside the identity
      axis on the day Rev B ships. Covered in the existing engine-owned-namespace test.
- **Geo: leave as-is.** `GeoIndex.has(id)` already answers presence off the BSI existence bitmap;
  a `feature/has-geo` key would be a second source of truth for one fact, with its own lifecycle.
- [x] **`Todo` class renamed to `Task`** (user, 2026-08-04) — `schemas/core/Task.js`,
      `TODO_STATUSES` -> `TASK_STATUSES`. The class was already a task in everything but its name
      (RFC 5545 VTODO statuses, due dates deriving onto a timeline literally called `tasks`).
      ⚠️ The schema ID is STILL `data/abstraction/todo` — deliberately. The class name is local and
      free; the id is consumer-visible and moves to `data/schema/task` with every other id in Rev B.
      There is a comment at the constant saying so, because the mismatch looks like an oversight.
      No `Task` superclass with `Todo extends Task`: a todo has no field a task lacks, so it would
      be an empty subclass — see the Rev B note.
- [x] **`internal/layers/task` DELETED** (user, 2026-08-04): "I wanted to create layers of type task
      but realized it's not the correct design." Verified unused first, the way the audit note above
      demands — layer classes are resolved by TYPE NAME (`internal/layers/${type}`), so a grep for
      the id undercounts. Searched every repo for the type name too: the only hit anywhere was the
      registry line itself. The class was a no-op `extends Layer` carrying a copy-pasted (and wrong)
      "not tied to any bitmap" comment from `Label`. `internal/layers/project` is KEPT.
      Consequence, by design: creating a layer with `type: 'task'` now throws at `LayerIndex.js:217`
      instead of silently succeeding.

⚠️ One consumer edit was unavoidable despite "no consumer impact": the parent imported
`synapsd/src/schemas/abstractions/Email.js` directly (`core/workspace/services/imap/index.js`).
Repointed to `schemas/core/Email.js` in the same change. It is the ONLY deep import of a schema file
from outside synapsd — everything else goes through `SchemaRegistry`.

##### Inventory, re-measured 2026-08-04

The 2026-08-03 figure ("194 across 6 submodules") was close but miscounted the repo boundary. Actual:

| repo | occurrences | files | note |
|---|---|---|---|
| `ui/web` (submodule) | 46 | 14 | incl. `lib/schema-meta.ts`, `utils/url-params.ts`, renderers |
| `browser-extensions` (submodule) | 33 | 7 | |
| `ui/fuse` (submodule) | 25 | 5 | |
| `ui/cli` (submodule) | 20 | 11 | |
| `ui/shell` (submodule) | 6 | 1 | |
| canvas-server parent | 59 | 28 | **includes `services/embedd` (5) — that is NOT a submodule, it is in-tree** |
| `ui/desktop`, `services/neurald`, `services/stored` | 0 | 0 | nothing to do |

So it is **5 submodules + the parent**, not 6 submodules. Parent hot spots: `core/agent/files.js` 9
(an LLM tool prompt listing schema ids — prose, not code), `routes/contexts/dotfiles.js` 5,
`core/agent/tools/index.js` 5, `webdav/VirtualNamedContextFS.js` 4, `routes/schemas.js` 4,
`embedd/src/router.js` 4.

⚠️ **The public route is not a plain rename.** `routes/schemas.js:27,50` declares
`/data/abstraction/:abstraction` — a SINGLE path parameter. Under the hierarchy a schema id can be
two segments (`data/schema/message/email`), which `:abstraction` cannot match. The route needs a
wildcard/greedy param and the id reassembled from it, in both handlers (`.json` variant included).
Do not sweep this one with sed.

##### Suggested order (each step is independently verifiable)

1. ~~**synapsd, `kind` removal first, ids untouched.**~~ **DONE 2026-08-04** — see above.
2. **synapsd, ids + hierarchy.** Wire `resolveSubtype()` into the id (`data/schema/application` +
   `/flatpak`) — it exists and is tested precisely so this step wires up a function instead of
   writing one. This is where the subtype axis comes back on. Registry map, per-schema `DOCUMENT_SCHEMA_NAME` constants,
   `DERIVED_FEATURE_PREFIXES` (`data/abstraction/` -> `data/schema/`), `ENGINE_OWNED_FACET_NAMESPACES`
   (drop `abstraction`; `schema` is already sealed — Rev A; leave `kind` reserved), `DEVICE_SCHEMA_NAME`, semantic
   `embeddableSchemas` default, and the id strings in every test.
3. **synapsd, the v4 migration.** Schema version 3, same explicit opt-in gate as v2. Maps old id ->
   new id per row, rewrites `doc.schema`, then `#replayDerivedPlane`. Write the
   old->new map ONCE, as an exported constant, and let the consumers import it where they can.
4. **Consumers, one repo per commit**, parent last (it is the only one that can hold a stale
   submodule pointer). Then one release that bumps all pointers together.
5. **`reindexSearchIndex({rebuild:true})` on migrated DBs** — already owed independently (see
   post-v3 rough edges), and this is the natural moment.

### Open: multi-position timelines — blocks the wikipedia corpus

**The constraint.** A document occupies ONE position per timeline. The tier is a BSI keyed
`id -> a single value`, so a second `insert(name, id, …)` overwrites the first. Declaring two
entries for one timeline name now THROWS rather than silently keeping the last (which is how it
failed before, invisibly: the row kept every entry and `db.get()` re-rendered them all while the
index held one).

**Why it blocks wikipedia.** The import distils dates/periods per article with an LLM; an article
on ancient Egypt carries several ranges. Until this lands: one document per range, or a single
collapsed envelope per article (earliest start → latest end, losing interior precision). The ranges
live in `timelines[]` either way, so a later rebuild picks them up — an import done against the
workaround is not wasted.

#### ⚠️ Correction: the geo precedent is a BSI, NOT per-cell bitmaps

An earlier draft of this section proposed `internal/ts/<timeline>/cover/<scale>/<bucket>` roaring
bitmaps and called it "the GeoIndex pattern". That mischaracterises GeoIndex. It keeps **one BSI
over the full 64-bit S2 cell id** (`BitSlicedIndex('internal/geo/s2', …, 64)`), and its own comment
states why that works:

> every ancestor cell covers the contiguous `[rangeMin, rangeMax]` interval of its descendants, so
> "in cell X" at ANY level is a single BETWEEN — the bitmap population stays fixed at the slice
> width (~64 + ebm) regardless of data density or which levels queries use.

So the real S2 lesson is **encode the hierarchy into a sortable id space so containment becomes a
range query on one BSI** — not "a bitmap per cell". Read the correction before designing.

**It does not transfer wholesale**, and the reason is the whole problem: a geo point has ONE cell.
A time *range* is not a point, and an article has N of them. Putting hierarchical time-cell ids in a
BSI gives ms resolution for free (precision lives in the id, not in key count) — but it is exactly
the structure that exists today, and it keeps one-value-per-id. **Adding levels does not buy
multi-position, and multi-position is the requirement.**

#### The BSI stays regardless

`getSortKeys()` reconstructs each candidate's *value* by ANDing ~64 slices once — cost independent
of candidate count and corpus size. Its single caller is `rank()` (`index.js`, the `sortBy` path).
A membership structure answers "is it in this range"; it never answers "what is its timestamp".
Whatever lands for multi-position is an ADDITIONAL plane, not a replacement:

- **BSI = the value plane.** Exact timestamps, sort keys, histograms. Single-position by
  construction, which is correct — a document has one canonical time.
- **New structure = the multi-position membership plane.** "Which articles might overlap
  2686–2181 BC", cheaply, for a document with N ranges.

#### Three candidate shapes

1. **Coarse covering bitmaps + refinement.** Per-bucket roaring bitmaps at capped resolution; a
   range ticks the coarsest containing buckets plus boundary buckets. Multi-position is free.
   Key count is `timespan ÷ granularity`, so resolution MUST stay coarse — ms over a single year is
   ~3.15e10 keys, a non-starter. Precision comes from refining against `timelines[]` on the row.
2. **Occurrence-id indirection over the existing BSI.** Give each range a synthetic id, keep a
   `occurrenceId ↔ docId` map, translate query results back to doc ids before they meet the bitmap
   pipeline. Preserves the one-BSI property that makes geo cheap, and gives ms precision AND
   multi-position with no new index type. Cost: an id space, a translation step on every timeline
   query, and occurrence cleanup on delete. **Rejected earlier for adding an id space; with the geo
   precedent understood properly it is a live contender.**
3. **Hierarchical time-cell id in a BSI.** Elegant, and closest to geo — but see above: it does not
   solve multi-position, so it is only interesting combined with (2).

#### ⚠️ The real cost is engine complexity, not index size (user, 2026-08-03)

The S2 shape can be made to work for 1-D time in at least two ways **if resolution is capped at
hours or days**. But a capped-resolution membership index then forces one of:

- **filter on top of the candidate set** — fine, and consistent with the candidate-set-then-refine
  contract used everywhere else (geo coverings, `imageMaxDistance`, dangling edge targets); or
- **keep the current BSI for `crud:*`** (which genuinely needs finer resolution and is
  single-position by nature) — which means **two TYPES of timeline in the engine**, with different
  storage, different query paths and different capabilities.

That second option is the one to weigh carefully. The engine is already at the edge of what one
person holds in their head; a timeline type split is a permanent tax on every future change to the
temporal layer. Prefer a single mechanism with a refinement step over two mechanisms with none.

**⚠️ Still open, decide before building: boundary precision.** If an article says "Old Kingdom,
2686–2181 BC", must a query for exactly 2181 BC match, or is year-level overshoot acceptable? This
decides whether the membership plane needs boundary refinement or can stop at the containing
bucket — and it interacts directly with the capped-resolution question above.

#### Aside: render a BSI as a context tree (debug surface, NOT a design input)

A context tree is a hierarchy of bitmaps with roll-up semantics, which is structurally what a
temporal index looks like — so a BSI or covering index could be *rendered* as a tree and made
clickable, turning temporal density into something directly inspectable.

⚠️ To be explicit, because an earlier draft of this note implied otherwise: **the tree machinery is
NOT reusable for the temporal index.** Layers carry ULIDs, tree metadata and per-layer lifecycle
that a time bucket has no use for. This is a visualization idea for a rainy afternoon, not an input
to the multi-position design above.

#### Already supported — do not rebuild

Wipeable datasets (`deleteDataset(name, {dropDocuments})` + `data/dataset/*` provenance) and layered
zeitgeist queries (`RANGE_MODES` includes `layers`/`grouped`; `#queryIntervalLayers` returns
`{name: {scale: [ids]}}` per timeline), so `wikipedia,personal` against a birthdate works today.

#### Explicitly NOT this round

**Exponential-falloff dynamic timelines for agentic workloads** — high resolution around "now",
degrading with distance, so an agent's recent context is precise while deep history stays cheap.
Experimental, and may not belong in synapsd at all. Noted so it is not accidentally designed into
the multi-position work.


### Open: consumer-registered abstractions

Already works: a subclass declaring `static indexOptions` gets its own fts/vector/checksum fields
(JS static inheritance, resolved via `this.constructor` — no registry import, no cycle); one
declaring none inherits its parent's; base mandatory fields stay enforced; `registerSchema()`
accepts it. `kindField`/`kindPrefix`/`facetFields`/`mergeOnDedupe` are all schema-declared.

Three gaps (0 is half-fixed, 1 is done):

0. **Nothing worth fetching is exported — so consumers COPY schemas (user, 2026-08-04).** The
   intent of a registry is that consumers fetch a schema and hand it to *their* consumers. Today
   they cannot, and the web ui duplicating the todo status enum
   (`ui/web/.../useTodoFields.ts`, comment: "Mirrors synapsd Todo.js STATUS") is the symptom, not
   the disease. Two concrete defects, both measured 2026-08-04:
   - [x] ~~**`static jsonSchema` is an example stub, not a JSON Schema.**~~ **FIXED 2026-08-04.**
     It was `{ schema, data: { title: 'string' } }` — no enums, required/optional, ranges or
     nesting — while every one of those facts sat in the zod `dataSchema`, unexported.
     `jsonSchema` is now DERIVED: `Document.jsonSchema` runs `zod-to-json-schema` over
     `this.dataSchema` (so each subclass converts its own, via static inheritance) and memoizes per
     class in a WeakMap; all **12** hand-written statics are deleted, and a test asserts no subclass
     owns the property so a stub cannot come back. `getJsonSchema()` stamps `$id` in the REGISTRY,
     which is what knows the id<->class mapping. Layer types return `null` instead of throwing.
     `zod-to-json-schema` promoted from transitive to a declared dependency.
     Verified end to end: `data/abstraction/todo` now publishes the four statuses as an enum,
     `priority` as `{integer, 1..9}` and `required: ['title']`.
   - **`GET /data/abstraction/:abstraction` returns a CLASS.** `routes/schemas.js:39` sends
     `schemaRegistry.getSchema(id)` — a constructor, which JSON-serializes to `{}` — and reports
     `schemas.length`, i.e. the constructor's ARITY, as the result count. This endpoint has never
     returned anything a consumer could use. It should serve the registration record (id, tier,
     subtype axis, indexOptions field lists) or the derived JSON Schema, not the class.
   Sequencing: the derivation is DONE, and the ROUTE HALF LANDED 2026-08-05 with Rev B —
   `GET /schemas/data/schema/*` (Fastify splat) serves `getSchemaDescriptor()` for the bare id
   and `getJsonSchema()` for `<id>.json`; derived subtype keys resolve to their parent
   descriptor instead of 404ing. **Still open (deliberate, user 2026-08-05): the consumer
   half** — point the web ui at `…/….json` and delete its copied enums (`useTodoFields.ts`
   status enum + `lib/todo.ts` styles). Kept out of the cutover to keep it mechanical; the
   endpoint it needs now exists.

1. [x] ~~**No parent-aware data-schema helper.**~~ **DONE 2026-08-04.**
   `Document.mergeDataSchema(super.dataSchema, extraShape)` merges the parent's `data` shape with
   the subclass's own, so `class Phone extends Device` validates `deviceId`/`name` AND `imei`.
   Added as a SEPARATE helper exactly as this entry warned — `Document.dataSchema.shape.data` is a
   `z.record`, so making `extendDataSchema()` merge would have changed behaviour for every current
   caller; the record case simply contributes no named fields.
   Two things the original note did not anticipate, both handled and tested:
   - **The parent must be passed IN, as `super.dataSchema`.** The first cut resolved it internally
     via `Object.getPrototypeOf(this).dataSchema` — reading `this.dataSchema` recurses forever,
     since the caller IS the subclass's own getter. That worked but was fragile and ugly (user,
     2026-08-04). `super` is a language primitive for "the class I extend", bound lexically, so the
     helper became a PURE function: no `this`, no prototype walk, nothing to rebind, and a class
     with no superclass cannot express the call at all — one less error branch to guard.
   - `Application.dataSchema` is a **`ZodEffects`** (`.refine()`), which has no introspectable
     shape. Rebuilding the object around it would SILENTLY DROP the cross-field rule, leaving a
     subclass with weaker validation than its parent — so it throws instead.
   `tests/merge-data-schema.test.js` (8 cases).
2. **No registration ROUTE.** Registration is in-process JS only. Its own rev — an API design
   problem more than an engine one: a class cannot be transmitted over HTTP, so it needs a
   declarative descriptor compiled server-side into a zod schema + index options. Open questions:
   persistence across restarts, per-user vs per-workspace scoping, and the sharp one — **what
   happens to stored documents when a consumer re-registers a schema with different
   `checksumFields`**, since that silently changes document identity.

⚠️ Not to be confused with the superseded "schema inheritance" decision. What v3 killed is *bitmap
ancestor-chain ticking* (a tab ticking `data/abstraction/link` so "all links finds tabs"); `kind`
replaced that. CLASS extension for validation and index-option inheritance is alive and wanted.

### Open: `src/index.js` is ~5.7k lines / 181 methods

Measured 2026-08-03. Not a stylistic complaint — it is the file every change to this engine has to
be made in, and it is past the point where one person holds it in their head. v3 added ~800 lines to
it, so this is partly self-inflicted.

Where the lines actually are:

| group | methods | ~lines |
|---|---|---|
| query/read (`resolveCandidates`, `#resolveParsed`, `rank`, `list`, `query`, `search`, combiners) | 27 | 1009 |
| write paths (`put`, `putMany`, `#putOne`, `#updateOne`, `#deleteOne`, …) | 11 | 999 |
| migration / reindex / rebuild | 11 | 445 |
| trees & layers | 23 | 405 |
| membership & bitmap derivation | 13 | 349 |
| vectors / semantic / lance wiring | 11 | 266 |
| everything else (link/unlink, accessors, helpers, module-level pure functions) | 85 | ~2114 |

Biggest single methods: `putMany` (317), `#resolveParsed` (154), `start` (148), `unlinkMany` (143),
`deleteMany` (142), `constructor` (142).

**Extraction order, cheapest and safest first:**

1. ~~**Migration / reindex / rebuild (~445).**~~ **Half of this evaporated 2026-08-04** — the
   migration code was DELETED rather than extracted (see below), taking ~330 lines with it. What is
   left in this group is `rebuildL3` + `#replayDerivedPlane` + the four `reindex*` methods, which
   are live maintenance APIs rather than one-time code. Still the cheapest extraction, just smaller.
2. **Module-level pure derivation helpers (~200 of "everything else").** `mimeBitmapKeys`,
   `facetFieldKeys`, `documentFeatureKeys`, `documentRelations`, `validateDocumentRelations`,
   `mergeDedupePreservedFields` — no `this`, trivially testable in isolation, currently sitting
   above the class for no reason. (`kindBitmapKeys`, `stampDerivedKind` and `envFlag` are gone.)
3. **Membership & location-derived features (~349).** Already concentrated
   (`#deviceFeaturesFromLocations`, `#backendFeaturesFromLocations`, `#locationDerivedFeatures`,
   `#removeStaleLocationMembership`, `#applyMembership`).
4. **Trees & layers (~405).** Mostly delegation to the tree classes already.
5. **Query/read (~1009).** Biggest win, highest risk — `#resolveParsed` is the core of the engine
   and every read path funnels through it. Do it last, and only with the query suites green.

Do NOT attempt this as one commit. The reason `index.js` is safe to touch at all right now is that
all four write paths funnel through `#applyMembership` and all reads through `#resolveParsed`;
an extraction that blurs those two choke points costs more than the line count does.


### Migrations: removed from the engine — DONE 2026-08-04

**Decision (user):** no back-compat, and one-time migration code does not live in the codebase.
Write a script when a migration is actually needed.

**KEPT, deliberately:**

- **The version GATE.** `SCHEMA_VERSION` + the refusal at `start()`, ~15 lines. Deleting the check
  would not make a stale database someone else's problem, it would make it SILENT DATA LOSS: current
  code reading a pre-v2 row never promotes `metadata.features`, so asserted tags existing only in
  bitmaps — the one class of state with no rebuild source — vanish on the next write with no error.
  A non-empty DB below `SCHEMA_VERSION` now throws and says to migrate with a one-off script; an
  empty one is stamped. Covered by `tests/schema-version-gate.test.js`.
- **`rebuildL3()` / `#replayDerivedPlane` / the `reindex*` methods.** Not migration — the executable
  derived-plane invariant and the live repair path. `tests/rebuild-l3.test.js` carries the invariant
  test rescued from the deleted migration suite, reseeded through the normal write path.
- **`migrateDocumentMemberships()` / `migrateBitmapKey()`.** Live APIs that happen to say "migrate".
- **Parent `001-per-user-indexes`** moved to `scripts/migrate-001-per-user-indexes.js` with a CLI
  entry (`--db` / `--users`), still exporting `runPerUserIndexMigration` so its existing test drives
  it unchanged. Marker-guarded and idempotent, as before.

⚠️ **The rule going forward:** a migration is a script in `scripts/`, run by hand against a backup,
and it stamps the version key when done. If a change makes old rows unreadable, bump
`SCHEMA_VERSION` — the gate turns that into a loud refusal instead of a corrupt database.

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
- **`rebuildL3()` is a single-document loop — MEASURED 2026-08-05, needs batching before wikipedia.**
  Per-document `put` rather than one batched transaction. Fine at ~5k (pre-prod: 4953 docs,
  instant). On the 1.2M-row `test` workspace (all `data/schema/file`, filesystem-import shape) the
  bitmap replay ran **>60 minutes without finishing** and was killed; rows+stamp were already done
  (the migration script does its own batched row pass in 2000-row transactions — ~2 min for the same
  1.2M rows, which is the shape the replay wants). Nice-to-have: batch `#replayDerivedPlane` —
  accumulate per-bitmap tick sets across a chunk of docs and apply per bitmap, instead of
  per-doc `#applyMembership` round-trips. That `test` workspace still owes a
  `rebuildL3({bitmaps,edges})` + `reindexSearchIndex({rebuild:true})` when someone next cares
  about it.
- **`reindexSearchIndex({rebuild:true})` is owed on migrated databases.** The FTS fix (objects were
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


## Session support

**CONTAINER LANDED (pre-2026-08):** `src/session/QuerySession.js` via `db.openSession(specs, opts)`
implements everything the checklist below asked for, plus more: modes `frozen|live`, emit
`delta|ids|page`, `add/remove/patch/clear`, **`set(label, spec)` replace-mode upsert** (for
streaming producers — patch() concats arrays by design), the **`ids` spec bucket** (literal
id-set operand: no collection keys, never coarse, zero invalidation cost), `count/ids/
materialize`, precise `membership.changed` key-touch invalidation with coarse re-resolve for
temporal/geo/rel operands, debounced recompute, `serialize()/rehydrate()`. Tests:
`tests/query-session.test.js`. The checklist below is retained for the record.

### NEXT: session transport + delta-driven UI (planned 2026-08-10, separate session)

**The problem observed:** Lens live-mode (camera feed / shared content) in the webui refetches
and re-renders the whole document list per tick — the UI "blinks". Root cause: sessions are
IN-PROCESS ONLY. The web toolbox writes filter state → the page re-runs a stateless
`GET /documents` → full list swap. Nothing surfaces QuerySession's `{added, removed, count}`
deltas to a client, so every consumer above synapsd is stuck in snapshot-refetch mode.

**Division of labor (synapsd is nearly done here — this is mostly canvas-server + webui):**

1. **canvas-server: session RPC over the existing socket.io transport** (channels today are
   event fan-out only; no search RPC exists).
   - `session.open { workspace, specs[], opts {mode, emit, debounceMs} } -> { sessionId, ids }`
   - `session.set / session.patch / session.remove { sessionId, label, spec }` — thin passthrough
     to the QuerySession methods (set() is the streaming verb: lens ids, sliding windows).
   - `session.close { sessionId }`; server ALSO closes on socket disconnect after a grace TTL —
     `serialize()` makes park/rehydrate cheap if reconnect-with-state is wanted later (PWA).
   - Server → client: `session.delta { sessionId, added[], removed[], count }` (emit:'delta').
   - Auth/scoping: session bound to (user, workspace) at open; reuse socket auth. A registry
     (sessionId → QuerySession) lives in canvas-server (synapsd stays a library); enforce a
     per-connection session cap.
   - Materialization stays PULL: deltas carry ids only; the client hydrates added ids via the
     existing `GET /documents?ids=…` (the Slice B½ ids param) — only NEW docs are ever fetched.
2. **webui: a `useQuerySession` hook + incremental list.**
   - Hook: open on mount / close on unmount, maintain `Map<id, doc>` + ordered id list; on delta
     fetch ONLY `added` ids, drop `removed`; stable keys → React reconciles instead of remounting;
     no loading-state flash (keep-previous-while-updating).
   - Lens live mode becomes: frame → `search/image (idsOnly)` (unchanged) → `session.set('lens',
     { ids })` over WS → delta → incremental render. The toolbox `filters.lens.ids` refetch path
     stays as the fallback when no socket is available.
   - Later (sensord): the frame loop moves server-side and patches the SAME session — the client
     contract (deltas in, cue ops out) does not change. This transport IS the sensord consumer
     surface, so design the message shapes with that in mind.
3. **Independent quick mitigation (webui-only, can ship immediately):** even without sessions,
   the Lens refetch path should keep previous results while fetching + render with stable keys +
   only replace state when the id set actually changed (set-equality check) — kills the blink,
   not the redundant fetch.
4. **synapsd (small, optional):**
   - [ ] session-wide `andNot(internal/gc/deleted)` in `#combine()` (parked from Slice B½: an
         id-set cue has no keys, so deletes never dirty it).
   - [ ] `materialize()` already exists for emit:'page' consumers; nothing else blocking.

**Non-goals for round 1:** multi-workspace sessions, session sharing between users,
server-side lens frame processing (that's sensord), soft/weighted combinators.

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

- [x] Reject create/rename when a sibling shares the name — DONE, `createTree`/`renameTree` both
      throw `Tree already exists`.
- [ ] **Still open:** migration to de-dup collisions created BEFORE the guard (the stray second
      `universe` `context` tree). New collisions cannot happen; old ones persist.


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
- [] **Threshold-gated LMDB compaction on start** (discussed 2026-08-05, after the v3 migration
  grew the test DB's data.mdb 1.86G -> 3.36G in copy-on-write pages). NOT unconditional — LMDB
  reuses freed pages, so steady-state DBs gain nothing from a full-file copy on every open, and
  workspace DBs open lazily (an unconditional compact turns first access after a deploy into a
  stall). Gate on reclaimable bytes from env stats (e.g. >25% of file AND >=128MB), and reuse the
  `backupOnOpen` machinery: it ALREADY produces a compacted copy on open and then archives it while
  the server keeps running on the bloated file — swap the compacted copy in as the live file and
  keep the old file as that generation's backup. One copy pass, both outcomes. Sequence lives in
  `backends/lmdb/index.js`: open -> stat -> copy-compact -> close -> atomic rename -> reopen.
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

## Optional

- [ ] BitmapIndex cache is an unbounded Map (every bitmap ever touched stays resident) - fine at KB sizes, needs a cap/eviction before wikipedia-scale ingest.
