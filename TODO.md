# SynapsD

The v3 surface mixes structural consolidation with net-new capabilities. g: glob and groupBy:'timeline' don't exist yet (glob/regexp filters currently throw, per query-and-membership.test.js:123-128), while the parser/seam/t: grammar/write-signature work is pure consolidation. How do you want cut #1 scoped?



## Semantic layer

To test *7M wikipedia articles, ~2 milion files ingestion
- en wikipedia dataset converted to thousands of markdown files ingested into a workspace > synapsd
This is pure text so the current embedding model should be sufficient, dataset a bit too clean so not really a prod test yet
- Dataset will be post-processed by a local LLM to associate its content with a dedicated "wikipedia" timeline (naive, simple, stupid for round 1, we'll get to the more interesting hierachical vector trees later)
- embedding path: ensure wikipedia text lands in a server-embeddable schema (derived `document`/`note`, registered in `embeddableSchemas`) - as `data/abstraction/file` you'd embed `locationUrls`, not the article.
- [Input Chunk] ➔ [Qwen3-VL (64d)] ➔ [PCA (e.g., 16d or 32d)] ➔ [Scalar Quantizer (Bands)] ➔ [Roaring Bitmap Index]

## Refactor v3

Do the simplest thing that works; aim to delete more than you add.

! Do NOT use `bitmapIndex.untickAll` (`indexes/bitmaps/index.js:415`): O(all-bitmaps) per delete, that's why it's dead. The bitmap side is already cleaned precisely and cheaply by `clearSynapses` (`indexes/inverted/Synapses.js:144`) via the reverse index. Leave `untickAll` dead.

### Prereq
- [x] Split `query()` into two stages, both stateless and pure. No caching inside synapsd: the operand cache is the session's job, the db stays stateless.
      - `resolveCandidates(spec) -> { bitmap, keys }`  (paths ∩ features ∩ filters). `keys` = the bitmap keys the operand actually read, so a session can invalidate precisely instead of dirtying everything.
      - `rank(bitmap, match, {mode,limit,offset}) -> page`  (fts/vector/hybrid; expensive). With `match=null` it degrades to slice+fetch, so `list(spec)` == `rank(resolveCandidates(spec).bitmap, null, …)` — one materializer, not three.
      `query(match, spec)` becomes `rank(resolveCandidates(spec).bitmap, match, …)`.
      Bonus: this seam dedupes today's copy-pasted candidate-building in `list` vs `search` (index.js:1725-1771 vs index.js:1881+). Land it right after the spec parser.
- [x] Cacheability is conditional. Path/feature operands have stable keys and cache cleanly. Relative timeframes do NOT: `t:crud:updated:thisWeek` is wall-clock dependent. Resolve relative timeframes to absolute bounds at call time; whether those bounds freeze or slide is the session-mode decision below.

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
- [x] Public read surface is just `list()` + `query(match, spec)`. `list(spec)` == `query(null, spec)`, kept for back-compat / simple UX (`list` index.js:1694). Collapse `search` into `query` (`search` index.js:1838). `recall` (anchor planning, index.js:585) is deferred to the Session feature.
- [x] One spec parser: each bucket accepts level-1 sigil strings (`+`/`!`) and level-2 `{allOf, anyOf, noneOf}`; compile sigils into the object form. Replaces the alias sprawl in `#normalizeQuerySpec` (index.js:3096).
- [x] Fold exclusion into the path grammar (`!ctx:/path`); delete the six `excludeTree*`/`excludeContext*` aliases (index.js:3111-3149).
- [x] Split match inputs `{ text?, image? }` from `mode` (`fts|vector|hybrid`); kill the `query`/`search`/`q` and `fts`-vs-`text` key conflation (index.js:1843, index.js:1860).
- [x] Move `put`/`putMany`/`link`/`linkMany` to `(document, spec)` with `spec = { paths, features }` only, no filters/match on writes. Currently positional `(document, treeSelector, features, options)` (index.js:568, 589, 618, 1064).
- [x] Tree paths as `ctx:/a/b` and `dir:/a/b` (prefix = tree id); drop the `context://` / `directory://` URL form.
- [ ] Filter prefix registry (`t:` temporal, `g:` glob, `re:` regexp) with the same sigil algebra as paths/features; see "Filter grammar" below. *(`t:` shipped; `g:`/`re:` parse-time throw, deferred to db schema refactor.)*

### Filter grammar (`t:` temporal, `g:` glob, `re:` regexp)

Surface is uniform `t:<name>:<spec>`; the parser splits internally. Sigil algebra matches paths/features: default `anyOf` (OR), `+` = `allOf` (required gate), `!` = `noneOf` (exclude). The hard part already exists: `TimelineIndex.queryInterval` (indexes/inverted/Timeline.js:188) takes a name array and unions, auto-detects scale (`'1996'` -> year, Timeline.js:482), and has a per-timeline `mode:'layers'` (Timeline.js:349). Arbitrary content timelines are already indexed per-document (`timelines:[{name,start,end}]`, index.js:3004); `crud:*` are reserved auto-managed ones.

Spec forms:
- Content point: `t:wikipedia:1996`
- Content range: `t:wikipedia:1996..1999` (`..`, since `:` is the segment delimiter); relative ages parse too (`t:geology:541mya..252mya`)
- Lifecycle (reserved `crud`): `t:crud:<action>:<timeframe|range>`, e.g. `t:crud:updated:thisWeek`. Named timeframes stay crud-only (wall-clock relative; meaningless on a content axis).

Overlay = multiple anyOf `t:` items, canonical form is one line per timeline (composes when ranges differ):

```
filters: ['+t:crud:updated:thisWeek', 't:wikipedia:1996', 't:personal:1996']
// => crud:updated in thisWeek  AND  (wikipedia ~ 1996  OR  personal ~ 1996)
```

- [ ] `t:`/`g:`/`re:` prefix dispatch in `parseFilters` (replaces the `datetime:`-only check, filters.js:18); timeline name comes from the token, drop the hardcoded `crud:${action}` (filters.js:103). Today `filters` object only knows `timeline` -> `datetime:updated:<v>` (index.js:3196). *(`t:` shipped; `g:`/`re:` deferred to db schema refactor.)*
- [x] Sigil-aware filter combiner: partition `t:` items into allOf/anyOf/noneOf, resolve each via `queryInterval`, combine `AND(allOf) ∩ OR(anyOf) \ OR(noneOf)`. Replaces the "AND everything" filter loop in `list`/`search` (index.js:1742, index.js:1905).
- [ ] `groupBy: 'timeline'` result option: union still drives retrieval, response is bucketed per timeline (`{ wikipedia:[...], personal:[...] }`) via `queryInterval` `mode:'layers'`.

### Vectors & modalities
- [ ] Multimodal vector search: text + image now, (streaming) video/audio later. Carry `match` as `{ text?, image? }` end-to-end.
- [ ] External embedding connectors besides local ONNX (ollama, openai, anthropic) behind one provider interface.

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
- [ ] Audit `#buildAllDocumentsBitmap()` callers (`noneOf`-only features, `excludeTree`, `excludeContext`, root-source): each is a full scan, short-circuit when the positive set is already bounded (index.js:3412). *(deferred: needs design.)*
- [ ] Lift `indexOptions` (esp. `embeddingOptions`) out of per-document `toJSON()` to schema level: GBs of identical config across 7M rows. *(deferred: per-abstraction config, not per-doc storage; needs design + back-compat sign-off.)*

### Docs & rollout
- [x] Document the v3 API in `src/services/synapsd/README.md`: spec buckets, sigil algebra, filter grammar (`t:`/`g:`/`re:`), multi-timeline overlay, and `groupBy:'timeline'`.
- [x] Refactor is its own session. Update the two main consumers of the query surface: `src/core/workspace/Workspace.js` (direct db caller) and `src/core/workspace/lib/WorkspaceStoredIndex.js`; `src/core/context/lib/Context.js` rides on top via `workspace.list/search` (Context.js:1243).

### Release
- [x] Major version bump in `package.json` (currently `2.1.1`).


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


----

L0 would then be "storage" centric - eg resources, where the physical bit of the full objects are stored and can be retrieved from
data/resource/blob or file or url/uri? - points to a local or remote resource (immutable)
data/resource/referene - points to a external source(db, s3)

L1 Semantics 
data/entity/file ? (blob)
data/entity/document (JSON doc)
data/entity/message
data/entity/event (type: calendar, alert, activity)
data/entity/task
data/entity/identity (type: person, organization, service, bot)
data/entity/device
data/entity/application
data/entity/dotfile

data/entity/organization

L2 Relations (would require some cleanup)
data/relation/references
data/relation/authored-by
data/relation/mentions
data/relation/replies-to
data/relation/generated-from
data/relation/executed-on
data/relation/installed-on

L3 will be specially generated semantic anchors/chunks and summaries with several sub-layers (more on that later)

## Rand

- multi-model support for vec_text but with the new arch this is not on the table

## High level architecture

Retrieval
- bitmaps
  - context
  - filter
    - timelines
  - feature
- glob/regex
- primitive vector based sim-search
- bm25?

- Hierarchical vector index


### Layer 1: JSON Store

- LMDB KV backend levaraging LMDB datasets for documents, all indexes(inverted, roaring), high level abstractions(layers/tree nodes and internal structures)
- Values are always schema-validated JSON documents or BLOBs(roaring bitmaps) with content(data) and/or location URLs pointint to non-local data

### Layer 2: Indexes

- Bitmap (roaring bitmaps)
- Inverted
  - Checksums
  - Synapses (nested bitmaps, to be replaced eventually)
- Bit-sliced indexes (current timeline implementation)
  - Reference: https://www.pilosa.com/docs/architecture/#bsi-range-encoding
- Vector (LanceDB)

### Layer 3: Semantic projection

There are couple of (experimental, not production/battle-tested) premises this engine is built on 
- That we won't go into right now :) 

Easiest implementation for "semantic" recall is our timeline module `src/indexes/inverted/Timeline.js` which is fairly easy to use in agentic scenarios without much needed on the db level.

We already map:

- **`now`** - Documents matching the current hour
- **`today`** - Documents from today
- **`yesterday`** - Documents from yesterday
- **`tomorrow`** - Documents from tomorrow
- **`lastWeek`** - Documents from last week
- **`thisWeek`** - Documents from this week
- **`nextWeek`** - Documents from next week
- **`lastMonth`** - Documents from last month
- **`thisMonth`** - Documents from this month
- **`nextMonth`** - Documents from next month
- **`lastYear`** - Documents from last year
- **`thisYear`** - Documents from this year
- **`nextYear`** - Documents from next year
- **`lastDecade`**, **`thisDecade`**, **`nextDecade`**
- **`lastCentury`**, **`thisCentury`**, **`nextCentury`**
- **`lastMillennium`**, **`thisMillennium`**, **`nextMillennium`**

## Views

### Trees

- `contextTree`
- `directoryTree`

### Buckets

### Timelines

## TODO

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

### Generic

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

### "!tag" shorthand (optional sugar)

* If a string in `allOf/anyOf` starts with `!`, move it to `none` internally.
* Keeps compatibility with quick one-liners.

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
- [ ] Add tests for `list(spec)`:
  - [ ] attributes `allOf`
  - [ ] attributes `anyOf`
  - [ ] attributes `noneOf`
  - [ ] context-only
  - [ ] directory-only
  - [ ] timeline filters
  - [ ] glob/regexp filters
  - [ ] pagination
- [ ] Add tests for `search(spec)`:
  - [ ] global search
  - [ ] context-filtered search
  - [ ] attribute-filtered search
  - [ ] timeline-filtered search
- [ ] Add workspace integration tests against new API translation layer.
- [ ] Regression: `subtractFromMany`/`applyToMany` when the source key is also in the targets (self-aliasing must not zero the shared cached source mid-loop)

