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
data/resource/referene - points to a external source(db, s3)

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
data/relation/references
data/relation/authored-by
data/relation/mentions
data/relation/replies-to
data/relation/generated-from
data/relation/executed-on
data/relation/installed-on

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

## Refactor v3

Do the simplest thing that works; aim to delete more than you add.

! Do NOT use `bitmapIndex.untickAll` (`indexes/bitmaps/index.js:415`): O(all-bitmaps) per delete, that's why it's dead. The bitmap side is already cleaned precisely and cheaply by `clearSynapses` (`indexes/inverted/Synapses.js:144`) via the reverse index. Leave `untickAll` dead.


### Target surface

```
// Public read surface = list() + query(). Nothing else. (get(id) is trivial, not shown.)
list(spec?)              // == query(null, spec); kept for back-compat + simple UX, no match
query(match, spec?)      // match: string | { text?, image? }

// Writes
put(document, spec?)     // spec: { paths, features } -- no filters, no match
putMany(documents, spec?)
link(idOrIds, spec)      // spec: { paths, features }

// recall (anchor planning) + search: folded into the Session feature, not this cut.

spec = {
  paths:    ['ctx:/a/b', '!dir:/staging'],                       // or { in, not }
  features: ['+tag/red', 'data/abstraction/file', '!tag/spam'],  // or { allOf, anyOf, noneOf }
  filters:  ['+t:crud:updated:thisWeek', 't:wikipedia:1996', 't:personal:1996', 'g:*.pdf', 're:^foo'],
  mode: 'fts|vector|hybrid', limit, offset, parse, groupBy,      // flat; groupBy:'timeline' buckets the result
}
```

Buckets intersect (paths AND features AND filters AND match); items within a bucket union. Per item: default is `anyOf` (OR), `+` promotes to required (`allOf`), `!` excludes (`noneOf`). Pipeline order is fixed: tree-path bitmaps, then feature bitmaps, then filters (BSI timelines, glob, regexp), then semantic (vector) on the surviving subset only.

### API consolidation
- [ ] Filter prefix registry (`t:` temporal, `g:` glob, `re:` regexp) with the same sigil algebra as paths/features; see "Filter grammar" below. *(`t:` shipped; `g:`/`re:` parse-time throw, deferred to db schema refactor.)*

### Filter grammar (`t:` temporal, `g:` glob, `re:` regexp)

Surface is uniform `t:<name>:<spec>`; the parser splits internally. Sigil algebra matches paths/features: default `anyOf` (OR), `+` = `allOf` (required gate), `!` = `noneOf` (exclude). The hard part already exists: `TimelineIndex.queryInterval` (indexes/inverted/Timeline.js:188) takes a name array and unions, auto-detects scale (`'1996'` -> year, Timeline.js:482), and has a per-timeline `mode:'layers'` (Timeline.js:349). Arbitrary content timelines are already indexed per-document (`timelines:[{name,start,end}]`, index.js:3004); `crud:*` are reserved auto-managed ones.

Spec forms:
- Content point: `t:wikipedia:1996`
- Content range: `t:wikipedia:1996..1999` (`..`, since `:` is the segment delimiter); relative ages parse too (`t:geology:541mya..252mya`)
- Lifecycle (reserved `crud`): `t:crud:<action>:<timeframe|range>`, e.g. `t:crud:updated:thisWeek`. ~~Named timeframes stay crud-only~~ *(revised 2026-07-13: named timeframes resolve on ANY timeline — `t:tasks:today` = "due today"; deep-time axes simply never match them.)*

Overlay = multiple anyOf `t:` items, canonical form is one line per timeline (composes when ranges differ):

```
filters: ['+t:crud:updated:thisWeek', 't:wikipedia:1996', 't:personal:1996']
// => crud:updated in thisWeek  AND  (wikipedia ~ 1996  OR  personal ~ 1996)
```

- [ ] `t:`/`g:`/`re:` prefix dispatch in `parseFilters` (replaces the `datetime:`-only check, filters.js:18); timeline name comes from the token, drop the hardcoded `crud:${action}` (filters.js:103). Today `filters` object only knows `timeline` -> `datetime:updated:<v>` (index.js:3196). *(`t:` shipped; `g:`/`re:` deferred to db schema refactor.)*
- [ ] **Sigil asymmetry on raw bitmap-key filters** (found 2026-07-13): `t:`/`geo:` tokens get
      the full sigil algebra via `splitSigil`, but raw keys pass through verbatim to
      `bitmapIndex.AND`. Current actual behavior: `!key` WORKS (AND splits negatives and
      subtracts; negative-only starts from the full id range — original scope honored), but
      `+key` was recognized by NO layer — the leading `+` survived `normalizeBitmapKey` into the
      key itself and the filter silently matched nothing. *Cheap fix SHIPPED 2026-07-13:
      parseFilters now pushes the sigil-stripped body for raw keys ('+' → AND default no-op,
      '!' re-prefixed for the downstream negative split); regression test in
      todo-tasks.test.js.* Fix proper in
      the refactor-v3 grammar pass: uniform sigil algebra for raw keys too (default anyOf-OR
      within the bucket? — decide; today raw keys AND while t:/geo: default to anyOf, which is
      itself an inconsistency worth resolving in one sweep).
- [x] Sigil-aware filter combiner: partition `t:` items into allOf/anyOf/noneOf, resolve each via `queryInterval`, combine `AND(allOf) ∩ OR(anyOf) \ OR(noneOf)`. Replaces the "AND everything" filter loop in `list`/`search` (index.js:1742, index.js:1905).
- [ ] `groupBy: 'timeline'` result option: union still drives retrieval, response is bucketed per timeline (`{ wikipedia:[...], personal:[...] }`) via `queryInterval` `mode:'layers'`.

### Vectors & modalities

We are moving towards a separate embedding provider based on `https://github.com/StarlightSearch/EmbedAnything`, It should be possible to seamlessly add new embedding models per modality + fine-tune their settings, revert back to a previous model or remove all vectors for a superseeded model.

This item relates to the "## Refactor `embedd` (coupled to the workspace runtime)" from `TODO.md` in the root of canvas-server (the main repo)

- [ ] Multimodal vector search: text + image now, (streaming) video/audio. Carry `match` as `{ text?, image? }` end-to-end.
- [ ] External embedding connectors besides local ONNX (ollama, openai, anthropic) behind one provider interface, maybe we should completely remove ONNX from synapsd and solely rely on an external provider but this is up for a discussion first

#### Vector provenance + per-(model,dim) spaces — **NEEDED SOON** (qwen VL / matryoshka tests)

Not cosmetics. Blocks the upcoming qwen-VL / Matryoshka (MRL) embedding tests (user, 2026-07-15).

**⚠️ LANDMINE — DEFUSED 2026-07-17.** ~~a dim mismatch SILENTLY DROPS THE TABLE~~
`VectorIndex.initialize()` now refuses loudly (`console.warn`) instead of dropping when the
on-disk `vector` width != configured `#dim` AND the table is non-empty: data stays on disk, the
space goes offline, `stats()` reports the mismatch. An EMPTY table under a mismatch still
recreates (that path is safe and keeps the original vec_image 512→768 self-heal). Tests:
`tests/vector-provenance.test.js`.

~~**The row carries no provenance.**~~ **SHIPPED 2026-07-17**: rows now carry `model`, `dim`,
`embeddedAt`; legacy tables are backfilled on open via `addColumns` (legacy rows get `model:''`
= honestly unknown). embedd ships `rule.model` with every `storeVectors` push, so provenance is
stamped end-to-end. "Re-embed everything vectorized with X" is now a Lance query.

- [x] **Key the Lance table by `(space, model, dim)`** — SHIPPED 2026-07-17, opt-in per space:
      a space config that declares `model` gets `vec_<space>__<model-slug>__<dim>`
      (`#vectorTableName`, index.js); MRL truncations become sibling tables for free. Model-less
      legacy spaces keep their fixed `cfg.table` names (`vec_text`/`vec_image`) so existing data
      stays attached — zero migration. For the qwen-VL / MRL tests: add the space WITH a model
      name and the keying (plus the non-destructive guard) makes clobbering impossible.
      Follow-up for the embedd runtime split: derive synapsd space configs (incl. `model`) from
      the embedd router rules so the keying becomes the default rather than opt-in.
- [x] **Add `model`, `dim`, `embeddedAt` columns to the row** — SHIPPED 2026-07-17 (see above).
- [x] **Make the dim guard loud and non-destructive** — SHIPPED 2026-07-17 (see above).
- [x] **MRL note — DECIDED 2026-07-17: embedd, at write.** A truncated Matryoshka vector must be
      **re-normalized (L2)** before cosine/dot, or similarity is silently wrong. embedd owns it
      because truncation-awareness is model semantics (synapsd disclaims those, index.js:263),
      write-side normalization happens once instead of on every query, and stored vectors stay
      valid for any future consumer. Applies to both document vectors and `embedQuery` outputs.
      Implement in the EmbedAnything/provider layer when the MRL test spaces land.
- [x] Cross-check `#semanticConfig.dim` — verified 2026-07-17: it is only (a) the fallback dim for
      the default text space when no `spaces` override is passed and (b) reported in `getStats()`.
      Per-space `cfg.dim` is authoritative everywhere else. Safe as-is; retire the global when
      space configs start coming from the embedd router.


----------

### Examples

Simple: text match scoped to a context subtree, gated by one timeline.

```
query('red ferrari', {
  paths:   ['ctx:/cars'],
  filters: ['t:crud:created:thisWeek'],
})
```

Full: hybrid text + image match, scoped and feature-filtered, with a multi-timeline overlay and a per-timeline grouped result.

```
query(
  {
    text:  'opening ceremony',
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...'   // base64 data URL
  },
  {
    paths:    ['ctx:/media/olympics', 'dir:/','!dir:/staging'],
    features: ['data/abstraction/file', 'data/source/wikipedia', '!tag/nsfw'],
    filters: [
      '+t:crud:updated:thisWeek',   // gate (allOf): indexed this week
      't:wikipedia:1996',           // content coordinate
      't:personal:1996',            // overlaid personal-life entries (anyOf with wikipedia)
      'g:*.jpg',
    ],
    mode:    'hybrid',
    limit:   50,
    groupBy: 'timeline',            // result bucketed: { wikipedia:[...], personal:[...] }
  },
)
// => paths ∩ features ∩ crud:updated∈thisWeek ∩ (wikipedia~1996 ∪ personal~1996) ∩ g:*.jpg,
//    then hybrid text+image ranking on the survivors.
```

### Perf & storage
- [x] Audit `#buildAllDocumentsBitmap()` callers: done (verified 2026-07-17). All callers now gate on the positive set and only full-scan when the query is genuinely unconstrained (noneOf-only, no positive filters). `excludeTree`/`excludeContext` are gone (replaced by `paths.not` selectors). Optional follow-up: maintain a persistent all-docs bitmap to kill the remaining unconstrained-path scan.
- [ ] Lift `indexOptions` (esp. `embeddingOptions`) out of per-document `toJSON()` to schema level: GBs of identical config across 7M rows. *(deferred: per-abstraction config, not per-doc storage; needs design + back-compat sign-off.)*

## Doc-declared features (`features: []` on the document)

**Decision (2026-07-13): do it — fold into the schema refactor rev, not standalone.**

Custom features (`tag/*`, `custom/*`) are the last membership state that exists ONLY in
bitmaps — i.e. the last state with no rebuild source if a bitmap corrupts. Everything else
already follows "the document declares, the index derives": `doc.timelines[]` → timeline BSIs,
`metadata.contentType` → mime bitmaps, `hasComment` → `feature/has-comment`, `locations[]` →
`device/*`. A root-level `features: []` completes the pattern: doc = source of truth, feature
bitmaps = derived cache, full reindex-from-docs becomes possible engine-wide. Bonus: synced doc
JSON is self-contained (offline clients see tags without bitmap access, see client-spec), and
per-doc attribute reads stop being a reverse scan over the whole feature vocabulary
(O(keys × page) today, free once in the doc).

**Prefix classification (REVIEWED 2026-07-15 — every row verified against writers; ✅ = confirmed, ⚠️ = corrected):**

| Prefix | Class | Verdict | Review finding |
|---|---|---|---|
| `tag/` | user-asserted | → `doc.features` (the whole point) | ✅ Sole mapper `ui/web/.../add/tags.ts` (`tagsToFeatures`/`featuresToTags`); asserted by web add/edit forms, CLI (`tagsToFeatures`), extension (`tag/<browserIdentity>`). ⚠️ Also written DERIVED by `core/workspace/services/linker/index.js:115` (`tag/context:<contextId>`) — a derived key squatting in the asserted namespace. Fix during the move. |
| `custom/` | user-asserted | → `doc.features` | ⚠️ Only writer left is the browser extension (`tab-manager.js:169`, `custom/tag/${syncTagFilter}`) — the "consolidate `custom/tag/*` → `tag/*`" item below is marked DONE but only covered server/CLI writers. **Extension still writes `custom/tag/*`.** Either finish it or reopen. |
| `data/abstraction/*` | derived from `doc.schema` | stays computed, NEVER in `features[]` | ⚠️ **Already violated today**: `BaseDocument.js:212-213` unconditionally unshifts `this.schema` into `metadata.features` on every construct, so every persisted doc carries it. Triple-redundant: client sends it too, and `#putOne` re-adds it. When `features[]` moves to root, do NOT carry the schema into it — and drop the unshift. |
| `data/mime/*` | derived from `metadata.contentType` | stays computed | ✅ `mimeBitmapKeys` (index.js:80). |
| `data/backend/*` | derivable from `locations[]` | stays computed? verify all writers | ✅ Verified: only `WorkspaceStoredIndex.#buildFeatures` (:1075) + constants (:31,:36) and imap (`data/backend/imap/<account>`). Bitmap-only. |
| `data/source/*` | stamped at ingest, NOT derivable from doc | → `doc.features`? or `metadata`? decide | ⚠️ **Decide:** exactly ONE writer — `WorkspaceStoredIndex.js:1076`, `data/source/${backend.source.provider}`, derived from the *backend descriptor*, not the doc → today genuinely NOT rebuildable from doc state (breaks the reindex-from-docs property this whole refactor is for). **Recommendation:** carry the provider in `locations[].metadata.provider` and derive like `data/backend/*` — keeps it computed and rebuildable. Putting it in `features[]` would make an ingest-derived fact look user-asserted. |
| `feature/*` | derived (has-comment, …) | stays computed | ✅ Exactly one key: `feature/has-comment`. |
| `device/*` | derived from `locations[]` | stays computed | ✅ Two derivers, both fine: `#deviceFeaturesFromLocations` (index.js:3918, `file://` authority) and `buildDeviceFeatureTags` (utils/device-features.js:31, from `request.client`). `stripDeviceFeatureTags` prevents client spoofing. Bitmap-only — never merged onto the doc. **Do NOT move to `features[]`**: `#removeStaleDeviceMembership` owns their lifecycle and would fight a doc-declared copy. |
| `client/` | insert-time provenance, asserted by client | → `features[]` as provenance tags | ✅ Asserted only (extension `client/app/*`, CLI `client/app/canvas-cli`); no server deriver. ⚠️ `Context.js #clientContextArray` is **query-side only** (`#buildMergedContextArray` → selector); it never touches a write path — so the TODO's justification for this row was wrong even though the verdict holds. |
| `server/` | — | (was: → `features[]`) | ⚠️ **DEAD.** No bitmap key with this prefix is ever created. The only `server/` producer is `getSyntheticServerDeviceId` (transports/auth/strategies.js:99), whose value is used as a *deviceId* → surfaces as `device/id/server/<host>`. Drop from ALLOWED_BITMAP_PREFIXES. |
| `user/` | — | (was: → `features[]`) | ⚠️ **DEAD.** Zero references repo-wide outside the prefix list itself. Drop from ALLOWED_BITMAP_PREFIXES. |
| `nested/` | DEAD | drop from ALLOWED_BITMAP_PREFIXES | ✅ Confirmed dead. Only keys.js:14 + a defensive `EXCLUDED_BITMAP_PREFIXES` entry in `ui/web/.../services/workspace.ts:1170` (filtering a class that never exists). Drop both. |
| `context/`, `vfs/` | view membership | bitmap-only, NEVER in doc | ✅ Correct — and see the `contextUUIDs`/`contextPath` finding below: a dead vestige of violating exactly this rule is still in the schema. |
| `rel/` | relations via Synapses | separate mechanism, untouched | ✅ |
| `internal/` | engine | untouched | ✅ |

Rule of thumb: `features[]` holds only keys that are *asserted* and *not derivable* from other
doc state. Derived keys stay computed (single source of truth); view membership stays bitmap-only.

**Deep review 2026-07-15 — `doc.metadata` vs `doc.features`**

The two are different *kinds* of thing and must not share a container:

- **`metadata`** = descriptive facts about the payload, mostly EXTRACTED (`contentType`, `size`,
  `geo`, `exif`, `dimensions`, `media`). Written by derivers (stored ingest, the embed-time seam),
  opaque to the index except where a named deriver reads one field.
- **`features`** = membership assertions that map 1:1 onto bitmaps. Written by humans/clients.

Today `features` lives *inside* `metadata`, which fuses two lifecycles into one object — and
`BaseDocument.update()` (:299-301) merges metadata as a SINGLE shallow spread. So an EXIF
enrichment patch and a user tag edit take the same code path, at wildly different write
frequencies and trust levels. That is the sharpest argument for the root-level move, independent
of the rebuild-from-docs argument above.

**`comment` is the precedent to copy, exactly.** It was moved top-level for the same reasons and
already has every property `features[]` needs (BaseDocument.js:104-108): survives per-schema
migrations, stays out of `checksumFields` so edits don't fork dedup or re-embed, has its own
`update()` branch outside the `dataUpdated` path (:282-287), and drives a derived bitmap
(`feature/has-comment`). Model `features[]` on it line for line rather than inventing a shape.

**Status of the interim fix (2026-07-15, shipped, keep for now):** `documentFeatureKeys()`
(index.js:111) + tick/untick from `metadata.features` in `#putOne`/`putMany`/
`putManyDirectoryPaths`/link-by-id/`#updateOne`. Right *semantics* (declarative → derived),
wrong *place* (inside `metadata`). It fixes a real user-visible bug — tags on notes/files were
stored but never indexed, so bitmap filters and tag autocomplete could never see them. It is a
stepping stone, not throwaway: at cutover `documentFeatureKeys` changes one line
(`doc.features` instead of `doc.metadata.features`) plus a derived-prefix exclusion; the
stale-diff, tick/untick and batch wiring stay. **Do not ship it long-term as-is** — it currently
ticks derived keys out of an asserted-array, harmless only because `schema` is the sole derived
key in there.

**Dead code this refactor should delete (all verified zero-caller):** — **ALL DELETED 2026-07-17**
- [x] `BaseDocument.addFeature` / `removeFeature` / `hasFeature` / `getFeaturesByPrefix`
      — the whole imperative feature API. Zero callers; everything flows declaratively.
- [x] `setDocumentArrayFeatures` / `unsetDocumentArrayFeatures` — zero callers.
- [x] `metadata.contextUUIDs` + `metadata.contextPath` with their
      `addContext`/`removeContext` helpers — **100% dead**: always `[]` (verified live),
      no writer, no reader. Link.js duplicate declarations removed too. (Contact's linkSchema
      `contextPath` left alone — dies wholesale in the contact→identity fold.)
- [x] `nested/`, `user/`, `server/` from `ALLOWED_BITMAP_PREFIXES` (+ the `nested/` entry in the web's
      `EXCLUDED_BITMAP_PREFIXES`).

**Bugs found during the review (independent of the refactor, fix or ticket separately):**
- [ ] **`enforceClientTags` coverage is asymmetric** → device tags silently not merged on
      `PUT /workspaces/:id/documents` (workspaces/documents.js:664) and `POST /workspaces/:id/dotfiles`
      (dotfiles.js:129), while both context routes and `POST /workspaces/:id/documents` do merge them.
- [ ] **`data/abstraction/document` is registered at two versions**: `BaseDocument.js:18-19` says 2.2,
      `abstractions/Document.js:6-7` says 2.0 and is what the registry returns — so docs are stamped
      2.0 while validating against the 2.2 zod shape.
- [ ] **`Message.js` is not registered** (`data/abstraction/message`, with `fromSlack`/`fromTeams`/
      `fromIRC`) — `schemaRegistry.getSchema('data/abstraction/message')` throws, yet
      `core/workspace/services/chat/index.js:209` refers to the Message schema helper.
- [ ] **`indexOptions` merge order is inconsistent across schemas**: Bucket/Link/Contact/Application
      spread caller options LAST (caller wins); Document/Note/Email/Tab/Todo/File/Dotfile/Device
      spread them FIRST then hard-override the field lists (**caller's `ftsSearchFields`/
      `checksumFields` silently discarded**). Two opposite conventions for one knob — settle it in the
      schema-registration pass.
- [ ] **Derived `locations` drift on update**: `Dotfile` (:83) and `Application` (:114) rebuild
      `locations` from `data` in the CONSTRUCTOR only; `BaseDocument.update()` overwrites `data` and
      `locations` independently and neither overrides `update()` → a generic `update({data})` leaves
      `locations` stale.
- [ ] `abstractions/Document.js` is a leaf nobody extends (every abstraction does
      `import Document from '../BaseDocument.js'` and extends **BaseDocument**) — the import alias
      reads as if there's a Document hierarchy that doesn't exist.

**Prefix semantics — the "who says so?" rule (decided 2026-07-13):**
- `data/*` — the DOCUMENT says so: facts derived from doc state (`data/abstraction` ← schema,
  `data/mime` ← contentType, `data/backend` ← locations, `data/status` ← data.status). Controlled
  vocabularies, always rederivable, never asserted.
- `feature/*` — the ENGINE observes presence: boolean has-X flags (`feature/has-comment`).
  Presence flags only — multi-valued facets go under `data/*`.
- `tag/*` — the USER says so, free-form flat labels. Uncontrolled vocabulary; must NEVER share
  a namespace with controlled ones (a user tagging `pending` must stay distinguishable from
  `data/status/pending` — the cognitive layer disagreeing with the data layer is a feature).
- `custom/<axis>/<value>` — the USER says so, structured attributes (`custom/urgency/high`).
- [x] Consolidate `custom/tag/*` → `tag/*` (DONE 2026-07-13 — writers only, no data migration
      needed pre-deploy: CLI docbuilders, seed hook example, hook meta template).
- [x] Todo status bitmaps (DONE 2026-07-13): derived `data/status/<status>` via facetBitmapKeys
      (mime + status unified; tick current / untick stale in putMany/#putOne/#updateOne +
      reindex backfill). Gated on STATUS_FACET_SCHEMAS (todo only; generalize to
      `indexOptions.facetFields` with the schema registration facility). Also FIXED a latent
      putMany bug on the way: batch id-updates never unticked stale mime keys (prev-state must
      snapshot BEFORE existing.update(doc) mutates in place). Tests in todo-tasks.test.js.

**Write-path gotchas (all have existing precedent):**
- [ ] Feature edits must NOT regenerate checksums (dedup forks) — same treatment as `comment`
      (outside the `dataUpdated` path in `BaseDocument.update()`).
- [ ] Feature-only updates must NOT untick the embed seen-ledger in `#updateOne` (or bulk-tagging
      a photo gallery re-CLIPs it) and should reuse `emitEvent`-style event control.
- [ ] Tick/untick derived by diffing prev vs new `features[]` per doc — exactly the
      `mimeBitmapKeys` / `prevTimelineState` / `#removeStaleDeviceMembership` pattern.
- [ ] Batch path: `linkMany`-equivalent that rewrites N docs in ONE LMDB tx (feature edits become
      doc writes; 10k-doc tag = one tx, not 10k puts). Keep pure-bitmap `linkMany` for
      context/vfs membership — that stays view-layer.
- [ ] Decide `updatedAt` semantics for feature-only edits (bump = clients can sync-detect,
      but interacts with seen-ledger fix above; maybe bump + skip untick).
- [ ] GC/id-reuse: doc-declared features die with the doc naturally; today's bitmap-only tags on
      a reused id are a phantom-membership hazard — this refactor closes it.

**Migration:** one-time reverse scan — for each `tag/*`/`custom/*` (+ whatever the review adds)
bitmap, walk its ids, append the key to each doc's `features[]`; after that, feature bitmaps are
derived state forever (rebuildable, droppable).

**Rejected alternative (consciously):** separate `id → [featureKeys]` LMDB dbi (forward index
beside the inverted bitmaps). Cheaper writes, O(1) reads, but splits truth into a third place,
doesn't ride along in doc sync/export, no rebuild-from-docs property. Only revisit if feature
write volume ever makes doc rewrites measurably hurt.

**Sequencing (proposed 2026-07-15 — ordered so each step is independently shippable & revertable):**

1. **Deletions first, no behavior change** (~1h, zero data migration): drop the dead prefixes
   (`nested/`, `user/`, `server/`), the dead imperative feature API, the dead
   `contextUUIDs`/`contextPath` + `addContext`/`removeContext`, and Link's duplicate `data` copies.
   Deleting these *first* shrinks the surface every later step has to reason about — and each is
   provably unreachable, so the risk is a stale test, not a regression.
2. **Root-level `features[]`, modelled on `comment`** (the actual cut): field + zod entry + its own
   `update()` branch outside `dataUpdated`; `documentFeatureKeys()` reads `doc.features` and
   excludes derived prefixes; drop the schema unshift. Bitmaps keep following the doc — the
   tick/untick/stale-diff machinery from the interim fix carries over unchanged.
3. **Write-path gotchas** (the checklist above): checksum exclusion, seen-ledger, `updatedAt`
   semantics, batch tag-in-one-tx.
4. **Migration**: reverse scan per the plan above. Only after 2+3 are green.
5. **Schema registration facility**: separate rev, post-deploy per its own sequencing note — do NOT
   fold it into this cut. The `data/source/*` decision and the `indexOptions` merge-order
   inconsistency are the two things this cut should hand it.

**PITFALL — cost a cycle on 2026-07-15, will bite step 2 in exactly the same place:** in `putMany`,
`existing.update(doc)` **mutates `existing` in place and returns the same instance**. Any
"previous state" snapshot for a stale-diff MUST be taken BEFORE that call — the existing code
already does this for `prevChecksums`/`prevLocations`/`prevComment`/`prevTimelineState`/
`prevFacetKeys`, and `prevFeatureKeys` now joins them. Compute it after and the stale set is
silently always empty: the untick never fires, and every test that only asserts the *positive*
case still passes. (Same class of bug as the mime-untick one fixed 2026-07-13 — noted there too.)

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

### BaseDocument v3 — the golden standard (designed 2026-07-15)

Everything else builds on this, and most current abstractions move app-side anyway — so this is the
one schema worth getting right. Do NOT sweep the 13 abstractions; fix the foundation, then let the
registry carry the rest.

**Measured, not estimated** (a real `data/abstraction/note`, universe, 2026-07-15):

| field | bytes | share |
|---|---|---|
| `indexOptions` | 461 | **40.8%** |
| ↳ `embeddingOptions` alone | 203 | 18.0% |
| `metadata` | 140 | 12.4% |
| `checksumArray` | 124 | 11.0% |
| **`data` — the actual payload** | **42** | **3.7%** |
| everything else | ~360 | ~31% |
| **total** | **1129** | |

A note is **41% index config and 3.7% content**. At 7M rows `indexOptions` alone is ~3.2 GB of
byte-identical config — the "GBs" estimate above is confirmed.

#### Target shape

```js
{
    id, schema, schemaVersion,   // identity + which rules applied
    createdAt, updatedAt,
    data:          {},           // the payload
    comment:       '',           // user-authored, never regenerated, never checksummed
    features:      [],           // ASSERTED membership -> bitmaps 1:1   (root; see the section above)
    locations:     [],           // copies of the SAME bytes (dedup-keyed by checksum)
    timelines:     [],           // content-derived intervals
    metadata:      {},           // EXTRACTED/descriptive facts about the payload (contentType, geo, exif, dimensions, media)
    checksumArray: [],           // content identity
}
```

Note the symmetry that makes the whole model legible: **`features` = asserted, `metadata` =
extracted, `data` = the payload, `locations` = where the bytes are, `timelines` = when.** Each
answers exactly one question, and each has exactly one writer class.

#### Removals (each verified, this session)

- [ ] **`indexOptions` -> the registry, keyed by `(schema, schemaVersion)`.** −461 B/doc (41%).
      `schemaVersion` is already on every document and currently does nothing — give it this job:
      it is precisely the pointer to "which rules applied to this doc". Side-benefit: per-doc
      indexOptions accidentally *freezes* each document's identity rule at write time (an old doc
      keeps old `checksumFields` forever); registry-keyed rules make changing `checksumFields` an
      explicit, versioned migration — which is what it always was.
- [ ] **`embeddingOptions` -> off the document entirely** (see below).
- [x] **`embeddingsArray`** — zero writers (only BaseDocument + web type mirrors). Dead.
      **DELETED 2026-07-17** (schema, constructor, update(), toJSON(), web type mirrors).
- [x] **DECIDED 2026-07-15 — drop versioning. DELETED 2026-07-17.** `parentId` / `versions` /
      `versionNumber` / `latestVersion` + all SEVEN empty-stub methods removed from BaseDocument,
      web type mirrors and web version-display UI (document lists, object-card tabs, sort column).
      Re-add with a real implementation (see "DB snapshot/restore" above), not before.
- [ ] `metadata.contextUUIDs` / `metadata.contextPath` + `addContext`/`removeContext` — dead (see
      the feature review above).
- [ ] `metadata.features` -> root `features[]` (see the feature review above).
- [x] **DECIDED 2026-07-15 — generate sha256 ONLY; keep the multi-algorithm logic.** The array/
      `checksumAlgorithms` machinery stays (more algorithms must remain supportable); the default
      simply becomes `['sha256']`. sha256 because cacache uses it too, so blob and document identity
      finally speak one language (`File` already ships sha256-only). Saves ~62 B/doc.

      **Correcting a live assumption — dedup is sha1 today, NOT sha256, for exactly the docs that
      matter.** Measured 2026-07-15: `note` and `tab` have `checksumArray[0] = 'sha1/…'`;
      `file`/`email` have `sha256/…`. `getPrimaryChecksum()` returns `checksumArray[0]` and
      **ignores `primaryChecksumAlgorithm` entirely** (email declares primary `'sha1'` yet is sha256
      by array position). So the switch DOES move the tab primary sha1 → sha256.

      **Verified safe empirically** (universe, 2026-07-15): created a tab the current way
      (sha1+sha256), then re-put the same tab with a sha256-ONLY `checksumArray` → **deduped to the
      same id**, no fork. **This works only because every checksum in the array is indexed**
      (`#checksumIndex.insertArray(doc.checksumArray)`, confirmed by user) — so a sha256 entry
      already exists for every sha1-primary doc, and the sha256-only lookup hits it. That is the
      load-bearing fact, not the plan: **if a future schema ever generates an algorithm that was not
      previously indexed for existing docs, the same switch forks every document.** Stale sha1 index
      entries are harmless (dropped on the doc's next `#updateOne`, which `deleteArray`s the old
      array).
- [x] **`indexOptions.primaryChecksumAlgorithm`** — dead twice over (never read; not in the zod
      shape). **DELETED 2026-07-17** from BaseDocument defaults, File.js, web type mirrors; the
      web's three `getPrimaryChecksum()` helpers now use `checksumArray[0]` (position = primacy,
      matching synapsd) instead of a prefix-match against the field with an 'sha1' fallback.

Result for the measured note: **1129 B -> ~620 B (−45%)**, with `data` rising from 3.7% to ~7% of
the row.

#### Embedding config does not belong on the document — and the A/B case is better served without it

The clinching argument is not size, it is that **the layer storing it disclaims the responsibility**:
`index.js:263` — *"synapsd owns no embedding model: vectors arrive via storeDocumentEmbeddings (the
embedd service / any app)"* — and `VectorIndex.js:29` — *"searches them — it does not run the
embedding model."* Nothing in synapsd reads `embeddingOptions` to make a decision; the embedd
router decides. `embeddingDimensions` is worse than redundant: `VectorIndex` holds ONE fixed `#dim`
per table and recreates the table on mismatch (`VectorIndex.js:93-94`), so a per-document dimension
can never be honored.

**The "different model on a subset of documents as a test" use-case (the reason to keep it) is
actually the argument against it.** A subset of documents is a *set*, not a schema and not a
per-doc field — and set-selection is the one thing this engine is best at. Split the concern:

| concern | belongs | why |
|---|---|---|
| **config** (which model to run) | embedd router rule + a feature/filter selector | the subset primitive already exists (bitmaps); an experiment = tag a subset, point a rule at it — **zero document writes**. With per-doc config you would rewrite N documents to start an experiment, and N more to end it. |
| **provenance** (which model produced this vector) | a column on the Lance row (`model`, `dim`, `embeddedAt`) | needed anyway for drift detection and partial re-embed ("re-embed everything vectorized with model X"). Today NO model provenance exists on a vector row — that is the real gap the per-doc field was pretending to cover. |
| **the document** | nothing | it is neither config nor provenance |

A different model almost always means different dimensions, which means a different Lance
table/space regardless — so an A/B is naturally "second space + router rule", never a doc field.

- [x] Add model/dim provenance to the Lance row (the actual missing capability) — SHIPPED
      2026-07-17, see "Vector provenance + per-(model,dim) spaces" above.
- [ ] Per-workspace embedd router rules (already tracked in canvas-server TODO "Refactor embedd") are
      the config surface; a feature/filter-scoped rule is the experiment mechanism.

### Schema simplification (decided 2026-07-15)

**The problem, concretely: `tab` and `link` are the same document with different field names.**

| | `link` v1.0 | `tab` v2.0 |
|---|---|---|
| URI field | `data.uri` | `data.url` |
| Title field | `data.label` | `data.title` |
| checksumFields | `['data.uri']` | `['data.url']` |

The divergence already leaks into the UI: `ui/web/.../object-card/EditForm.tsx` carries
`urlTitleKeys(schema)` whose ONLY job is to paper over `uri/label` vs `url/title`. That function is
the bug report. Delete it as part of this.

#### What the data says (sizes every decision below)

| | local dev (`universe`, measured 2026-07-15) | pre-prod (daily driver, user-reported) |
|---|---|---|
| tab | 16 | **the bulk of ~2600 docs** |
| file (mostly images) | 34 | most of the rest |
| note | 129 | — |
| email | 23 | — |
| device / dotfile | 2 / 1 | — |
| **link** | **0** | assumed 0 — **NOT measured, verify before the Link rename** |
| **contact** | **0** | 0 (user: never implemented, never used) |
| todo / application / message / document | 0 | — |

⚠️ The pre-prod column is user-reported, not measured — local dev counts do not authorize a
destructive step there. Before executing anything in the migration table, run the per-abstraction
count on pre-prod (`GET /workspaces/:ws/documents?allOf=data/abstraction/<x>&limit=1` → `totalCount`).
The Link rename is code-only **only if `link` is genuinely 0 there**.

**Only `tab` documents must survive a migration.** Everything else has a rebuild source (user,
2026-07-15): images/files live in the workspace on disk and re-add on re-sync; notes are backed by
on-disk markdown; todos and emails can be reingested. Tabs are the one class with no source of
truth outside the DB — so any plan that rewrites tab docs is the one plan worth being paranoid
about. Six of the ~13 abstractions have ZERO documents anywhere, so most of this refactor is
deletion and renaming against nothing.

#### Decision 1 — field naming: `url` + `title` wins. **Link adopts Tab's names, not vice versa.**

Industry standard is overwhelming: WebExtensions `tabs.Tab`, Chrome/Firefox bookmarks, the Netscape
bookmark format (`HREF` + text), JSON Feed, Atom (`link href` + `title`), Open Graph
(`og:url`/`og:title`), Pocket, Raindrop. schema.org is the only near-miss (`url` + `name`).
`uri`/`label` is essentially nowhere.

Internal consistency agrees: `locations[].url` already holds `file://`, `stored://`, `imap://`,
`s3://` — arbitrary non-http schemes, under the name `url`. Naming Link's field `uri` would
contradict the codebase's own convention for the same concept.

**And it's the zero-risk direction**: `link` has 0 documents, so nothing migrates; the extension and
CLI already write `data.url`, so no client changes; and the ~2600 tabs — the only data with no
rebuild source — are never touched. The opposite direction would have rewritten exactly them.
Keep Link's `data.scheme` derivation (`#extractScheme`) — it's genuinely useful and stays.

#### Decision 2 — schema inheritance ticks the ancestor chain

Precedent already in the engine: `mimeBitmapKeys()` ticks BOTH `data/mime/image` and
`data/mime/image/jpeg` for one jpeg. Same rule for schemas: a tab ticks `data/abstraction/tab` AND
`data/abstraction/link`, so "all links" finds tabs.

Ids stay **flat**; the registry supplies the chain. Do NOT rename to `data/abstraction/link/tab` —
mime gets its hierarchy free because `image/jpeg` is inherently hierarchical AND derived from
`contentType` (rename costs nothing), whereas schema ids are persisted in every `doc.schema` and in
the feature bitmaps. Flat ids + chain ticking give identical query power with no id migration, and
nothing precludes nesting later.

#### Decision 3 — `contact` folds into `identity`; `data.tags` → `features[]`

`contact` has **0 documents** — never implemented, so this is a pure code change with no migration.
Target `data/abstraction/identity` with `type: person|organization|service|bot` (per the L1 list
above). It matters later — tagging photos with identities, harvesting contacts from email, building
a contact DB — and both of those are **relations** (`rel/depicts`, `rel/authored-by`), i.e. the same
L2 mechanism as tab→snapshot below, not new machinery.

`data.tags` → `features[]` is now unconditional. Zero contacts also dissolves the one blocker:
`Contact` was the only schema vector-embedding `data.tags` (`vectorEmbeddingFields: ['data.tags']`),
so there is no re-embed cost. Remaining `data.tags` writers to fold: `Link`
(`addTag`/`removeTag`/`#ensureArray`), `Dotfile` (:79,:94), `Application` (:110,:125), and CLI
`dot add` (`modules/dot/actions/add.js:68`). Note the web's `EditForm.tsx:50-52` already falls back
to `doc.data?.tags` when `features` has none — it is silently reconciling two of the three tag homes
today (the third being the body-level `features` param).

#### Offline "download this site" → a SECOND document, joined by a relation

Not a location, not an in-place transform:

```
tab (identity = url)  ──rel/snapshot-of──>  file (identity = content hash, stored://…)
```

- **Cardinality decides it.** One URL → N snapshots over time (that's the point of an archive).
  `locations[]` cannot express it: locations are *copies of the same bytes*, dedup-keyed by one
  checksum. Two snapshots a month apart have different checksums, so by definition they are not
  copies of each other.
- **Identity.** A tab's checksum is its normalized URL; a file's is its content hash. If a tab
  "became" a file its id would have to change — and the id is the key every bitmap, timeline and
  relation hangs off.
- **Payoff.** As a real `file` doc the snapshot inherits FTS, embedding, CLIP, dedup, blob backends
  and range streaming — all already built. Inside `data` it gets none of them.
- [x] **Delete `Link.data.previews[]`** — zero writers, zero readers, a half-built version of
      exactly this. **DELETED 2026-07-17.** Build the relation instead.

Generalizes beyond tabs — email→attachment, note→embedded image, application→installer blob,
photo→identity. This is the L2 relation layer earning its keep (`data/relation/generated-from` is
already listed above); Synapses already reverse-indexes and cleans up precisely.

#### Registry shape

```js
db.registerSchema('data/abstraction/tab', {
    extends: 'data/abstraction/link',      // parent dataSchema + indexOptions merge in
    data: z.object({ browser: z.string().optional(), windowId: z.number().optional() }),
    indexOptions: { ftsSearchFields: ['data.title', 'data.url'] },
});
```

- **Core stays in synapsd** (schema-agnostic primitives): `document`, `link`, `file`, `bucket`.
- **App-registered** (canvas-server, at boot): `tab extends link`, plus note, todo, email, identity,
  message, device, application, dotfile.
- Settle the **`indexOptions` merge order** here (see the review findings above — half the schemas
  silently discard a caller's `ftsSearchFields` today). `extends` makes the merge rule load-bearing,
  so it can no longer be left ambiguous.

#### Migration table

| Change | Docs affected | Migration |
|---|---|---|
| Link `uri`/`label` → `url`/`title` | 0 | none — code only |
| `tab extends link` | ~2600 | **none** — ids and fields unchanged; ancestor bitmap ticked on next write, backfilled by reindex |
| `contact` → `identity` | 0 | none — code only |
| `data.tags` → `features[]` | dotfile 1, application 0, link 0 | trivial script; fold into the reverse scan |
| Drop `previews[]`, `contextUUIDs`, `contextPath` | all (all empty/dead) | none — drop on next write |

The only ~2600-doc item is the one that needs no migration at all. Everything requiring a rewrite
touches ≤1 document.

### Schema registration facility (v2)

**Motivation.** `synapsd` was extracted from `canvas-server` (the split was justified), but the
hard-coded `SchemaRegistry` still carries app-specific abstractions (contact, email, tab, note,
todo, dotfile, application, message, device). The db only ever needs three things per schema:

- `dataSchema` - zod schema for `data`, used for validate-on-write
- `indexOptions` - which fields to checksum / FTS / vector-embed
- `(de)serialization` - `toJSON` shape (round-trip)

Everything else (e.g. `Email.fromIMAP`, `Email.fromGraph`, `Message.fromSlack/fromTeams/fromIRC`)
is ingest/integration logic that does **not** belong in the storage layer.

**Target shape.** Replace the hard-coded map with a registration API the app calls at boot:

```js
db.registerSchema('data/abstraction/email', {
    dataSchema,            // zod
    indexOptions,          // { checksumFields, ftsSearchFields, vectorEmbeddingFields }
    toJSON, fromJSON,      // optional; default to BaseDocument behaviour
});
```

- **Builtin core** stays in `synapsd` (schema-agnostic primitives only):
  `document` (generic JSON), `blob`/`file`, `bucket`, `link`.
- **App-registered**: contact, email, tab, note, todo, dotfile, application, message, device -
  definitions move to `canvas-server`, registered on startup.
- The `device/id/<id>` presence-bitmap derivation reads `locations` only and is fully
  schema-agnostic - it stays in the db and is untouched by this refactor (validates the seam).

**Cutover is migration-free.** Schema id strings (`data/abstraction/email`) are persisted in each
doc's `schema` field and in the `metadata.features` bitmap. Moving a class app-side changes only
*where the definition lives*, not the stored id strings or bitmaps - so no data migration, and old
and new can coexist during the move. Do it incrementally: register one abstraction app-side, delete
it from the builtin map, repeat.

**Cheap pre-work (independent, low-risk):** lift the provider factories
(`Email.fromIMAP`/`fromGraph`, `Message.fromSlack`/`fromTeams`/`fromIRC`) out of the schema classes
into the app ingest layer now - no registry change, no data change, removes the worst of the leak.

**Sequencing:** post-deployment. Not on the critical path for the current customer deploy
(roaming profiles / browser sync / dotfiles / imap+o365) - those use the existing abstractions
as-is, and the clutter has no runtime/security/perf cost, only maintainability.

## Tests

- [ ] Add a proper test suite for the current API


## Optional

- [ ] BitmapIndex cache is an unbounded Map (every bitmap ever touched stays resident) - fine at KB sizes, needs a cap/eviction before wikipedia-scale ingest.
