# SynapsD

SynapsD is a small KV database built on top of `LMDB` with `roaring-bitmap` and `lancedb` based indexes, primarily used as an in-process index and, secondarily, as a JSON document store for [Canvas Workspaces](https://github.com/canvas-ui/canvas-server).

This module is meant to index all data from configured data sources of a Workspace (files, emails, notes, browser tabs, github repos, dotfiles etc), and provide a unified virtual fs-like tree abstraction on top that should ideally mimick whatever mental model you need to make work with your data more efficient.

## What it is good for

Everything below composes into a single query spec, which is the point of the whole design:

- **Membership** without a join: "files in `/work/customer-a`, tagged `finance`, not in staging" is a bitmap intersection, not a table scan.
- **Ranked retrieval** scoped by membership: BM25 full-text and dense-vector kNN fused (RRF), running only on documents that already survived the structural filter.
- **Time**, at any scale: "updated today", "due today", "Roman Empire, 27 BCE to 476 CE", "the Quaternary". Same filter grammar, from nanoseconds to gigayears, including open-ended ("still alive") intervals.
- **Space**: "photos within 5 km of here", "everything in this map viewport", as one range query over an S2 cell index.
- **Live views**: a query object that stays open and tells you the instant a newly ingested document enters or leaves the result set.
- **Zero-fetch probes**: counts, existence, and "any pending todos in here?" answered from bitmaps without loading a single document body.

A worked example of the composition: *the photos I took in Bratislava in summer 2023, that are not in staging, sorted by capture time, page 1 of 50* is one `list()` call, resolved from indexes, hydrating exactly 50 document bodies.

## Quick start

```js
import SynapsD from '@canvas/synapsd';

const db = new SynapsD({ path: '/path/to/db' });
await db.start();

const id = await db.put(
    { schema: 'data/abstraction/note', data: { title: 'Hello', content: 'First draft' } },
    { paths: ['ctx:/work/project-a'], features: ['tag/inbox'] },
);

const inbox = await db.list({ paths: ['ctx:/work/project-a'], features: ['tag/inbox'] });
const hits = await db.query('draft', { paths: ['ctx:/work/project-a'] });

await db.stop();
```

All examples below assume a started `db`.

## Core concepts

### Documents

A document is a JSON object with a `schema`, a `data` payload, and engine-managed `metadata`. `put()` returns a numeric document id, which is the identity used everywhere else. Checksums are first-class lookup keys, so content-addressed reads work without knowing the id.

Documents are stored once. Everything else (trees, features, timelines, coordinates) is *membership* layered on top, which is why one document can appear in many places at no storage cost.

### Trees

Trees are views on top of your documents. They organise membership and structure, not data. A single document can live in many trees at once. Every workspace database supports multiple named trees of two types.

**Context trees** are built on top of unique-by-name layers linked to bitmaps. Querying a path does a logical AND across the bitmaps of every layer along it:

- `ctx:/work/customer-a/devops/issues/issue-1001` resolves to all data linked to issue 1001.
- `ctx:/work/customer-a/devops/issues` resolves to all data linked to all indexed issues.
- `ctx:/issues` is an ad-hoc path showing all data related to all issues across all customers.

Because layers are unique by name and intersect, the tree gives you a natural "zoom": shorten the path to widen the result. Paired with session-based evolving queries, it becomes a way to fine-tune retrieval dynamically (query for "project emails", add thisWeek, add !today, add "dc migration", add "*.pdf").

Beyond FS-like tree methods, layers support:

- `merge layer`: merge a selected layer (bitmap) into 1-N additional layers.
- `subtract layer`: subtract a selected layer (bitmap) from 1-N additional layers.

**Directory trees** are the more familiar UX: unique folder nodes with filesystem-like semantics. A virtual directory is a self-contained movable/copyable container. Each directory owns its bitmap; recursive queries OR them.

### Features

Features are flat bitmap keys ticked on a document. They carry a `who says so?` convention in the prefix:

| Prefix | Who says so |
|--------|-------------|
| `data/*` | The document says so (derived: `data/abstraction/*` from schema, `data/mime/*` from contentType, `data/status/*` from `data.status`) |
| `feature/*` | The engine observed it (`feature/has-comment`) |
| `tag/*` | The user says so, free-form flat labels |
| `custom/<axis>/<value>` | The user says so, structured |

Derived facet bitmaps (mime, status) are re-ticked and stale-unticked on every write from document state, so they cannot drift. Completing a todo moves it from `data/status/pending` to `data/status/completed` atomically with the document write, so an agent's "any pending todos here?" is a zero-fetch bitmap probe.

### The query seam

Every read is two pure stages, and both are public:

```
resolveCandidates(spec) -> { bitmap, keys, collectionKeys, coarse }   // paths AND features AND filters
rank(bitmap, match, { mode, limit, offset })                          // match=null => slice; else fts/vector/hybrid

query(match, spec) = rank(resolveCandidates(spec).bitmap, match, spec)
list(spec)         = query(null, spec)
```

There is one candidate-set resolver and one ranker. `list`, `query`, `search`, `searchRefined`, and `QuerySession` are all entry points onto that same seam, which is why any filter documented below works in all of them.

`collectionKeys` are the actual bitmap keys consulted (`context/<treeId>/<layerId>`, `vfs/<treeId>/<nodeId>`, feature keys), so a live session can intersect them against `membership.changed` for precise invalidation. `coarse` marks a temporal (BSI-range) dependency that has no stable key.

## The query spec

One object shape drives every read. The three buckets intersect (`paths AND features AND filters`), and items within a bucket combine via the sigil algebra described below.

### Full reference example

Every field, in one spec. Nothing here is required; an empty spec `{}` lists everything.

```js
const page = await db.query('quarterly invoice', {
    // ---- WHERE: tree membership -------------------------------------------
    // String grammar targets the DEFAULT trees.
    // Positive entries OR together; only `!` (exclude) is honoured here.
    paths: [
        'ctx:/work/customer-a',      // in this context...
        'dir:/docs/contracts',       // ...OR in this directory
        '!ctx:/staging',             // excluded from the union
    ],
    // Object form, equivalent:
    // paths: { in: ['ctx:/work/customer-a', 'dir:/docs/contracts'], not: ['ctx:/staging'] },

    // Tree-qualified selectors: use when you need a NON-default tree.
    // `path` accepts a string or an array. NOTE: these join the SAME OR-union as
    // `paths` above, they do not intersect with it. Use one style per spec.
    context: { tree: 'projects', path: ['/work/project-a', '/work/shared'] },
    directory: { tree: 'filesystem', path: '/docs', recursive: true },

    // ---- WHAT: features ---------------------------------------------------
    features: [
        'data/abstraction/file',     // anyOf (OR within the bucket)
        '+tag/finance',              // allOf (required)
        '!tag/deleted',              // noneOf (excluded)
    ],
    // Object form, equivalent:
    // features: { allOf: ['tag/finance'], anyOf: ['data/abstraction/file'], noneOf: ['tag/deleted'] },

    // ---- WHEN / WHERE-ON-EARTH: filters -----------------------------------
    filters: [
        't:crud:updated:thisWeek',              // temporal, named timeframe
        '+t:content:2023-01-01..2023-12-31',    // temporal, explicit range
        'geo:near:48.1486,17.1077,5km',         // spatial, radius
        '!t:crud:created:today',                // excluded
        'custom/client/acme',                   // raw bitmap key (ANDed)
    ],

    // ---- HOW: ranking (ranked queries only) -------------------------------
    mode: 'hybrid',        // 'hybrid' (default) | 'fts' | 'vector'
    minDistance: 0,        // cosine floor for the dense leg (0 = identical)
    maxDistance: 0.9,      // cosine ceiling (2 = opposite); omit for no floor
    debug: false,          // attach result.debug.imageDistances for calibration

    // ---- PAGING / SHAPE ---------------------------------------------------
    limit: 50,             // list: 100, query: 50; 0 = all matches
    offset: 0,             // or `page: 1` (1-based, computed from limit)
    order: 'asc',          // 'asc' (default) | 'desc'
    sortBy: 'content',     // timeline name; LIST ONLY, ranked stays relevance-ordered
    parse: true,           // false => raw stored data, no document instances
});
```

Any of the read options (`mode`, `limit`, `offset`, `page`, `order`, `sortBy`, `parse`, `minDistance`, `maxDistance`, `debug`) may also be nested under an `options: { ... }` key. Top-level wins when both are present.

### Sigil algebra

| Sigil | Bucket | Meaning |
|-------|--------|---------|
| *(none)* | `anyOf` | OR within the bucket (default) |
| `+` | `allOf` | Required gate |
| `!` | `noneOf` | Exclude |

The three buckets intersect with each other (`paths AND features AND filters`), and within `features` and `filters` the algebra above applies in full.

**`paths` is the exception**: its positive entries always OR together, and `+` is accepted but has no effect. Only `!` is meaningful there. This follows from the tree model, where intersection is what a *path* already expresses (a context path ANDs the layers along it), so ANDing two separate paths is not a thing you ask for. To require membership in two independent places, use a feature gate or nest the path.

In the object form of `features`, a `!`-prefixed entry inside `allOf`/`anyOf` is sugar for `noneOf`.

### Field reference

| Field | Description |
|-------|-------------|
| `paths` | `['ctx:/a/b', 'dir:/x', '!ctx:/staging']` or `{ in, not }`. The `ctx:`/`dir:` grammar targets default trees; a bare path defaults to context. Positive entries OR; only `!` is honoured |
| `context` / `directory` | Tree-qualified selector `{ tree, path, recursive }`, for non-default trees. `path` takes a string or array. `recursive` (directory trees only) widens node-exact scoping to the whole subtree. Joins the same OR-union as `paths` |
| `features` | `['+tag/red', 'tag/blue', '!tag/spam']` or `{ allOf, anyOf, noneOf }` |
| `filters` | `['t:crud:updated:thisWeek', '+geo:bbox:...', '!t:crud:created:today']` (see filter grammar) |
| `mode` | `hybrid` (default), `fts`, or `vector`. Ranked queries only |
| `minDistance` / `maxDistance` | Cosine-distance window for the dense leg of `vector`/`hybrid`. Drops kNN neighbours outside `[min, max]` before fusion (`0` = identical, `2` = opposite). Omit for no floor. Keeps "nearest but irrelevant" hits out on a small or loose corpus |
| `limit` | Max documents (`list`: 100, `query`: 50; `0` = all matches) |
| `offset` / `page` | Pagination. `page` is 1-based and derived from `limit` |
| `order` | `asc` (default) or `desc`. Without `sortBy`, orders by id (insertion order); with `sortBy`, applies to the timeline value |
| `sortBy` | Timeline name to sort a listing by (`'content'`, `'crud:created'`; a `t:` prefix is tolerated). List only |
| `parse` | Set `false` to return raw stored data instead of document instances |
| `debug` | Attaches `result.debug.imageDistances` (unfloored image-kNN cosine distances, best-first) so you can calibrate the `imageMaxDistance` relevance floor from real numbers |

### Filter grammar

Filters share the sigil algebra and dispatch on a type prefix:

- **`t:<name>:<spec>`**, temporal. The reserved lifecycle form is `t:crud:<action>:<timeframe|range>` (`t:crud:updated:thisWeek`, `t:crud:created:2026-01-01..2026-05-10`). Content timelines use `t:<name>:<point|range>` (`t:wikipedia:1996`, `t:wikipedia:1996..1999`). Named timeframes (`today`, `thisWeek`, ...) resolve on *any* timeline, so `t:tasks:today` means "due today". Deep-time axes simply never match them.
- **`geo:<kind>:<args>`**, spatial (S2 index): `geo:bbox:minLat,minLon,maxLat,maxLon`, `geo:near:lat,lon,radius[m|km]`, `geo:cell:s2CellId[,...]`.
- **`g:<glob>`** and **`re:<regexp>`** are recognised but not yet implemented, and throw at parse time.

Anything without a recognised prefix is treated as a raw bitmap key and ANDed in.

### Result shape

Reads return an array of documents with metadata attached to it:

- `result.count`: number of documents in this page.
- `result.totalCount`: total matching documents, before pagination.
- `result.error`: error message string, or `null`.

Note that `list()` returns its error on the result rather than throwing; `query()` throws.

## CRUD API

The public read surface is `list()` and `query()`. Writes take `(document, spec)`, where the spec is the same object shape as above, restricted to its write-relevant fields.

### The write spec

```js
const noteSpec = {
    paths: ['ctx:/work/project-a'],              // ctx:/dir: grammar, default trees
    features: ['data/abstraction/note', 'tag/inbox'],
    emitEvent: true,                             // default; false suppresses events
    provenance: { origin: 'rule', causedBy: 'evt-parent', depth: 1 },
};

// Tree-qualified equivalent, for a non-default tree:
const projectTreeSpec = {
    context: { tree: 'projects', path: '/work/project-a' },
    features: ['data/abstraction/note'],
};
```

Write methods tick every feature you pass. Sigils are stripped on writes: the `paths` grammar is authoritative and derives both the context and directory selectors, so a directory-only write does not also touch `ctx:/`.

`provenance` rides on the emitted event so automation layers (workspace hooks and rules) can detect and bound their own cascades. Only `origin`, `causedBy`, and `depth` pass through; anything else is dropped. It defaults to `origin: 'user'`, `depth: 0`.

### Create

`put()` creates a new row when the document has no existing `id`, and returns the numeric document id.

```js
const id = await db.put(
    {
        schema: 'data/abstraction/note',
        data: { title: 'Hello', content: 'First draft' },
    },
    noteSpec,
);

const ids = await db.putMany(
    [
        { schema: 'data/abstraction/note', data: { title: 'A', content: 'Alpha' } },
        { schema: 'data/abstraction/note', data: { title: 'B', content: 'Beta' } },
    ],
    {
        context: { tree: 'projects', path: ['/work/project-a', '/work/shared'] },
        features: ['data/abstraction/note'],
    },
);
```

### Read

`get()` and `getByChecksumString()` return a parsed document instance by default. Pass `{ parse: false }` for raw stored data. Tree-aware membership checks use `has()` and `hasByChecksumString()`, which answer from bitmaps without loading the document.

```js
const doc = await db.get(id);
const rawDoc = await db.get(id, { parse: false });
const docByChecksum = await db.getByChecksumString('sha256:...');

// Existence probes, no document fetched
const existsAnywhere = await db.has(id);
const existsInProjectsTree = await db.has(id, { context: { tree: 'projects', path: '/work/project-a' } });
const existsWithInboxFeature = await db.has(id, { paths: ['ctx:/work/project-a'], features: ['tag/inbox'] });

const checksumExistsInProject = await db.hasByChecksumString(
    'sha256:...',
    { context: { tree: 'projects', path: '/work/project-a' } },
);

// Where does this document live?
await db.listDocumentTreePaths(id, 'projects');
await db.listDocumentTreeMemberships(id, 'projects');
await db.hasDocumentTreeMembership(id, 'projects');
await db.getBitmapsForDocument(id);
```

Structural and ranked listing use `list(spec)` and `query(match, spec)`; see **Querying** below.

### Update

`put()` updates when `document.id` already exists.

`put({ id, data })` **replaces** `data`; it does not deep-merge fields. To change a single field, read the document first and send the full updated `data` object. To change only memberships, use `link()` / `unlink()` instead, which never touch `data`.

```js
const current = await db.get(id);

await db.put(
    {
        id,
        schema: current.schema,
        data: { ...current.data, title: 'Updated title' },
        metadata: current.metadata,
    },
    noteSpec,
);
```

### Link and unlink

`link()` adds memberships and features. `unlink()` removes them. Neither touches the document body, and `unlink()` never deletes the document.

```js
await db.link(id, {
    context: { tree: 'projects', path: '/work/project-a' },
    features: ['tag/reviewed'],
});

await db.link(id, {
    directory: { tree: 'filesystem', path: ['/notes', '/archive/notes'] },
    features: ['tag/filed'],
});

await db.unlink(id, {
    context: { tree: 'projects', path: '/work/project-a/deep' },
    features: ['tag/inbox'],
});

// Recursive: also drop the subtree below the path
await db.unlink(id, { context: { tree: 'projects', path: '/work/project-a/deep' }, recursive: true });

await db.unlink(id, { directory: { tree: 'incoming', path: '/' } });

const linkResult = await db.linkMany([id1, id2], {
    context: { tree: 'projects', path: '/work/project-a' },
    features: ['tag/reviewed'],
});
const unlinkResult = await db.unlinkMany([id1, id2], {
    context: { tree: 'projects', path: '/work/project-a' },
    features: ['tag/inbox'],
});
```

Context-tree root `/` is a selector meaning "anything in this tree", not a real removable membership. Directory-tree root `/` is just the literal root folder.

### Delete

`delete()` removes the document row, checksum index entries, timeline index entries, and synapse memberships. It returns `true` when a document was deleted, `false` when the id was not found.

```js
const deleted = await db.delete(id);
await db.delete(id, { emitEvent: false });

const deleteResult = await db.deleteMany([id1, id2]);
```

`unlinkMany()` and `deleteMany()` return `{ successful, failed, count }`. Batch delete and unlink ids must be numbers: numeric strings are accepted by `get()` and `put()` but rejected by the batch helpers.

## Querying

### `list(spec)`: structural listing

Equivalent to `query(null, spec)`. Returns documents matching the candidate set (tree membership, features, timeline and bitmap filters) in insertion order, with no ranking. With no buckets, `list` returns every document. Default limit is 100; pass `limit: 0` to return all matches.

```js
// All files in a path, excluding deleted, updated today
const docs = await db.list({
    paths: ['ctx:/foo/bar'],
    features: { allOf: ['data/abstraction/file'], noneOf: ['tag/deleted'] },
    filters: ['t:crud:updated:today'],
    limit: 100,
});

// Directory tree, multiple paths (non-default tree, so use the selector)
const exactDirectoryMatches = await db.list({
    directory: { tree: 'filesystem', path: ['/docs/contracts', '/docs/invoices'] },
    features: ['data/abstraction/file'],
});

// Everything except a staging context
const withoutStaging = await db.list({
    paths: ['!ctx:/staging'],
    features: ['data/abstraction/file'],
});

// Zero-fetch facet probe: any pending todos here?
const pending = await db.list({
    features: ['data/abstraction/todo'],
    filters: ['data/status/pending'],
});
```

### `query(match, spec)` and `search(spec)`: ranked retrieval

`match` is a string (or `{ text }`). The candidate set scopes a full-text/vector search (LanceDB), ranked by relevance. `search(spec)` is a thin wrapper that pulls `match` from `spec.query` (`spec.search` and `spec.q` are also accepted). Default limit is 50. `mode` selects `hybrid` (default), `fts`, or `vector`; vector and hybrid fall back to `fts` when the dense stack is down.

```js
// Ranked full-text within a scoped path
const ranked = await db.query('invoice', {
    paths: ['ctx:/finance/2026'],
    features: ['data/abstraction/file', 'tag/finance'],
    limit: 20,
});

// Same thing via the back-compat wrapper
const same = await db.search({
    query: 'invoice',
    paths: ['ctx:/finance/2026'],
    limit: 20,
});
```

### Sorting by a timeline

`list()` can order its result by any timeline's values instead of insertion order, which is the difference between "photos in upload order" and "photos in the order they were taken".

```js
// A 1300-photo gallery, chronological by EXIF capture date, 50 per page.
// Sorting happens on the id set BEFORE pagination, so page 1 is already in order.
const page = await db.list({
    paths: ['ctx:/house-build'],
    features: ['data/abstraction/file'],
    sortBy: 'content',
    order: 'asc',
    limit: 50,
    offset: 0,
});

// Composes with timeline range filters: 2023 only, newest first.
const y2023 = await db.list({
    filters: ['t:content:2023-01-01..2023-12-31'],
    sortBy: 'content',
    order: 'desc',
});
```

Semantics:

- `sortBy` accepts a timeline name (`'content'`, `'crud:created'`, `'wikipedia'`); a `t:` prefix is tolerated. `order` applies to the timeline value, and ties break by id.
- Interval timelines sort by their **start**; point timelines by the instant.
- Documents with **no value** on the timeline always trail the sorted ones (in id order), so a photo without EXIF ends up at the end and never pollutes the sequence.
- List only: ranked (`query` / `search`) results keep relevance order.
- Over HTTP: `?sortBy=content&order=asc` on the workspace/context document list and `by-abstraction` endpoints.

**Mechanics and cost.** Sort keys come straight out of the timeline's bit-sliced index: each of the 64 slice bitmaps is ANDed against the candidate set once (`BitSlicedIndex.getValues`), reconstructing every candidate's value in a single pass, with no per-document probing and no document bodies fetched outside the requested page. Values from different scale tiers are normalized to one comparable key (period start for coarse tiers), finest tier wins. Measured on a laptop: key extraction plus sort is about **4 ms for 1 300 docs** and **37 ms for 20 000**, scaling linearly (~2 us/doc). Memory-wise a fully populated second-scale tier over 20 k docs is ~100 roaring bitmaps totalling **under 1 MB** serialized. The sort reads existing index state and allocates nothing beyond the key map.

## Refining a query over time

Two ways to narrow a candidate set incrementally, both built on the same `resolveCandidates` + `rank` seam.

### Long-running sessions

`openSession()` returns a stateful, refinable query whose candidate set outlives a single question. A session is an ordered map of **cues** (labelled sub-specs); the combined result is the hard-AND of cue bitmaps. It is cheap to probe (`count()` / `ids()` load no documents) and cheap to refine (each cue is resolved once and cached).

```js
const s = await db.openSession([], { mode: 'live', emit: 'delta' });
await s.add({ features: ['tag/important'] }, 'important');
await s.add({ context: { tree: 'projects', path: '/inbox' } }, 'inbox');

s.count();                                  // survivors, no document load
s.ids();                                    // combined id array (null = unconstrained)
await s.materialize(null, { limit: 20 });   // page the set (a string match ranks it)

// Live view: fires the instant an ingested document matches, or stops matching.
const off = s.on('change', ({ added, removed, count }) => updateCanvas(added, removed, count));

await s.patch('inbox', { features: ['+tag/urgent'] });   // refine one cue
await s.remove('important');                             // widen
off();
s.close();
```

- **Emit modes**: `delta` (default, `{ added, removed, count }`), `ids`, `page`.
- **Modes**: `frozen` (default) freezes relative timeframes at `add()` and never slides, giving a stable snapshot suitable for agent working memory. `live` re-resolves temporal cues on each recompute (sliding windows) and pushes `change` events.
- **Precise invalidation**: a write only re-evaluates cues whose `collectionKeys` it touched. Temporal cues are `coarse`, so they re-resolve on any relevant write.
- **Lifecycle**: `serialize()` produces tiny JSON (specs and labels, no bitmaps); `QuerySession.rehydrate(db, json)` rebuilds it, re-resolving on first read.

The live path is driven by the `membership.changed` event, which is emitted post-commit and carries the exact ticked collection keys. See **Events**.

### Stateless refinement: `searchRefined`

For ad-hoc drill-down without a session object, fold a stack of text queries: each one AND-narrows the previous result set across FTS and the image-vector space (so photos refine too), and the last one ranks. An optional `baseSpec` supplies the structured starting scope.

```js
// "car", then within those "red", then within those "market"; ranked by "market".
const page = await db.searchRefined(
    ['car', 'red', 'market'],
    { context: { tree: 'projects', path: '/inbox' }, features: ['data/abstraction/email'] },
    { limit: 20 },
);
```

Zero or one query degrades to a plain list or single search. The web UI exposes this as stacked search chips (`?q=car&q=red`); the REST `GET .../documents?q=` param accepts a repeated `q` for the same effect.

## Semantic search (vectors)

`query()` defaults to `mode: 'hybrid'`: dense-vector kNN fused with BM25 via RRF. The candidate bitmap (`paths AND features AND filters`) still scopes retrieval first, and ranking runs only on survivors. `vector` and `hybrid` degrade to `fts` when the dense stack is unavailable, and `list()` (`match = null`) never embeds.

Dense vectors live in a LanceDB `vec_text` table at chunk granularity (one row per `(docId, chunkId)`). Coverage is tracked by the `internal/lance/vectors` bitmap.

### What gets embedded

Only schemas in `embeddableSchemas` (default `['data/abstraction/note']`) are embedded by the server. For those, it reads the schema's `vectorEmbeddingFields`, chunks the text, and embeds the chunks. Everything else is FTS-only unless the app ships its own vectors.

Files (`data/abstraction/file`) are **not** embedded: a file document carries only `locationUrls` (the `stored://` blob refs), not content. To make text searchable by vector, ingest it as a `note` or `document` (which hold inline `data`), not as a blob.

### How it runs

- **Model**: local in-process ONNX via `fastembed`, `bge-small-en-v1.5` (384-dim). The worker thread is spawned lazily on first embed or query; the model is cached under `<root>/lance/models` (first use downloads ~130 MB).
- **Async and resumable**: `put` / `putMany` enqueue embeddable documents and the `EmbeddingQueue` embeds them off the main thread. The presence bitmap lets it skip already-embedded documents, and `start()` backfills the unfinished tail after a crash or restart.
- **Query time**: the query string is embedded once, then vector/hybrid searched.

### App-provided vectors

For blobs and media the server cannot read, compute vectors in the app and store them directly, bypassing the queue:

```js
await db.storeDocumentEmbeddings(docId, schema, updatedAt, [
    { chunkId: 0, text: 'caption or transcript', vector: [/* dim floats */] },
]);
```

### Config and introspection

Semantic options are passed at construction (Workspace uses the defaults):

```js
const db = new SynapsD({
    path: '...',
    semantic: {
        enabled: true,                              // false => fts-only, no worker
        model: 'bge-small-en-v1.5',
        dim: 384,                                   // must match the model
        maxLength: 512,
        cacheDir: '/path/to/models',                // default <root>/lance/models
        embeddableSchemas: ['data/abstraction/note'],
    },
});
```

| Option (`semantic.*`) | Default | Role |
|-----------------------|---------|------|
| `enabled` | `true` | Spin up the dense stack; `false` is FTS-only |
| `model` | `bge-small-en-v1.5` | fastembed model id |
| `dim` | `384` | Vector dimension (must match the model) |
| `maxLength` | `512` | Max tokens per chunk passed to the model |
| `cacheDir` | `<root>/lance/models` | On-disk model store |
| `embeddableSchemas` | `['data/abstraction/note']` | Schemas the server embeds |
| `imageMaxDistance` | `0.945` | Cosine floor for the image kNN leg |

`setSearchTuning({ imageMaxDistance, searchWeights })` adjusts the image floor and the fts/dense/image fusion weights at runtime. `await db.getStats()` returns a `.semantic` block (`model`, `dim`, `embeddableSchemas`, plus `vector`, `embedder`, and `queue` sub-status) for diagnostics UIs.

## Timelines and intervals

SynapsD supports source/domain timelines (`wikipedia`, `britannica`, `historian-x`, `crud:updated`) backed by internal scale tiers. The developer-facing name stays simple; internally each timeline owns lazy per-scale tiers for `Gyr`, `Myr`, `Kyr`, `year`, `month`, `day`, `second`, `ms`, and `ns`.

Each stored interval is normalized to `{ scale, start, end }`. If you omit `scale`, SynapsD infers it from the input and errors when it cannot do that safely. Inference is a convenience at the API edge; the index core always stores an explicit scale. No fake precision. Dinosaurs did not have millisecond timestamps, despite what software would like to believe.

### Storage modes: interval vs point-event

A tier is stored one of two ways:

- **Interval (Dual-BSI)**: two bit-sliced indexes per tier (`start` and `end`). Used for ranges that genuinely span time (`wikipedia` 1720 to 1750, geology eras). Overlap query: `start <= range.end AND end >= range.start`.
- **Point-event (single-BSI)**: one bit-sliced index per tier (`ts`). Used for **instants** (a thing happened at a moment). For an instant `start === end`, so the interval model's `end` BSI is pure duplication. The point tier halves the slice bitmaps *and* the per-insert slice writes. Range query: `ts >= range.start AND ts <= range.end`. The BSI's existence bitmap (`ebm`) doubles as the "which ids have this event" presence set, so no separate membership bitmap is needed.

A timeline is point-mode when its name is a `crud:*` lifecycle stamp (by convention) or is registered explicitly:

```js
// Register extra point-event timelines at construction.
const timeline = new TimelineIndex(bitmapIndex, { pointTimelines: ['visited', 'opened'] });
```

The mode is deterministic from the name, so it is stable across restarts without persisting a flag. Queries are identical regardless of mode: `queryInterval(...)` works the same, it just reads one BSI instead of two for point timelines. Existing interval timelines are unaffected.

### Open (unbounded) intervals

Interval timelines support open ends for things that started but have not finished: a person's life, an ongoing subscription, an unended era. Use the object form with an open marker:

```js
// Born 1912-12-12, still alive.
await db.timeline.insert('life', personId, { start: '1912-12-12', end: Infinity });

// Open lower bound: "everything up to 2000".
await db.timeline.insert('until', id, { start: -Infinity, end: '2000' });
```

Accepted open markers: `Infinity` / `-Infinity`, or the strings `'inf'`, `'+inf'`, `'infinity'`, `'ongoing'`, `'present'` (upper) and `'-inf'`, `'-infinity'` (lower). The scale comes from the bounded endpoint; the open side is stored as a BSI extreme sentinel, so the normal overlap test (`end >= range.start`, `start <= range.end`) extends to positive and negative infinity with no special query path. A query like "alive in 2026" (`{ start: '2026', end: '2026' }`) matches every still-open life automatically.

> For **inserts**, use the **object form** (`{ start, end }`) for open intervals. Open markers are not supported in the positional `insert(name, id, start, end)` form, where an omitted end means "instant" (so crud stamps stay points).

**Open-ended queries.** On `queryInterval`, a `null` or omitted bound means open on that side, which is handy for "from X onwards" and "up to Y":

```js
await db.timeline.queryInterval('life', '1990');         // [1990, +inf): still active at/after 1990
await db.timeline.queryInterval('life', null, '2000');   // (-inf, 2000]: had started by 2000
await db.timeline.queryInterval('life', '2008', '2008'); // bounded point: active in 2008
```

The filter layer always passes explicit start and end, so `t:` timeline filters are unaffected.

### Multi-timeline retrieval: `mode: 'grouped'` (zeitgeist)

`queryInterval` takes one or more timeline names and a query `mode`:

- `union` (default): one flat id array across all timelines and scales.
- `layers`: `{ name: { scale: [ids] } }`, per timeline *and* per scale.
- `grouped`: `{ name: [ids] }`, per timeline with scales pre-unioned.

`grouped` is the one-call primitive for "what was the world like at instant X": pick a point and fan it across every relevant timeline at once. Because queries span all scale tiers, a single instant matches a king's reign stored at `year` *and* the geological era stored at `Myr` in the same call. Open-ended ("ongoing") intervals match naturally.

```js
// Zeitgeist of the year 600: one id list per timeline.
const z = await db.timeline.queryInterval(
    ['wikipedia', 'historian-foo', 'geology', 'climate'],
    { start: '600', end: '600' },   // the instant
    { mode: 'grouped' },
);
// {
//   wikipedia:       [periodId, ...],   // "Early Middle Ages" (500-800)
//   'historian-foo': [kingId, ...],     // rulers alive in 600, incl. open-ended dynasties
//   geology:         [eraId],           // Quaternary (-2 Myr to ongoing), NOT Paleozoic
//   climate:         [],                // requested but nothing indexed
// }
```

Every requested timeline is present in the result (empty as `[]`). Scale precision is intentional: year 600 converts to ~0 `Myr`, so it lands "in the Quaternary". The `Myr` tier distinguishes eras, the `year` tier distinguishes centuries. Composing the per-timeline ids into a single narrative object is left to the caller; `grouped` just hands you the buckets.

Canonical calendar and time semantics:

- Calendar dates use the proleptic Gregorian calendar internally.
- Year numbering is astronomical internally (`0` = 1 BCE, `-1` = 2 BCE). Importers and UI can translate BCE/CE for humans.
- Modern instants are treated as UTC-ish civil time.
- Leap seconds are ignored. This is a personal/workspace event database, not a spacecraft.
- Deep-time values should use scaled coordinates (`Gyr`, `Myr`, `Kyr`) instead of calendar dates.

### System CRUD timelines

Document lifecycle events are automatically indexed into `crud:created`, `crud:updated`, and `crud:deleted` timelines. These are **point-event** timelines (instants, single-BSI) pinned to **second** resolution: ms precision on a wall-clock lifecycle stamp is spurious and only widens the BSI. Filter with `t:` strings in the `filters` array.

Formats:

- `t:crud:ACTION:TIMEFRAME`, for example `t:crud:updated:thisWeek`
- `t:crud:ACTION:START..END`, for example `t:crud:created:2026-01-01..2026-05-10`

Supported timeframe tokens: `now` (current hour), `today`, `yesterday`, `tomorrow`, `lastWeek`, `thisWeek`, `nextWeek`, `lastMonth`, `thisMonth`, `nextMonth`, `lastYear`, `thisYear`, `nextYear`, `lastDecade`, `thisDecade`, `nextDecade`, `lastCentury`, `thisCentury`, `nextCentury`, `lastMillennium`, `thisMillennium`, `nextMillennium`.

```js
// allOf gate: created this week AND updated today
const recentDocs = await db.list({
    paths: ['ctx:/projects'],
    filters: ['+t:crud:created:thisWeek', '+t:crud:updated:today'],
});
```

Timeframe queries fan out across the internal tiers, so `today`, `thisWeek`, and explicit ranges find matching CRUD events regardless of the tier they were written to.

#### Reindexing crud timelines

The crud timelines moved from interval/ms (dual-BSI) to point-event/second (single-BSI) storage. A database populated **before** that change has crud memberships in tiers the new code never reads, so `t:crud:*` filters return nothing for those documents until the timelines are rebuilt. Run the one-time, idempotent rebuild, which deletes the stale crud bitmaps and re-derives `crud:created` / `crud:updated` from each document's `createdAt` / `updatedAt`:

```sh
# Per workspace DB directory (e.g. server/users/<user>/workspaces/<ws>/db)
node scripts/reindex-crud.js -d <workspace-db-dir>
```

Or programmatically, `await db.reindexCrudTimelines()`. Note that `crud:deleted` is not rebuilt, since those documents are gone, so past deletion history is dropped.

### Custom timelines

Two reserved content-timeline conventions sit on top of the machinery below:

- **`content`**: when the content itself came into existence (EXIF capture date for photos; written by stored ingest and embed-time extraction).
- **`tasks`**: Todo due dates (point-mode, derived from `data.dueDate` by the Todo schema). `t:tasks:today` means "due today", and `sortBy: 'tasks'` orders by due date.

Use `db.timeline` for custom source/domain timelines.

```js
await db.timeline.createTimeline('wikipedia');
await db.timeline.createTimeline('britannica');

const wikiEventId = await db.put({ schema: 'event', data: { title: 'Fall of Rome' } });
const britEventId = await db.put({ schema: 'event', data: { title: 'Roman Empire collapses' } });

// Scale inferred as day.
await db.timeline.insert('wikipedia', wikiEventId, { start: '0476-01-01', end: '0476-12-31' });

// Scale inferred as second.
await db.timeline.insert('britannica', britEventId, {
    start: '0476-09-04T00:00:00Z',
    end: '0476-09-04T23:59:59Z',
});
```

Supported inference examples:

```js
await db.timeline.insert('wikipedia', id, { start: '1720', end: '1720' });              // year
await db.timeline.insert('wikipedia', id, { start: '17200101', end: '17201231' });      // day
await db.timeline.insert('wikipedia', id, { start: '1720-01', end: '1720-12' });        // month
await db.timeline.insert('wikipedia', id, { start: '1720-01-01', end: '1720-12-31' });  // day
await db.timeline.insert('wikipedia', id, { start: '1720-01-01T00:00:00Z' });           // second
await db.timeline.insert('wikipedia', id, { start: '1720-01-01T00:00:00.123Z' });       // ms
await db.timeline.insert('wikipedia', id, { start: '541 MYA', end: '252 MYA' });        // Myr
```

Use explicit scale when the input is ambiguous or already normalized:

```js
await db.timeline.insert('wikipedia', paleozoicId, {
    start: { scale: 'Myr', value: -541n },
    end: { scale: 'Myr', value: -252n },
});
```

Documents can also carry app-extracted timeline entries at the root. SynapsD indexes these on `put()` / `putMany()` and refreshes them on update. The database does not extract dates from content; ingestion and app code own that.

```js
const articleId = await db.put({
    schema: 'data/abstraction/document',
    data: {
        title: 'Magna Carta',
        text: 'Magna Carta was agreed at Runnymede in 1215.',
    },
    timelines: [
        { name: 'wikipedia', start: '1215', end: '1215' },
    ],
});

// For a precise event, use one entry at the appropriate scale.
const signingEventId = await db.put({
    schema: 'data/abstraction/document',
    data: {
        title: 'Magna Carta sealed',
        text: 'King John sealed Magna Carta on 1215-06-15.',
    },
    timelines: [
        { name: 'wikipedia', start: '1215-06-15' },
    ],
});
```

`name` is the source/domain timeline, and `timeline` is accepted as an alias. `scale` is optional at the API edge and inferred when safe; internally every entry is stored with explicit scale. On document update, SynapsD removes the document from timelines declared on the old or new document, then indexes the new entries. Manually-added timeline entries that are not declared on the document are left alone.

Queries fan out across the relevant internal tiers by default:

```js
// "What overlaps the year 476?"
const wikiMatches = await db.timeline.queryInterval('wikipedia', { start: '0476', end: '0476' });

// Same query across multiple source timelines, deduped as one id array.
const ids = await db.timeline.queryInterval(['wikipedia', 'britannica'], {
    start: '0476-09-04',
    end: '0476-09-04',
});

// Search every known timeline. `all` is also accepted.
const happenedIn1215 = await db.timeline.queryInterval('*', { start: '1215', end: '1215' });

// Preserve layer/tier structure for UI overlays.
const layers = await db.timeline.queryInterval(
    ['wikipedia', 'britannica'],
    { start: '0476', end: '0476' },
    { mode: 'layers' },
);
```

Layer mode returns ids grouped by source timeline and internal scale tier:

```js
{
    wikipedia: { day: [12, 18], second: [44] },
    britannica: { day: [21] },
}
```

Timeline management:

```js
await db.timeline.createTimeline('wikipedia');
const timelines = await db.timeline.listTimelines();
const exists = db.timeline.hasTimeline('wikipedia');
await db.timeline.deleteTimeline('wikipedia');
```

Intervals are closed `[start, end]` and may be open-ended. See **Open (unbounded) intervals** above.

## Spatial index (S2)

Documents with GPS coordinates (`metadata.geo.lat` / `metadata.geo.lon`, populated by stored-ingest or embed-time EXIF extraction) are indexed into a single bit-sliced index over their **S2 cell id** at level 21 (~5 m, since GPS accuracy is 3 to 10 m and finer would be fake precision). This is fully derived state: coordinates appear and it is indexed; coordinates are removed or the document is deleted and it is dropped.

The trick that keeps this one BSI instead of a per-cell bitmap zoo: S2 ids are hierarchical, so every ancestor cell covers one **contiguous id range** of its descendants. "In cell X" at any zoom level is a single `BETWEEN` range query. A region query (map viewport, radius) runs the S2 region coverer (up to 20 cells) and ORs the per-cell ranges. Bitmap population is fixed at the slice width (~65) regardless of data density, precision, or query zoom.

```js
// Map viewport (bbox), composed with anything else:
const inView = await db.list({
    features: ['data/abstraction/file'],
    filters: ['geo:bbox:47.5,15.5,48.8,17.8', 't:content:2023-01-01..2023-12-31'],
    sortBy: 'content',
});

// Radius ("within 5 km of here"), sigils apply:
const nearby = await db.list({ filters: ['+geo:near:48.1486,17.1077,5km', '!tag/private'] });

// Programmatic (returns RoaringBitmap32):
await db.geo.queryBBox(minLat, minLon, maxLat, maxLon);
await db.geo.queryRadius(lat, lon, radiusMeters);
await db.geo.queryCells([cellId, ...]);
```

Candidate-set semantics are deliberately lossy: coverings may slightly overshoot the region boundary. Precise containment (and rendering) is the client's job via the raw `metadata.geo` coordinates. The index never reproduces coordinates.

## Bitmap index

Roaring bitmaps back every membership lookup. Keys use typed prefixes, validated in `indexes/bitmaps/lib/keys.js`:

| Prefix | Role |
|--------|------|
| `context/<treeId>/<layerUlid>` | Context-tree layer membership |
| `vfs/<treeId>/...` | Directory-tree folder membership |
| `tag/`, `data/`, `device/`, `custom/`, ... | Feature/schema filters (also usable in query `filters`) |
| `internal/...` | Engine-managed indexes, hidden from default listings |

See **Features** above for the prefix conventions.

Notable `internal/*` keys:

- `internal/ts/<timeline>/<scale>/start|end`: timeline BSI tiers
- `internal/geo/s2/*`: spatial S2 cell-id BSI slices
- `internal/lance/fts`, `internal/lance/vectors`: Lance search index coverage
- `internal/gc/deleted`: soft-deleted document set

### Introspection (`db.bitmapIndex`)

```js
// User-facing bitmaps only (default, omits internal/*)
const keys = await db.bitmapIndex.listBitmaps();

// All keys, including engine-managed internal/*
const allKeys = await db.bitmapIndex.listBitmaps('', { includeInternal: true });

// Prefix scan (internal/* included when the prefix matches)
const timelineKeys = await db.bitmapIndex.listBitmaps('internal/ts');
const treeLayers = await db.bitmapIndex.listBitmaps(`context/${treeId}`);
```

`listBitmaps(prefix, { includeInternal })` behavior:

- **No prefix**: all keys except `internal/*`, unless `includeInternal: true`.
- **With prefix**: range scan under that prefix, with no extra `internal/*` filtering.

Load a bitmap with `getBitmap(key)`, which returns a `Bitmap` instance with `size`, `has(id)`, `toArray()`, and friends. Find which bitmaps contain a document via `getBitmapsForDocument(id, prefix?)` on the main `db` object (this also omits `internal/*` when `prefix` is empty).

REST equivalent: `GET /rest/v2/workspaces/:id/bitmaps?includeInternal=true` (the workspace must be started). See the project `docs/API.md` for `includeData`, prefix paths, raw `.roar` download, and delete protections.

## Trees

### Tree management

```js
const meta = await db.createTree('projects', 'context');
const fsMeta = await db.createTree('filesystem', 'directory');

const trees = await db.listTrees();                  // all trees
const contextTrees = await db.listTrees('context');  // filtered by type

const tree = db.getTree('projects');                 // by name or id
const defaultCtx = db.getDefaultContextTree();
const defaultDir = db.getDefaultDirectoryTree();

await db.renameTree('projects', 'workspaces');
await db.deleteTree('workspaces');
```

### Tree introspection

```js
db.getTreePaths('filesystem');
// ['/', '/docs', '/docs/contracts', '/docs/invoices', '/archive']

db.getTreeJson('projects');
// { id, type, name, children: [{ id, type, name, children: [...] }, ...] }
```

### Staging pattern (consumer convention)

SynapsD has no built-in concept of "incoming" or "staging". If your app needs a staging area, create a dedicated tree and use the standard `link` / `unlink` API to promote documents:

```js
await db.createTree('incoming', 'directory');

const id = await db.put(
    {
        schema: 'data/abstraction/email',
        data: { subject: 'Invoice', from: 'billing@example.com' },
    },
    { directory: { tree: 'incoming', path: '/email/imap/account-a/inbox' } },
);

// Promote into a user tree, then remove from staging
await db.link(id, { context: { tree: 'projects', path: '/finance/invoices' }, features: ['tag/triaged'] });
await db.unlink(id, { directory: { tree: 'incoming', path: '/email/imap/account-a/inbox' } });

// Exclude a staging context from broad queries
const docs = await db.list({ paths: ['!ctx:/staging'] });
```

Tree metadata lives in the internal store, while tree memberships are mapped to typed bitmap namespaces.

## Events (`src/utils/events.js`)

All `emit()` paths use the frozen `EVENTS` map. Rename a constant there to rename the string everywhere consumers match on.

Canonical strings, with the `EVENTS` constant in parentheses:

**Lifecycle**: `started` (`STARTED`), `beforeShutdown` (`BEFORE_SHUTDOWN`), `shutdown` (`SHUTDOWN`)

**Document CRUD**:

- `document.inserted` (`DOCUMENT_INSERTED`)
- `document.updated` (`DOCUMENT_UPDATED`)
- `document.removed` (`DOCUMENT_REMOVED`)
- `document.deleted` (`DOCUMENT_DELETED`)
- `document.removed.batch` (`DOCUMENT_REMOVED_BATCH`), one event for a bulk remove, avoiding N emits
- `document.deleted.batch` (`DOCUMENT_DELETED_BATCH`), one event for a bulk delete/purge

**Membership**:

- `membership.changed` (`MEMBERSHIP_CHANGED`), emitted post-commit with the exact collection bitmap keys ticked or unticked: `{ changes: [{ docId, op: 'tick'|'untick', keys }] }`. Drives precise live invalidation in `QuerySession` (intersect against an operand's `collectionKeys`). Fires before the corresponding `document.*` event, so a session re-resolves against already-committed bitmaps.

**Tree management**: `tree.created` (`TREE_CREATED`), `tree.deleted` (`TREE_DELETED`), `tree.renamed` (`TREE_RENAMED`)

**Tree path (structural)**: `tree.path.inserted`, `tree.path.moved`, `tree.path.copied`, `tree.path.removed`, `tree.path.locked`, `tree.path.unlocked`

**Tree layer**: `tree.layer.merged` (`TREE_LAYER_MERGED`), `tree.layer.subtracted` (`TREE_LAYER_SUBTRACTED`)

**Tree document**: `tree.document.inserted`, `tree.document.inserted.batch`, `tree.document.removed`, `tree.document.removed.batch`, `tree.document.deleted`, `tree.document.deleted.batch`

**Tree lifecycle**: `tree.recalculated`, `tree.saved`, `tree.loaded`, `tree.error`

Payloads are wrapped with `SynapsDEvent` (or the helpers `createEvent` / `createTreeEvent`). The envelope always carries `event`, `eventId` (unique per emit, usable as an idempotency key), `source` (`db`, `tree`, or caller), an ISO `timestamp`, and optional `treeId`, `treeName`, `treeType`. Remaining keys come from the detail object without clobbering those fields. `createTreeEvent` fills tree metadata from a tree object and sets `source` to `tree`.

Writes carry caller-supplied `provenance` through to the emitted event, so automation layers can detect and bound their own cascades. See **The write spec**.

## Errors (`src/utils/errors.js`)

`SynapsDError` is the base class (correct `name`, captured stack). Specialized types:

| Class | Extra fields |
|-------|--------------|
| `ValidationError` | `details` |
| `NotFoundError` | `id` |
| `DuplicateError` | `id` |
| `DatabaseError` | `operation` |
| `ArgumentError` | `argument` |

## API reference

Legacy method names like `findDocuments`, `ftsQuery`, `insertDocument`, and friends are no longer the intended API and should be treated as dead.

### Reads

| Method | Notes |
|--------|-------|
| `get(id, options?)` | `options = { parse }` |
| `query(match, spec?)` | `match: string \| { text }`; ranked when `match` is set |
| `list(spec?)` | Equals `query(null, spec)`; structural listing, no ranking |
| `search(spec)` | Back-compat wrapper: `query(spec.query, spec)` |
| `searchRefined(queries[], baseSpec?, opts?)` | Stateless multi-query refinement; `opts = { limit, offset, mode }` |
| `openSession(specs?, opts?)` | Long-running refinable/live query session |
| `getByChecksumString(checksum, options?)` | |
| `has(id, spec?)` | Membership probe, no document fetch |
| `hasByChecksumString(checksum, spec?)` | |
| `resolveCandidates(spec)` | Candidate-set stage: `{ bitmap, keys, collectionKeys, coarse }` |
| `rank(bitmap, match, opts?)` | Materialize/score stage: `{ mode, limit, offset, debug }` |

### Writes

| Method | Notes |
|--------|-------|
| `put(document, spec?)` | Creates or updates; returns the numeric id |
| `putMany(documents, spec?)` | |
| `link(idOrIds, spec?)` / `linkMany(ids, spec?)` | Membership only |
| `unlink(idOrIds, spec?)` / `unlinkMany(ids, spec?)` | Membership only; document stays |
| `delete(id, options?)` / `deleteMany(ids, options?)` | Removes the document row and all index entries |

### Trees

`createTree(name, type?, options?)`, `listTrees(type?)`, `getTree(nameOrId)`, `deleteTree(nameOrId)`, `renameTree(nameOrId, newName)`, `getTreePaths(nameOrId)`, `getTreeJson(nameOrId)`, `getDefaultContextTree()`, `getDefaultDirectoryTree()`, `listDocumentTreePaths(id, treeNameOrId)`, `listDocumentTreeMemberships(id, treeNameOrId)`, `hasDocumentTreeMembership(id, treeNameOrId)`

### Maintenance and introspection

| Method | Notes |
|--------|-------|
| `getStats()` | Async stats including FTS and dense-vector internals |
| `setSearchTuning(tuning)` | `{ imageMaxDistance, searchWeights }` at runtime |
| `storeDocumentEmbeddings(docId, schema, updatedAt, chunks)` | App-provided vectors |
| `reindexCrudTimelines(opts?)` | `{ scanned, created, updated }`; rebuild `crud:*` timelines |
| `reindexSearchIndex(opts?)` | `{ indexed, totalDocs, alreadyIndexed }`; backfill FTS, idempotent |
| `reindexEmbeddings()` | `{ enqueued, totalEmbeddable, queued }`; enqueue missing dense vectors |
| `reindexMimeBitmaps(opts?)` | Rebuild derived `data/mime/*` facets |

Sub-index handles: `db.timeline`, `db.geo`, `db.bitmapIndex`, `db.checksumIndex`, `db.synapses`, `db.relations`, `db.semantic`.

## Notes

- Checksums are first-class lookup keys.
- Batch methods return structured success/failure results.
- Query results are arrays with attached `count`, `totalCount`, and `error` metadata.
- Tree-scoped emissions should populate `treeId`, `treeName`, and `treeType` via the event envelope (see **Events**).

## References

- [LMDB Documentation](http://www.lmdb.tech/doc/)
- [Node.js Crypto Documentation](https://nodejs.org/docs/latest-v20.x/api/crypto.html)
- [Roaring Bitmaps](https://roaringbitmap.org/)
- [LlamaIndex](https://www.llamaindex.ai/)
- [FlexSearch](https://github.com/nextapps-de/flexsearch)
- [LanceDB](https://lancedb.com/)
- [Why-not-indices](https://stackoverflow.com/questions/1378781/proper-terminology-should-i-say-indexes-or-indices)

## License

Licensed under AGPL-3.0-or-later. See main project LICENSE file.

---
This project is funded by [Augmentd Labs](https://augmentd.eu/en/labs)
