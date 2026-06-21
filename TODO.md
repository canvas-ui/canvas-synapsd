# SynapsD

To test

[Input Chunk] ➔ [Qwen3-VL (64d)] ➔ [PCA (e.g., 16d or 32d)] ➔ [Scalar Quantizer (Bands)] ➔ [Roaring Bitmap Index]


## synapsd: restore document-ID GC / reuse (regressed)

Freed IDs are currently never reused. `generateDocumentID`/`generateDocumentIDs` (`src/services/synapsd/src/utils/document.js:78,95`) only increment `internal/document-id-counter`. The `internal/gc/deleted` bitmap is ticked on delete (`index.js:2020`) but never unticked and never consulted by the allocator (read only for the `deletedDocumentsCount` stat, `index.js:200`). IDs grow monotonically forever; roaring bitmaps lose density.

Refined safe-reuse design (agreed): **DONE** (2026-06-21). Tests: `tests/document-id-gc.test.js`.
- [x] **Make `internal/gc/deleted` a strict free-id pool, not a tombstone.** Pool admission moved OUT of the delete txn to AFTER lance fts + vector cleanup succeeds, in both `#deleteOne` and `deleteMany`. Failed cleanup → id leaks, never corrupts. NB: the old in-txn `deletedDocumentsBitmap.tick()` was `Bitmap.tick` = in-memory only (never persisted — pool was never read so it didn't matter); admission now uses the persisting `bitmapIndex.tick(deletedDocumentsBitmap.key, …)`.
- [x] **Allocator pops from the pool first.** New `SynapsD#allocateDocumentIDs(count)`: pop `minimum()` densest-first, top up remainder from counter. Replaces all 3 `generateDocumentID(s)` call sites (`#putOne`, `putMany`, `putManyDirectoryPaths`). Util fns left in `utils/document.js`, no longer imported by index.js.
- [x] **Do allocation within a single LMDB tx.** `#allocateDocumentIDs` runs pool-pop + counter bump + pool persist (`bitmapIndex.saveBitmapSync`, new public method) inside one `internalStore.transactionSync`. Datasets share one env (`LmdbBackend.createDataset` → `openDB`) so writes commit atomically; the callback is fully synchronous so no async writer can interleave for the same freed id.

Lance delete now returns a success boolean (`LanceIndex.delete/deleteMany`, `VectorIndex.deleteDoc/deleteMany`) so admission can be gated; `!table`/empty counts as success (nothing to clean).

Do NOT use `bitmapIndex.untickAll` (`bitmaps/index.js:415`) — O(all-bitmaps) per delete, that's why it's dead. Bitmap side is ALREADY cleaned precisely + cheaply by `clearSynapses` (`Synapses.js:144`) via the reverse index. Left untickAll dead.

**Fix before MVP ingest run**
- [ ] `untick` (single) in `indexes/bitmaps/index.js`: add the size-change guard `untickMany` already has — currently re-serializes+writes a full slice bitmap even when nothing changed.
- [ ] `BitSlicedIndex.setValue`: stop clearing zero-bits on first insert (only untick on overwrite); ideally batch the 64 slice writes. Together with the line above this is the timeline write-amplification killer for the wikipedia pass.
- [ ] In-batch content dedup in `putMany` and `putManyDirectoryPaths` (`index.js`): add a `Map<primaryChecksum, preparedEntry>` across the prepare loop; on a hit, merge path/location into the existing entry instead of minting a new id. Today two identical files in one batch fork into two docs and the checksum index keeps only the last → corrupts the one-blob-one-doc model on NAS.

**Scaling / cost cliffs**
- [ ] Cap `list()` default `limit` (it's `0` = unlimited → parses every row); document "all docs" as an explicit opt-in, not the default.
- [ ] Gate `#migrateRootBitmaps()` / `#migrateBitmapKeys()` behind a stored schema-version flag — they run an O(N) all-docs transaction on *every* startup.
- [ ] Audit the `#buildAllDocumentsBitmap()` callers (`noneOf`-only features, `excludeTree`, `excludeContext`, root-source) — each is a full scan; at least short-circuit when the positive set is already bounded.
- [ ] Lift `indexOptions` (esp. `embeddingOptions`) out of per-document `toJSON()` to schema level — it's GBs of identical config across 7M rows.
- [ ] Replace `getBitmapsForDocument`'s scan-all-bitmaps with the synapse reverse index (`listSynapses`).

**API collapse (the part you agreed to)**
- [ ] Merge `list` / `search` / `recall` into one core `query(match, spec)`; `list(spec)` = no-match, `recall` = query + anchor planning on top.
- [ ] `spec` buckets accept both level-1 sigil strings and level-2 `{allOf, anyOf, noneOf}`; one parser compiles sigils → object.
- [ ] Fold exclusion into the path grammar (`!tree://path`) and delete the six `excludeTree*/excludeContext*` aliases in `#normalizeQuerySpec`.
- [ ] Split match-inputs (`{text?, image?}`) from `mode` (`fts|vector|hybrid`); drop the `fts`-vs-`text` key conflation.
- [ ] `put`/`link` take `{paths, features}` only — no filters/match on writes.
- [ ] Define the filter prefix registry (`t:` temporal, `g:` glob, `re:` regexp) and make `t:<timeline>:<spec>` uniform across crud + content timelines.

**Low-priority cleanup**
- [ ] MVP #1 embedding path: ensure wikipedia text lands in a server-embeddable schema (derived `document`/`note`, registered in `embeddableSchemas`) — as `data/abstraction/file` you'd embed `locationUrls`, not the article.
- [ ] `crypto.js` `uuid()` uses `crypto.rng` (not a real Node 22 API) — looks dead; delete or swap to `crypto.randomUUID()`.
- [ ] `Email.fromIMAP/fromGraph` don't set `checksumArray`, so the checksum is the data-JSON hash, not the `.eml` blob the comment claims — fix the code or the comment.
- [ ] Proceed with the schema-registry extraction already in TODO.md (app abstractions → `registerSchema`); the `device/id/<id>` derivation reading only `locations` confirms the seam is clean.






list(spec?)              // == query(null, spec)
query(match, spec?)      // match: string | { text?, image? }
recall(match, spec?)     // query + semantic-anchor planning on top



put(document, spec?)     // spec: { paths, features }  — no filters, no match
link(idOrIds, spec)      // spec: { paths, features }


// spec buckets, each accepting BOTH levels:
{
  paths:    ['ctx:/a/b', '!dir:/staging'],          // or { in:[…], not:[…] }
  features: ['+tag/red', 'data/abstraction/file', '!tag/spam'],  // or { allOf, anyOf, noneOf }
  filters:  ['t:crud:updated:thisWeek', 'g:*.pdf'],
  mode: 'hybrid', limit, offset, parse,             // options live flat here
}

Buckets intersect; items within a bucket union. paths AND features AND filters AND match (the pipeline is an intersection). Within a bucket the default is anyOf (OR); + promotes an item to required (allOf), ! excludes it (noneOf).

{ text?, image? } — and put fts|vector|hybrid in the spec as mode. (Your

One consolidation worth calling out because it's already hurting you: #normalizeQuerySpec in index.js destructures excludeTree, excludeTrees, excludeContext, excludeContextSpec, excludeContexts, excludeContextSpecs — six aliases. That sprawl is the symptom of exclusion not living in the path grammar. !ctx:/staging and !projects:// (whole tree) collapse all six into the paths bucket. That alone justifies the rewrite.

default trees so ctx:/dir:

ilter prefixes need a small registry now or they'll go ad hoc: t: temporal, g: glob, re: regexp. Keep t:<timeline>:<spec> uniform so t:crud:created:thisWeek (lifecycle) and t:wikipedia:1720 (content) parse the same way — your code splits those two internally, but the surface grammar shouldn't.



Nevertheless - layered architecture it is - we do this anyway
We always process(or should always process)
- tree path bitmaps
- then feature bitmaps
- then filters (BSI based timelines, globs/regexp etc)
- then on a subset of documents sematics(vactor based) queries

only then retrieve documents which are full docs or indexes pointing to external locations

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







We need to extend our @src/services/synapsd/ module to support vector search for multiple modalities(text, images, later probably (streaming) video and audio) and connectors for external services to generate embedding vectors besides local ONNX, ideally ollama/anthropic, openai.

But lets start with something else

The current API is, lets say cumbersome  
I especially dont like how we query trees and tree paths


bitmaps


We have 
- allOf  +
- anyOf  (default)
- noneOf !

list(paths, features, filters)

put(document, paths, features, filters)
putMany(documenst, paths, features, filters)

link(id, paths, features, filters)
linkMany

fts | vector | hybrid

query(
  "red ferrari", 
  [
    'directory://foo/bar/baz'
  ],
  [
    'data/abstraction/file'
  ],
  [
    't:crud:created:thisWeek',
    't:crud:updated:thisWeek'
  ]
)

query(
  {
    "image": {
      format:
      content:
    }
    "text": {
      content: {

      }
    }    
  },
  [
    'context://foo/bar/baz'
  ],
  [
    'data/abstraction/file'
  ],
  [
    't:crud:created:thisWeek',
    't:crud:updated:thisWeek'
  ]
)

list(
  [
    'directory://foo/bar/baz',
    'directory://foo/baf',
    'context://baf/baz'
  ],
  [
    'data/abstraction/file',
    'data/abstraction/note',
    'data/abstraction/tab',
    'data/source/wikipedia'
  ],
  [
    t:crud:created:thisWeek,
    t:crud:updated:thisWeek
    t:wikipedia:
  ]
)

Short form:

query: "text"

paths: [
  'treeId://some/path',
  'anotherTree://some/other/path',
  '!treeId://some/path/i/want/to/exclude'
]

features: [
  'data/abstraction/tab',
  'custom/tag/foo',
  '
]

filters: [
  't:timelineName:range'
  't:wikipedia:today
]

Long form

query: {
    fts: "string"
    text: "string"
    image: "base64string"
}

paths: [
  'treeId://some/path',
  'anotherTree://some/other/path',
  '!treeId://some/path/i/want/to/exclude'
]

features: [
  'data/abstraction/tab',
  'custom/tag/foo',
  '
]

Query should be parsed and processed as follows:

Paths > Features > Filters > Query on top


---

timelines: [
    {
        name: 'wikipedia',
        start: '1215',
        end: '1215',
    },
],





There are 2 use-cases I'm planning to test with:
#1 en wikipedia dataset converted to thousands of markdown files ingested into a workspace > synapsd
This is pure text so the current embedding model should be sufficient
- Dataset will be post-processed by a local LLM to associate its content with a dedicated "wikipedia" timeline (naive, simple, stupid for round 1, we'll get to the more interesting hierachical vector trees later)



------


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
- Cycle prevention - Reachability check: cycle prevention is a reachability check at mount-creation time — reject a mount O→D if D is reachable from O in the mount graph; this guarantees the mount graph is a DAG - iow - when creating a mount from origin O into destination D, walk O's transitive mount-graph and confirm D (and D's mount-ancestors) are not reachable from O. If D is reachable from O, mounting O into D closes a loop — reject.
- Nested mounts: Allow with configurable depth cap (lets say 2 as the default)
- Synapsd must expose the origin path of any resolved node
- All project and task metadata(timelines, milestones, deadlines, dates) live as the app concern in the layers `metadata` object, db does not care here

### Generic

- [] Ensure all batch methods are using the accompanied backend(LMDB/Lance) batch methods too whereever it makes sense
- [] Add backup/restore or dump/import functionality internally
- [] Add DB snapshot/restore option(on top of versioning? fetaures) to enable undo/redo ops || db op logs + traversal
LMDB copy/snapshot — mdb_copy (or the env .copy() API) gives a consistent point-in-time snapshot of the whole store without stopping writers. Wire it to a workspace.snapshot() that copies the data dir to a timestamped folder. Simplest possible "undo" net.

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

- `dataSchema` — zod schema for `data`, used for validate-on-write
- `indexOptions` — which fields to checksum / FTS / vector-embed
- `(de)serialization` — `toJSON` shape (round-trip)

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
- **App-registered**: contact, email, tab, note, todo, dotfile, application, message, device —
  definitions move to `canvas-server`, registered on startup.
- The `device/id/<id>` presence-bitmap derivation reads `locations` only and is fully
  schema-agnostic — it stays in the db and is untouched by this refactor (validates the seam).

**Cutover is migration-free.** Schema id strings (`data/abstraction/email`) are persisted in each
doc's `schema` field and in the `metadata.features` bitmap. Moving a class app-side changes only
*where the definition lives*, not the stored id strings or bitmaps — so no data migration, and old
and new can coexist during the move. Do it incrementally: register one abstraction app-side, delete
it from the builtin map, repeat.

**Cheap pre-work (independent, low-risk):** lift the provider factories
(`Email.fromIMAP`/`fromGraph`, `Message.fromSlack`/`fromTeams`/`fromIRC`) out of the schema classes
into the app ingest layer now — no registry change, no data change, removes the worst of the leak.

**Sequencing:** post-deployment. Not on the critical path for the current customer deploy
(roaming profiles / browser sync / dotfiles / imap+o365) — those use the existing abstractions
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

