<p align="center">
  <img src="https://raw.githubusercontent.com/canvas-ai/.github/main/banners/canvas-banner_1200x480.jpg" alt="Canvas" width="100%" />
</p>

# SynapsD

SynapsD is a small KV database built on top of `LMDB` with `roaring-bitmap` and `lancedb` based indexes, primarily used as an in-process index and, secondarily, as a JSON document store for [Canvas Workspaces](https://github.com/canvas-ui/canvas-server).

This module is meant to index all data from configured data sources of a Workspace (files, emails, notes, browser tabs, github repos, dotfiles etc), and provide a unified virtual fs-like tree abstraction on top that should ideally mimick whatever mental model you need to make work with your data more efficient.

> **v3.x** — the *refactor-v3* pass has landed (schema version 2). Existing databases must be migrated before they will open; see **Migration and rebuild**.

## Architecture at a glance

SynapsD is one of three deliberately separated services, and stays honest about what it is **not**:

- **SynapsD** (this module) is the index and JSON document store: roaring bitmaps for membership, bit-sliced indexes for time and space, a dupsort adjacency index for typed edges, LanceDB for lexical (BM25) and dense-vector search. It holds document *metadata and structure*, never blob bytes, and **owns no embedding model**.
- **[StoreD](../stored)** owns the bytes: a cache-first blob store with content-addressable identity (checksums), pluggable backends (file, cacache, http, s3), and `stored://<backend>/<key>` URLs as the canonical fetch form. A synapsd `file` document carries `locations[]` pointing at StoreD; the blob itself lives there.
- **Embedding is somebody else's job.** synapsd **stores and namespaces vectors; it does not produce them**. There is no model, no provider, no content router and no inference of any kind in this package. An external embedding service (`embedd` in canvas-server) pulls the backlog, embeds, and pushes chunk vectors back in through the API below. Any app can do the same — the contract is three calls, not a plugin system.

This split buys a few properties that show up everywhere in the API:

- **Documents are the source of truth; indexes are derived cache.** Timelines, mime facets, `kind`, backend and device presence, geo cells, asserted edges — all re-derived from document state on every write, so they cannot drift, and `rebuildL3()` reconstructs them from rows alone. v3 completed this for user tags: `features[]` now lives on the document.
- **Membership is cheap and plural.** A document is stored once; appearing in ten trees, five tags, and three timelines costs bitmap bits, not copies.
- **The dense stack is optional.** No embedding service (or `semantic.enabled: false`) means vector/hybrid queries degrade gracefully to FTS; nothing else changes.
- **Crash-resumable ingestion.** The embedding work-ledger is a persistent bitmap diff (`getUnembeddedDocIds`), so an external embedder can resume after a restart without rescanning a single document.

### The L0–L3 model, briefly

| Layer | What it is | Rebuildable from |
|-------|------------|------------------|
| **L0** | Bytes. Not here — StoreD owns them; synapsd only stores `locations[]` URLs. | — |
| **L1** | Document rows (`documents` dataset): the JSON payload, checksums, timestamps. The source of truth. | nothing (this *is* the truth) |
| **L2** | View membership: context/directory tree bitmaps (`context/*`, `vfs/*`). Human-authored placement. | nothing (also truth) |
| **L3** | Everything derived: feature/facet bitmaps, `kind`, mime, backend/device presence, timelines, geo cells, asserted edges, FTS/vector rows. | L1 + extractors — `rebuildL3()` |

The invariant that keeps this honest: drop L3, recompute it from L1, and the index must come back identical. If it does not, something is storing state with no source.

## What it is good for

Everything below composes into a single query spec, which is the point of the whole design:

- **Membership** without a join: "files in `/work/customer-a`, tagged `finance`, not in staging" is a bitmap intersection, not a table scan.
- **Ranked retrieval** scoped by membership: BM25 full-text and dense-vector kNN fused (RRF), running only on documents that already survived the structural filter.
- **Graph adjacency** as set algebra: "everything mentioning Alice, in this context, tagged important" is a one-hop dupsort scan ANDed into the same candidate bitmap.
- **Time**, at any scale: "updated today", "due today", "Roman Empire, 27 BCE to 476 CE", "the Quaternary". Same filter grammar, from nanoseconds to gigayears, including open-ended ("still alive") intervals.
- **Space**: "photos within 5 km of here", "everything in this map viewport", as one range query over an S2 cell index.
- **Live views**: a query object that stays open and tells you the instant a newly ingested document enters or leaves the result set.
- **Zero-fetch probes**: counts, existence, and "any pending todos in here?" answered from bitmaps without loading a single document body.

## Quick start

```js
import SynapsD from '@canvas/synapsd';

const db = new SynapsD({ path: '/path/to/db' });
await db.start();

const id = await db.put(
    {
        schema: 'data/abstraction/note',
        data: { title: 'Hello', content: 'First draft' },
        features: ['tag/inbox'],
    },
    { paths: ['ctx:/work/project-a'] },
);

const inbox = await db.list({ paths: ['ctx:/work/project-a'], features: ['tag/inbox'] });
const hits = await db.query('draft', { paths: ['ctx:/work/project-a'] });

await db.shutdown();   // `stop()` is an alias
```

Constructor options: `path` (required, alias `rootPath`), `backupOnOpen`, `backupOnClose`, `compression`, `eventEmitterOptions`, `migrate` (see **Migration**), `semantic` (see **Semantic search**). `backend` accepts only `'lmdb'`.

All examples below assume a started `db`.

## Core concepts

### Documents

A document is a JSON object with a `schema`, a `data` payload, and engine-managed fields. `put()` returns a numeric document id, which is the identity used everywhere else. Checksums are first-class lookup keys, so content-addressed reads work without knowing the id.

The stored row shape (v3):

```js
{
    id: 42,                                  // integer, assigned by the DB
    schema: 'data/abstraction/note',         // registry id
    schemaVersion: '3.0',

    data: { /* schema-specific payload */ }, // replaced wholesale on update
    comment: 'sofa from the cozmo bar',      // user-authored free text, top-level

    kind: 'note',                            // DERIVED subtype axis (see below)
    features: ['tag/inbox', 'custom/client/acme'],   // ASSERTED bitmap keys
    locations: [{ url: 'stored://local/ab12…', metadata: {} }],
    timelines: [{ name: 'content', start: '2023-07-04' }],

    metadata: { contentType, contentEncoding, geo: { lat, lon }, … },
    checksumArray: ['sha1/…', 'sha256/…'],
    createdAt, updatedAt,
    orphanedAt: null,                        // set when the last location resolves nowhere
}
```

Three v3 changes worth knowing before you write anything:

- **`features[]` is top-level and asserted-only.** It moved off `metadata.features`. `metadata` holds *extracted facts written by derivers*; `features[]` holds *membership a human or client asserted*. Derived prefixes (`data/abstraction/`, `data/mime/`, `data/kind/`, `feature/`, `device/`, plus each schema's own facet namespaces) are **stripped on the way in** — a stored copy of a derived key would be indistinguishable from a derived one while being immune to the derivation's own stale-diff, i.e. it could never be unticked. `data/dataset/*` is *preserved* across an update that omits it, so a client re-putting its own tag array cannot drop ingest provenance.
- **`indexOptions` is no longer on the row.** It is schema-level configuration (`static indexOptions` on the schema class), identical for every document of a schema — ~414 B of byte-identical JSON per row, ~2.9 GB at 7M rows. Legacy rows carrying it are ignored on read. There is consequently **no per-document index override**.
- **`kind` is derived, never client-authoritative.** Whatever a caller sends is overwritten from the schema registration.

Reading a document back gives you a schema instance (`parse: false` for the raw stored object).

### Kind

`kind` is a subtype axis derived from the schema *registration* and mirrored into **hierarchical** `data/kind/*` bitmaps, exactly like `data/mime/*`: a `browser/tab` ticks both `data/kind/browser` and `data/kind/browser/tab`, so "everything browser-ish" is one key with no enumeration of children.

A registration declares either a literal `kind`, or a `kindField` (a dotted path read per document) plus a mandatory `kindPrefix`. The prefix is enforced rather than conventional: kind values are persisted in bitmap keys and are therefore append-only, so an unprefixed generic value (`file`, `person`, `calendar`) that later collides with another schema's is not fixable without a migration.

```js
db.list({ features: ['data/kind/browser'] });          // tabs, and anything else browser-ish
db.list({ features: ['data/kind/event/calendar'] });   // only calendar events
```

> Inherited caveat from `data/mime/*`: `listBitmaps(prefix)` range-scans `prefix + '/'`, so a bare `data/kind/browser` key is invisible to a prefix listing of *its own* namespace — list `data/kind/` instead. Key-based AND/OR/ANDNOT queries are unaffected.

### Trees

Trees are views on top of your documents. They organise membership and structure, not data. A single document can live in many trees at once. Every workspace database supports multiple named trees of two types.

**Context trees** are built on top of unique-by-name layers linked to bitmaps. Querying a path does a logical AND across the bitmaps of every layer along it:

- `ctx:/work/customer-a/devops/issues/issue-1001` resolves to all data linked to issue 1001.
- `ctx:/work/customer-a/devops/issues` resolves to all data linked to all indexed issues.
- `ctx:/issues` is an ad-hoc path showing all data related to all issues across all customers.

Because layers are unique by name and intersect, the tree gives you a natural "zoom": shorten the path to widen the result. Paired with session-based evolving queries, it becomes a way to fine-tune retrieval dynamically.

Beyond FS-like tree methods, layers support `merge layer` (merge a layer's bitmap into 1-N others) and `subtract layer`.

**Directory trees** are the more familiar UX: unique folder nodes with filesystem-like semantics. A virtual directory is a self-contained movable/copyable container. Each directory owns its bitmap; recursive queries OR them.

### Features

Features are flat bitmap keys ticked on a document. They carry a `who says so?` convention in the prefix. Allowed prefixes are validated in `src/indexes/bitmaps/lib/keys.js`:

| Prefix | Who says so | Stored on the document? |
|--------|-------------|-------------------------|
| `tag/*` | The user — free-form flat labels | yes, in `features[]` |
| `custom/<axis>/<value>` | The user — structured | yes, in `features[]` |
| `client/*` | The writing client | yes, in `features[]` |
| `data/dataset/*` | Ingest provenance (see **Datasets**) | yes, preserved across updates |
| `data/no-location` | The app — orphan marker (see below) | yes, in `features[]` |
| `data/abstraction/*` | Derived from `schema` | no — derived every write |
| `data/kind/*` | Derived from the schema registration | no |
| `data/mime/*` | Derived from `metadata.contentType` (hierarchical: type + full type) | no |
| `data/backend/*` | Derived from `locations[]` (hierarchical: scheme + scheme/authority) | no |
| `data/<facet>/*` | Derived from a schema's `static facetFields` (e.g. `data/status/*` from Todo's `data.status`) | no |
| `device/id\|os\|type/*` | Derived from `locations[]` + the device's own Device document | no |
| `feature/*` | The engine observed it (`feature/has-comment`) | no |
| `context/*`, `vfs/*` | Tree membership — bitmap-only, not on the row | no |
| `internal/*` | Engine-managed, hidden from default listings | no |

Derived facet bitmaps are re-ticked and stale-unticked on every write from document state, so they cannot drift. Completing a todo moves it from `data/status/pending` to `data/status/completed` atomically with the document write, so an agent's "any pending todos here?" is a zero-fetch bitmap probe.

Key charset: lowercased, `a-z 0-9 _ - . / @ : +`. `@` and `:` keep backend addresses readable (`data/backend/imap/user@domain.tld`); `+` keeps MIME subtypes intact (`data/mime/image/svg+xml`) and is only a query sigil in *leading* position.

**`data/no-location`** marks a document whose last resolvable location vanished — index entry kept, bytes gone. It is **asserted by the application, not derived here**: synapsd has no deriver for it, so it behaves like a tag (set it, and it is indexed; drop it, and it unticks). In canvas-server the stored-index orphan lifecycle owns it, setting it alongside `orphanedAt` when the last location goes and clearing it on re-bind. It lives under `data/` rather than `tag/` so delete-protection and retention sweeps can find it by prefix. Making it derived (from `locations.length === 0`) is an open question, not a settled design.

**`data/backend/*`** replaced the deleted `data/source/*`. Both used to be asserted by the parent; once both derive from `locations[]` they are two projections of the same fact, and the provider is a property of the backend, not of the document. Derivation is deliberately generic — synapsd parses a URL into scheme + authority and knows nothing about `stored`, S3 or IMAP. `file://` and `device://` are skipped (that is what `device/*` answers); a location may declare `metadata.backend` explicitly when the URL cannot carry it (device-anchored mounts).

### The query seam

Every read is two pure stages, and both are public:

```
resolveCandidates(spec) -> { bitmap, keys, collectionKeys, coarse }   // paths AND features AND filters AND rel
rank(bitmap, match, { mode, limit, offset })                          // match=null => slice; else fts/vector/hybrid

query(match, spec) = rank(resolveCandidates(spec).bitmap, match, spec)
list(spec)         = query(null, spec)
```

There is one candidate-set resolver and one ranker. `list`, `query`, `search`, `searchRefined`, `searchCompound`, and `QuerySession` are all entry points onto that same seam, which is why any filter documented below works in all of them.

`collectionKeys` are the actual bitmap keys consulted (`context/<treeId>/<layerId>`, `vfs/<treeId>/<nodeId>`, feature keys), so a live session can intersect them against `membership.changed` for precise invalidation. `coarse` marks a dependency with no stable key — temporal (BSI range), spatial (S2 BSI), or `rel` (dupsort scan) — which consumers must re-resolve rather than key-intersect.

## The query spec

One object shape drives every read. The buckets intersect (`paths AND features AND filters AND rel`), and items within a bucket combine via the sigil algebra described below.

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

    // ---- WHO WITH: graph adjacency, one hop -------------------------------
    rel: [
        { p: 'mentions', of: 1234, dir: 'in' },              // docs mentioning 1234
        { op: 'noneOf', p: 'derived-from', of: 1234 },       // minus its derivatives
    ],

    // ---- HOW: ranking (ranked queries only) -------------------------------
    mode: 'hybrid',        // 'hybrid' (default) | 'fts' | 'vector'
    minDistance: 0,        // cosine floor for the dense leg (0 = identical)
    maxDistance: 0.9,      // cosine ceiling (2 = opposite); omit for no ceiling
    debug: false,          // attach result.debug.imageDistances for calibration

    // ---- PAGING / SHAPE ---------------------------------------------------
    limit: 50,             // list: 100, query: 50; 0 = all matches
    offset: 0,             // or `page: 1` (1-based, computed from limit)
    order: 'asc',          // 'asc' (default) | 'desc'
    sortBy: 'content',     // timeline name; LIST ONLY, ranked stays relevance-ordered
    parse: true,           // false => raw stored data, no document instances
});
```

Any of the read options (`mode`, `limit`, `offset`, `page`, `order`, `sortBy`, `parse`, `groupBy`, `minDistance`, `maxDistance`, `debug`, and `rel`) may also be nested under an `options: { ... }` key. Top-level wins when both are present.

### Sigil algebra

| Sigil | Bucket | Meaning |
|-------|--------|---------|
| *(none)* | `anyOf` | OR within the bucket (default) |
| `+` | `allOf` | Required gate |
| `!` | `noneOf` | Exclude |

The buckets intersect with each other, and within `features`, `filters` and `rel` the algebra above applies in full. (`rel` spells its sigil as an `op` field rather than a prefix, since its entries are objects.)

**`paths` is the exception**: its positive entries always OR together, and `+` is accepted but has no effect. Only `!` is meaningful there. This follows from the tree model, where intersection is what a *path* already expresses (a context path ANDs the layers along it), so ANDing two separate paths is not a thing you ask for. To require membership in two independent places, use a feature gate or nest the path.

In the object form of `features`, a `!`-prefixed entry inside `allOf`/`anyOf` is sugar for `noneOf`.

### Field reference

| Field | Description |
|-------|-------------|
| `paths` | `['ctx:/a/b', 'dir:/x', '!ctx:/staging']` or `{ in, not }`. The `ctx:`/`dir:` grammar targets default trees; a bare path defaults to context. Positive entries OR; only `!` is honoured |
| `context` / `directory` | Tree-qualified selector `{ tree, path, recursive }`, for non-default trees. `path` takes a string or array. `recursive` (directory trees only) widens node-exact scoping to the whole subtree. Joins the same OR-union as `paths` |
| `features` | `['+tag/red', 'tag/blue', '!tag/spam']` or `{ allOf, anyOf, noneOf }` |
| `filters` | `['t:crud:updated:thisWeek', '+geo:bbox:...', '!t:crud:created:today']` (see filter grammar) |
| `rel` | `{ p, of, dir?, op? }` or an array of them. See **Relations and edges** |
| `mode` | `hybrid` (default), `fts`, or `vector`. Ranked queries only |
| `minDistance` / `maxDistance` | Cosine-distance window for the dense leg of `vector`/`hybrid`. Drops kNN neighbours outside `[min, max]` before fusion (`0` = identical, `2` = opposite). Keeps "nearest but irrelevant" hits out on a small or loose corpus |
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

Anything without a recognised prefix is treated as a raw bitmap key and ANDed in. Token *shape* is validated at spec-parse time (not resolve time), so a malformed token throws instead of quietly looking like "no results".

### Result shape

Reads return an array of documents with metadata attached to it:

- `result.count`: number of documents in this page.
- `result.totalCount`: total matching documents, before pagination.
- `result.error`: error message string, or `null`.

`list()` returns its error on the result rather than throwing; `query()` throws.

## CRUD API

The public read surface is `list()` and `query()`. Writes take `(document, spec)`, where the spec is the same object shape as above, restricted to its write-relevant fields.

### The write spec

```js
const noteSpec = {
    paths: ['ctx:/work/project-a'],              // ctx:/dir: grammar, default trees
    features: ['tag/inbox'],                     // ticked in addition to document.features
    emitEvent: true,                             // default; false suppresses events
    provenance: { origin: 'rule', causedBy: 'evt-parent', depth: 1 },
};

// Tree-qualified equivalent, for a non-default tree:
const projectTreeSpec = {
    context: { tree: 'projects', path: '/work/project-a' },
};
```

Write methods tick every feature you pass, **unioned with the document's own `features[]`** — the document is declarative, so storing a feature *is* the way to create the bitmap. Dropping a feature from `features[]` on a re-put unticks its bitmap. Sigils are stripped on writes: the `paths` grammar is authoritative and derives both the context and directory selectors, so a directory-only write does not also touch `ctx:/`.

`provenance` rides on the emitted event so automation layers (workspace hooks and rules) can detect and bound their own cascades. Only `origin`, `causedBy`, and `depth` pass through; anything else is dropped. It defaults to `origin: 'user'`, `depth: 0`.

### Create

`put()` creates a new row when the document has no existing `id`, and returns the numeric document id. Writes deduplicate by primary checksum: a write whose content hashes to an existing document of the same schema updates that row instead of forking it.

```js
const id = await db.put(
    {
        schema: 'data/abstraction/note',
        data: { title: 'Hello', content: 'First draft' },
        features: ['tag/inbox'],
    },
    noteSpec,
);

const ids = await db.putMany(
    [
        { schema: 'data/abstraction/note', data: { title: 'A', content: 'Alpha' } },
        { schema: 'data/abstraction/note', data: { title: 'B', content: 'Beta' } },
    ],
    { context: { tree: 'projects', path: ['/work/project-a', '/work/shared'] } },
);
```

A schema may declare `static mergeOnDedupe = ['data.links']` for record fields that must merge rather than be replaced when a write resolves to an existing document by checksum (Dotfile's per-device map is the motivating case: a client POSTing only its own device's mapping would otherwise wipe every other device's).

### Read

`get()` and `getByChecksumString()` return a parsed document instance by default. Pass `{ parse: false }` for raw stored data. Tree-aware membership checks use `has()` and `hasByChecksumString()`, which answer from bitmaps without loading the document.

```js
const doc = await db.get(id);
const rawDoc = await db.get(id, { parse: false });
const docByChecksum = await db.getByChecksumString('sha256/…');
const noteByChecksum = await db.getByChecksumString('sha256/…', { schema: 'data/abstraction/note' });

// Existence probes, no document fetched
const existsAnywhere = await db.has(id);
const existsInProjectsTree = await db.has(id, { context: { tree: 'projects', path: '/work/project-a' } });
const existsWithInboxFeature = await db.has(id, { paths: ['ctx:/work/project-a'], features: ['tag/inbox'] });

const checksumExistsInProject = await db.hasByChecksumString(
    'sha256/…',
    { context: { tree: 'projects', path: '/work/project-a' } },
);

// Where does this document live?
await db.listDocumentTreePaths(id, 'projects');
await db.listDocumentTreeMemberships(id, 'projects');
await db.hasDocumentTreeMembership(id, 'projects');
await db.getBitmapsForDocument(id);
```

### Update

`put()` updates when `document.id` already exists.

`put({ id, data })` **replaces** `data`; it does not deep-merge fields. To change a single field, read the document first and send the full updated `data` object. Fields with their own branch (`comment`, `features`, `locations`, `timelines`) are updated independently of `data` and deliberately do **not** regenerate checksums — editing a tag or a comment must never fork dedup identity or trigger a re-embed.

```js
// Change one data field
const current = await db.get(id);
await db.put({ id, schema: current.schema, data: { ...current.data, title: 'Updated title' } }, noteSpec);

// Change only tags — no checksum churn, no re-embed
await db.put({ id, features: ['tag/important', 'tag/reviewed'] });
```

To change only *view* membership (trees), use `link()` / `unlink()`, which never touch the row.

### Link and unlink

`link()` adds tree/feature membership. `unlink()` removes it. Neither touches the document body, and `unlink()` never deletes the document.

```js
await db.link(id, {
    context: { tree: 'projects', path: '/work/project-a' },
    features: ['tag/reviewed'],
});

await db.unlink(id, {
    context: { tree: 'projects', path: '/work/project-a/deep' },
    features: ['tag/inbox'],
});

// Recursive: also drop the subtree below the path
await db.unlink(id, { context: { tree: 'projects', path: '/work/project-a/deep' }, recursive: true });

const linkResult = await db.linkMany([id1, id2], { context: { tree: 'projects', path: '/work/project-a' } });
const unlinkResult = await db.unlinkMany([id1, id2], { features: ['tag/inbox'] });
```

> Feature keys ticked through `link()` are *bitmap-only* — they are not written back to `features[]`. For tags you want to survive an L3 rebuild and be visible to offline clients, put them on the document.

Context-tree root `/` is a selector meaning "anything in this tree", not a real removable membership. Directory-tree root `/` is just the literal root folder.

### Delete

`delete()` removes the document row, checksum index entries, timeline index entries, edges, and synapse memberships. It returns `true` when a document was deleted, `false` when the id was not found.

```js
const deleted = await db.delete(id);
await db.delete(id, { emitEvent: false });
const deleteResult = await db.deleteMany([id1, id2]);
```

`unlinkMany()` and `deleteMany()` return `{ successful, failed, count }`. Batch delete and unlink ids must be numbers: numeric strings are accepted by `get()` and `put()` but rejected by the batch helpers.

## Relations and edges

v3 added a typed, directed, N:N edge plane between documents (`src/indexes/edges/`). It is stored as three LMDB DBIs on the shared root env:

```
edges_fwd   dupSort   key [fromId, predId]         value toId
edges_inv   dupSort   key [toId,   predId]         value fromId
edge_meta   plain     key [fromId, predId, toId]   value { src, ts, conf? }
```

dupSort gives sorted, deduped value sets: writing the same edge twice is a no-op (idempotent for free), and degree is a B-tree count rather than a scan.

### Predicates

A closed, append-only registry (`src/indexes/edges/predicates.js`). Ids are persisted inside LMDB keys, so they are never renumbered and never reused.

| Predicate | Id | Meaning |
|-----------|----|---------|
| `includes` | 1 | composition: email → attachments, tab → offline file |
| `references` | 2 | soft link |
| `derived-from` | 3 | provenance: thumbnail → image, offline file → tab |
| `mentions` | 4 | entity mention: message → identity |
| `replies-to` | 5 | threading: message → message |
| `depicts` | 6 | media subject: image → identity (face tags) |
| `authored-by` | 7 | authorship: message/document → identity |

Every predicate takes the **document** as subject, never the entity it points at ("message authored-by identity", not "identity authors message").

**Direction is an axis, not a name.** There are no inverse predicate names anywhere — not in the registry, not in persisted data, not in the query grammar. You express direction by which method you call (`outgoing` / `incoming`) or by a `dir` parameter. Inverse-style spellings (`mentioned-by`, `derives`, `authors`, …) are explicitly rejected with a pointer to the axis, because resolving them erases direction at the callsite and silently produces wrong forward scans.

### Asserted edges: `data.relations`

A document declares its own edges in `data.relations`, an array of `{ p, to }`. They are derived into the edge index on every write, as a diff against the previous row — an update that drops an entry drops the edge.

```js
const alice = await db.put({ schema: 'data/abstraction/identity', data: { displayName: 'Alice' } });

const msg = await db.put({
    schema: 'data/abstraction/note',
    data: {
        title: 'standup',
        content: 'Alice is taking the migration',
        relations: [{ p: 'mentions', to: alice }],
    },
});
```

- Relations are validated at ingest: an unknown predicate, an inverse-style name, or a non-integer `to` throws. A relation that can never become an edge must not be stored, or the row would claim a relationship the graph does not have.
- Dangling `to` ids are **allowed** (logged at debug). Edges to documents that do not exist yet are filtered by candidate-set intersection at query time anyway, and forbidding them would make ingest order significant.
- `data.relations` is **structural, not content**: `BaseDocument.contentData()` strips it from every whole-`data` projection (checksum, FTS, embedding). Asserting an edge therefore does not fork the document's identity, pollute its search text, or trigger a re-embed. A document with no relations projects byte-identically to before.

### Provenance: asserted vs derived

**Asserted edges write no meta row.** The absence of a meta record *is* the convention meaning "owned by a document's `data.relations`"; `edge()` synthesizes `{ src: 'doc' }` so callers never see the trick. Extractor and agent edges must pass `{ src: 'extractor:<name>' }` or `{ src: 'agent:<hookId>' }`.

That split is what makes `removeEdges({ src })` + re-running the extractor a complete rebuild path for derived edges that can never touch asserted ones — and conversely, why a row update that drops a relation removes only the asserted edge between that pair, leaving an extractor's independent edge alone.

```js
// Document-aware facade (handles optional membership inheritance)
await db.relate(fromId, 'derived-from', toId, { meta: { src: 'extractor:thumbnailer' } });
await db.relate(fromId, 'includes', toId, { inheritMemberships: true });
await db.unrelate(fromId, 'derived-from', toId);

// Raw, document-unaware index
db.edges.exists(from, 'mentions', to);
db.edges.edge(from, 'mentions', to);          // -> { from, p, to, meta }
db.edges.degree(id, 'mentions', 'in');
db.edges.edgesOf(id);                          // { outgoing: [{p,to}], incoming: [{p,from}] }
[...db.edges.outgoing(id, 'mentions', { limit: 100 })];
[...db.edges.incoming(id, 'mentions')];
db.edges.removeEdges({ src: 'extractor:ner', p: 'mentions' });
```

`EdgeIndex` is document-unaware by design: it speaks uint32 node ids and predicates, nothing else. Anything document-shaped (deriving from `data.relations`, membership inheritance) lives on the `SynapsD` facade above it.

> Iterator caveat: a live LMDB iterator pins a read transaction, and dupSort stores cannot disable the snapshot. Drain `outgoing()`/`incoming()` promptly and never hold one across an `await`.

### The `rel` query bucket

Adjacency composes into the same candidate pipeline as paths and features — one hop, expressed as set algebra rather than a traversal API. Multi-hop traversal is deliberately out of scope for v3.

```js
// Everything that mentions Alice, in /work, tagged important
await db.list({
    context: { path: '/work' },
    rel: { p: 'mentions', of: aliceId, dir: 'in' },
    features: ['tag/important'],
});

// What does this message mention? (outgoing is the default)
await db.list({ rel: { p: 'mentions', of: msgId } });

// Sigils via `op`
await db.list({
    rel: [
        { p: 'replies-to', of: threadRoot, dir: 'in' },
        { op: 'noneOf', p: 'derived-from', of: threadRoot },
    ],
});
```

`of` must be a positive integer document id (numeric strings are coerced); `dir` is `'out'` (default) or `'in'`; `op` is `anyOf` (default), `allOf`, or `noneOf`. All of this is validated at spec-parse time — an unknown or inverse-style predicate would otherwise be caught by the sigil combiner and silently *widen* the result set instead of failing.

A `rel` operand has no stable bitmap key (it is a dupsort scan), so it marks the candidate set `coarse`: a `QuerySession` re-resolves it rather than key-invalidating.

## Schemas

A schema is a `BaseDocument` subclass plus a registration record. The registry (`src/schemas/SchemaRegistry.js`) is a singleton with three tiers:

| Tier | What | Ids |
|------|------|-----|
| `core` | synapsd's own primitives. Sealed — cannot be re-registered or removed. | `document`, `file`, `message`, `email`, `event`, `todo`, `identity`, `device`, `application` |
| `app` | Consumer abstractions, registered through the same code path a third party would use. Bundled here pending the parent's own `registerSchema()` calls. | `note`, `tab`, `link`, `dotfile` |
| `internal` | Tree layer abstractions. | `internal/layers/{canvas,context,label,system,universe,workspace,project,task}` |

Ids stay `data/abstraction/*` in v3; the entity rename is deferred to its own release. **`kind` is the axis to migrate to** — `data/kind/browser/tab` answers what `data/abstraction/tab` answers today, so a consumer can switch on its own cadence.

v3 schema changes: `Contact` → `Identity` (with `data.type` of `person|organization|service|bot` driving `data/kind/identity/*`), `Bucket` deleted, `Event` added.

### Registering your own

```js
import schemaRegistry from '@canvas/synapsd/src/schemas/SchemaRegistry.js';
import BaseDocument from '@canvas/synapsd/src/schemas/BaseDocument.js';

class Widget extends BaseDocument {
    static indexOptions = {
        ftsSearchFields: ['data.title', 'data.body'],
        vectorEmbeddingFields: ['data.title'],
        checksumFields: ['data.title', 'data.serial'],
    };
    static facetFields = ['data.condition'];   // -> data/condition/<value> bitmaps

    constructor(options = {}) {
        options.schema = options.schema || 'data/abstraction/widget';
        super(options);
    }

    static get dataSchema() { /* zod */ }
}

schemaRegistry.registerSchema('data/abstraction/widget', Widget, {
    kindField: 'data.type',    // per-document discriminator...
    kindPrefix: 'widget',      // ...always prefixed: data/kind/widget/<value>
});
// or a literal:
// schemaRegistry.registerSchema('data/abstraction/widget', Widget, { kind: 'widget' });
```

Rules the registry enforces rather than documents:

- The class must be a `BaseDocument` subclass; core ids cannot be re-registered (re-pointing `data/abstraction/file` at a foreign class would silently change what it means for everyone).
- `kind` and `kindField` are mutually exclusive — a schema has one kind axis.
- `kindField` requires `kindPrefix` (see **Kind** above for why).
- Passing `options.indexOptions` **writes `SchemaClass.indexOptions`** rather than storing a parallel copy. `static indexOptions` on the class is the one source of truth: `BaseDocument` resolves it at construction time and cannot import the registry without a cycle.

`indexOptions` fields: `checksumAlgorithms` (default `['sha1','sha256']`), `checksumFields`, `ftsSearchFields`, `vectorEmbeddingFields` (all default to `['data']`), and `embeddingOptions`. Field paths are dotted and resolved against the *document* (so `locationUrls` and other getters work); the literal `'data'` resolves to `contentData()`, i.e. `data` minus `relations`.

`static facetFields = ['data.status']` gives a schema the derived-facet machinery: the leaf field name becomes the namespace (`data/status/*`), ticked and stale-unticked on every write. Engine-owned namespaces (`abstraction`, `kind`, `mime`, `backend`, `source`, `dataset`, `no-location`) are refused.

Introspection: `db.listSchemas(prefix?)`, `db.getSchema(id)`, `db.hasSchema(id)`, `db.getDataSchema(id)`, `db.getJsonSchema(id)`. On the registry itself: `getSchemaEntry(id)` (returns `{ SchemaClass, tier, kind, kindField, kindPrefix, indexOptions }`), `resolveKind(id, doc)`, `unregisterSchema(id)`.

## Querying

### `list(spec)`: structural listing

Equivalent to `query(null, spec)`. Returns documents matching the candidate set in insertion order, with no ranking. With no buckets, `list` returns every document. Default limit is 100; pass `limit: 0` to return all matches.

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

// Zero-fetch facet probe: any pending todos here?
const pending = await db.list({
    features: ['data/abstraction/todo'],
    filters: ['data/status/pending'],
});

// Everything from one IMAP account, via the derived backend axis
const fromAccount = await db.list({ features: ['data/backend/imap/user@example.com'] });
```

### `query(match, spec)` and `search(spec)`: ranked retrieval

`match` is a string (or `{ text }`). The candidate set scopes a full-text/vector search (LanceDB), ranked by relevance. `search(spec)` is a thin wrapper that pulls `match` from `spec.query` (`spec.search` and `spec.q` are also accepted). Default limit is 50. `mode` selects `hybrid` (default), `fts`, or `vector`; vector and hybrid fall back to `fts` when the dense stack is down.

```js
const ranked = await db.query('invoice', {
    paths: ['ctx:/finance/2026'],
    features: ['data/abstraction/file', 'tag/finance'],
    limit: 20,
});

const same = await db.search({ query: 'invoice', paths: ['ctx:/finance/2026'], limit: 20 });
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
});
```

Semantics:

- `sortBy` accepts a timeline name (`'content'`, `'crud:created'`, `'wikipedia'`); a `t:` prefix is tolerated. `order` applies to the timeline value, and ties break by id.
- Interval timelines sort by their **start**; point timelines by the instant.
- Documents with **no value** on the timeline always trail the sorted ones (in id order), so a photo without EXIF ends up at the end and never pollutes the sequence.
- List only: ranked (`query` / `search`) results keep relevance order.

**Mechanics and cost.** Sort keys come straight out of the timeline's bit-sliced index: each of the 64 slice bitmaps is ANDed against the candidate set once (`getSortKeys`), reconstructing every candidate's value in a single pass, with no per-document probing and no document bodies fetched outside the requested page. Values from different scale tiers are normalized to one comparable key (period start for coarse tiers), finest tier wins. Cost scales linearly with the candidate count, not with corpus size.

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

const off = s.on('change', ({ added, removed, count }) => updateCanvas(added, removed, count));

await s.patch('inbox', { features: ['+tag/urgent'] });   // refine one cue
await s.remove('important');                             // widen
off();
s.close();
```

- **Emit modes**: `delta` (default, `{ added, removed, count }`), `ids`, `page`.
- **Modes**: `frozen` (default) freezes relative timeframes at `add()` and never slides, giving a stable snapshot suitable for agent working memory. `live` re-resolves temporal cues on each recompute (sliding windows) and pushes `change` events.
- **Precise invalidation**: a write only re-evaluates cues whose `collectionKeys` it touched. Temporal, geo and `rel` cues are `coarse`, so they re-resolve on any relevant write.
- **Lifecycle**: `serialize()` produces tiny JSON (specs and labels, no bitmaps); `QuerySession.rehydrate(db, json)` rebuilds it, re-resolving on first read.

The live path is driven by the `membership.changed` event, emitted post-commit with the exact ticked collection keys. See **Events**.

### Stateless refinement: `searchRefined`

For ad-hoc drill-down without a session object, fold a stack of text queries: each one AND-narrows the previous result set across FTS and the image-vector space (so photos refine too), and the last one ranks. An optional `baseSpec` supplies the structured starting scope.

```js
const page = await db.searchRefined(
    ['car', 'red', 'market'],
    { context: { tree: 'projects', path: '/inbox' }, features: ['data/abstraction/email'] },
    { limit: 20 },
);
```

Zero or one query degrades to a plain list or single search. `searchCompound(lines, options)` is the sibling that fuses per-line rankings instead of chaining them.

## Semantic search (vectors)

`query()` defaults to `mode: 'hybrid'`: dense-vector kNN fused with BM25 via RRF. The candidate bitmap still scopes retrieval first, and ranking runs only on survivors. `vector` and `hybrid` degrade to `fts` when the dense stack is unavailable, and `list()` (`match = null`) never embeds.

### SynapsD stores vectors, it does not produce them

The whole vector surface is: you push chunk vectors in, synapsd namespaces them by *space* (one LanceDB table per model/dim), keeps a durable work-ledger of what still needs embedding, and injects your callback to embed a query string at search time. Nothing else. No model is loaded, downloaded or executed in this process.

- **Document vectors arrive from outside** via `storeDocumentEmbeddings(docId, schema, updatedAt, chunks, { space })`. In canvas-server the `embedd` service is the producer; any app can push vectors the same way.
- **Query embedding is an injected callback**: `semantic.embedQuery(text, space)`. When absent, `vector` and `hybrid` queries degrade to FTS.
- **The durable work-ledger stays in synapsd**: a per-space "seen" bitmap plus `getUnembeddedDocIds(space, schemas)` — a pure bitmap diff (embeddable-schemas OR minus seen) that survives restarts.

### Vector spaces

Vectors live in one LanceDB table per embedding model/dim (a *space*), at chunk granularity (one row per `(docId, chunkId)`):

| Space | Table | Dim | Baseline model | ANN |
|-------|-------|-----|----------------|-----|
| `text` | `vec_text` | 384 | `bge-small-en-v1.5` | yes |
| `image` | `vec_image` | 768 | `Xenova/siglip-base-patch16-224` | **no** |

Ledger bitmaps are **always model-keyed, with the model slug as the leaf**:

```
internal/embed/vectors/<space>/<model-slug>   presence ("this doc has vectors")
internal/embed/seen/<space>/<model-slug>      processed (including deliberate skips)
```

A namespace must never also be a key: `listBitmaps()` range-scans `prefix + '/'`, so a bare `internal/embed/vectors/text` sitting above `internal/embed/vectors/text/<slug>` would be invisible to a prefix query of its own namespace. That is exactly what the pre-v3 `internal/lance/vectors` key did — it was the text presence bitmap *and* the parent path of the image one. Legacy keys are migrated to the baseline slug once at start.

The `image` space is **cross-modal**: photos are embedded from bytes, and at query time the *text* query is embedded by the same encoder family into the same joint space. Two consequences baked into the defaults:

- **Exact kNN, no ANN index.** Lance's quantized ANN indexes train on the stored (image) distribution; a text query vector lands outside it and comes back with wildly inflated distances (measured: true 0.96 → ANN 1.49) that the relevance floor then rejects wholesale — silent zero results.
- **A cosine-distance floor** (`imageMaxDistance`, default `0.945`, calibrated against SigLIP base fp32) keeps unrelated photos out of every search, since image kNN returns its top-K for *any* query.

### Config and introspection

```js
const db = new SynapsD({
    path: '…',
    semantic: {
        enabled: true,
        dim: 384,
        embedQuery: (text, space) => embedd.embedQuery(text, space),
        embeddableSchemas: ['data/abstraction/note'],
        // spaces: { … }
    },
});
```

| Option (`semantic.*`) | Default | Role |
|-----------------------|---------|------|
| `enabled` | `true` | Open the dense stack; `false` is FTS-only |
| `dim` | `384` | Text-space vector dimension |
| `embedQuery` | `null` | Injected query embedder `(text, space) => vector`; absent → FTS fallback |
| `embeddableSchemas` | `['data/abstraction/note']` | Default candidate schemas for the unembedded-gap ledger |
| `spaces` | text + image (above) | Per-space `{ table, model, dim, bitmapKey, seenKey, annIndex }` |
| `imageMaxDistance` | `0.945` | Cosine floor for the image kNN leg. ⚠️ Calibrated against **SigLIP base fp32** — the figure is model-specific and must be re-measured for a different image encoder (use `debug: true`, see below). `CANVAS_IMAGE_MAX_DISTANCE` env override; `null`/`0` = no floor |
| `searchWeights` | `{ fts: 2, dense: 1, image: 2 }` | Hybrid RRF fusion weights. FTS outweighs dense because text kNN has no relevance floor; image ties FTS because it *is* floored |

`setSearchTuning({ imageMaxDistance, searchWeights })` adjusts these at runtime. `await db.getStats()` returns a `.semantic` block for diagnostics UIs. Per-space helpers: `setVectorSpaces()`, `listVectorTables()`, `dropVectorTable()`, `clearSpace()`, `optimizeVectors()`.

To bypass the embedding service entirely (media it doesn't cover, precomputed vectors):

```js
await db.storeDocumentEmbeddings(docId, schema, updatedAt, [
    { chunkId: 0, text: 'caption or transcript', vector: [/* dim floats */] },
], { space: 'text' });
```

## Timelines and intervals

SynapsD supports source/domain timelines (`wikipedia`, `britannica`, `crud:updated`, `content`, `tasks`, `events`) backed by internal scale tiers. The developer-facing name stays simple; internally each timeline owns lazy per-scale tiers for `Gyr`, `Myr`, `Kyr`, `year`, `month`, `day`, `second`, `ms`, and `ns`.

Each stored interval is normalized to `{ scale, start, end }`. If you omit `scale`, SynapsD infers it from the input and errors when it cannot do that safely. No fake precision. Dinosaurs did not have millisecond timestamps, despite what software would like to believe.

> **One document occupies ONE position per timeline.** The index is a BSI keyed id → a single value, so a second insert for the same `(timeline, id)` overwrites the first. Declaring two entries for the same timeline name on one document therefore **throws** rather than silently discarding all but the last (which the row would keep re-rendering, so only a timeline query would reveal the loss). Use one document per position, or a distinct timeline name per axis, until multi-position indexing lands.

### Storage modes: interval vs point-event

- **Interval (dual-BSI)**: two bit-sliced indexes per tier (`start` and `end`). For ranges that genuinely span time. Overlap query: `start <= range.end AND end >= range.start`.
- **Point-event (single-BSI)**: one bit-sliced index per tier (`ts`). For **instants**. Halves the slice bitmaps *and* the per-insert slice writes; the BSI's existence bitmap doubles as the presence set.

A timeline is point-mode when its name starts with `crud:` (by convention) or is registered explicitly. The db registers `tasks` (Todo due dates) as a point timeline; `events` is deliberately *not* point-mode, because calendar entries have duration and a start-only entry on an interval timeline is already stored as an instant.

```js
const timeline = new TimelineIndex(bitmapIndex, { pointTimelines: ['visited', 'opened'] });
```

The mode is deterministic from the name, so it is stable across restarts without persisting a flag. Queries are identical regardless of mode.

### Open (unbounded) intervals

```js
await db.timeline.insert('life', personId, { start: '1912-12-12', end: Infinity });
await db.timeline.insert('until', id, { start: -Infinity, end: '2000' });
```

Accepted open markers: `Infinity` / `-Infinity`, or the strings `'inf'`, `'+inf'`, `'infinity'`, `'ongoing'`, `'present'` (upper) and `'-inf'`, `'-infinity'` (lower). The scale comes from the bounded endpoint; the open side is stored as a BSI extreme sentinel, so the normal overlap test extends to ±infinity with no special query path. "Alive in 2026" matches every still-open life automatically.

> For **inserts**, use the object form (`{ start, end }`) for open intervals. Open markers are not supported in the positional `insert(name, id, start, end)` form, where an omitted end means "instant".

On `queryInterval`, a `null` or omitted bound means open on that side:

```js
await db.timeline.queryInterval('life', '1990');         // [1990, +inf)
await db.timeline.queryInterval('life', null, '2000');   // (-inf, 2000]
await db.timeline.queryInterval('life', '2008', '2008'); // bounded point
```

### Multi-timeline retrieval: `mode: 'grouped'` (zeitgeist)

`queryInterval` takes one or more timeline names and a query `mode`: `union` (default, one flat id array), `layers` (`{ name: { scale: [ids] } }`), or `grouped` (`{ name: [ids] }`, scales pre-unioned).

```js
const z = await db.timeline.queryInterval(
    ['wikipedia', 'historian-foo', 'geology', 'climate'],
    { start: '600', end: '600' },
    { mode: 'grouped' },
);
```

Every requested timeline is present in the result (empty as `[]`). Because queries span all scale tiers, a single instant matches a king's reign stored at `year` *and* the geological era stored at `Myr` in the same call.

Canonical calendar and time semantics:

- Proleptic Gregorian calendar internally; astronomical year numbering (`0` = 1 BCE).
- Modern instants are treated as UTC-ish civil time. Leap seconds are ignored — this is a personal/workspace event database, not a spacecraft.
- Deep-time values should use scaled coordinates (`Gyr`, `Myr`, `Kyr`) instead of calendar dates.

### System CRUD timelines

Document lifecycle events are automatically indexed into `crud:created`, `crud:updated`, and `crud:deleted` — **point-event** timelines pinned to **second** resolution (ms precision on a wall-clock lifecycle stamp is spurious and only widens the BSI).

Formats: `t:crud:ACTION:TIMEFRAME` and `t:crud:ACTION:START..END`.

Supported timeframe tokens: `now` (current hour), `today`, `yesterday`, `tomorrow`, `lastWeek`, `thisWeek`, `nextWeek`, `lastMonth`, `thisMonth`, `nextMonth`, `lastYear`, `thisYear`, `nextYear`, `lastDecade`, `thisDecade`, `nextDecade`, `lastCentury`, `thisCentury`, `nextCentury`, `lastMillennium`, `thisMillennium`, `nextMillennium`.

```js
const recentDocs = await db.list({
    paths: ['ctx:/projects'],
    filters: ['+t:crud:created:thisWeek', '+t:crud:updated:today'],
});
```

### Reserved content timelines

- **`content`**: when the content itself came into existence (EXIF capture date for photos).
- **`tasks`**: Todo due dates (point-mode, derived from `data.dueDate` by the Todo schema). `t:tasks:today` means "due today"; `sortBy: 'tasks'` orders by due date.
- **`events`**: `Event` documents (`calendar` / `alert` / `activity`), derived from `data.start` / `data.end`. One timeline for all three types, with `data/kind/event/*` discriminating — because the founding query is "show me everything happening under /work/customer-foo", and a calendar app, an alert panel and an activity feed are three lenses on one set.

#### Event recurrence: the envelope model

A recurring series cannot be expanded into N timeline entries on one document (one position per timeline, see above). Instead an `Event` carrying an RFC 5545 `data.recurrence` (`FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T235959Z`) gets a timeline entry spanning an **envelope** — first occurrence to `UNTIL`, or open when the rule never ends — and the client expands the RRULE to render real occurrences, exactly as a CalDAV client already does with `VEVENT`+`RRULE`.

The envelope is a deliberate superset: a weekly standup answers a query for any day inside its span. That is the same candidate-set-then-refine contract as the rest of the engine, and it never *misses* an occurrence, which is the property that matters for a bitmap pre-filter. `COUNT=n` yields an **open** envelope rather than a computed last occurrence — an open envelope over-matches (the client filters), a short one would lose occurrences outright.

### Custom timelines

```js
await db.timeline.createTimeline('wikipedia');
const timelines = await db.timeline.listTimelines();
const exists = db.timeline.hasTimeline('wikipedia');
await db.timeline.deleteTimeline('wikipedia');

await db.timeline.insert('wikipedia', id, { start: '1720', end: '1720' });              // year
await db.timeline.insert('wikipedia', id, { start: '1720-01', end: '1720-12' });        // month
await db.timeline.insert('wikipedia', id, { start: '1720-01-01', end: '1720-12-31' });  // day
await db.timeline.insert('wikipedia', id, { start: '1720-01-01T00:00:00Z' });           // second
await db.timeline.insert('wikipedia', id, { start: '1720-01-01T00:00:00.123Z' });       // ms
await db.timeline.insert('wikipedia', id, { start: '541 MYA', end: '252 MYA' });        // Myr

// Explicit scale when the input is ambiguous or already normalized
await db.timeline.insert('wikipedia', paleozoicId, {
    start: { scale: 'Myr', value: -541n },
    end: { scale: 'Myr', value: -252n },
});
```

Documents can also carry app-extracted timeline entries at the root. SynapsD indexes these on write and refreshes them on update; the database does not extract dates from content.

```js
const articleId = await db.put({
    schema: 'data/abstraction/document',
    data: { title: 'Magna Carta', text: 'Agreed at Runnymede in 1215.' },
    timelines: [{ name: 'wikipedia', start: '1215', end: '1215' }],
});
```

`name` is the timeline; `timeline` is accepted as an alias. `scale` is optional and inferred when safe. An omitted `end` means "instant"; an explicit `end: null` means an **open** (ongoing) interval. On update, SynapsD removes the document from timelines declared on the old or new document, then indexes the new entries — manually-added entries not declared on the document are left alone.

## Spatial index (S2)

Documents with GPS coordinates (`metadata.geo.lat` / `metadata.geo.lon`) are indexed into a single bit-sliced index over their **S2 cell id** at level 21 (~5 m, since GPS accuracy is 3 to 10 m and finer would be fake precision). Fully derived: coordinates appear and it is indexed; coordinates are removed or the document is deleted and it is dropped. Exact `(0, 0)` is rejected — `Number(null)` is 0 and finite, so a `{ lat: null, lon: null }` record would otherwise answer bbox queries covering Null Island.

The trick that keeps this one BSI instead of a per-cell bitmap zoo: S2 ids are hierarchical, so every ancestor cell covers one **contiguous id range** of its descendants. "In cell X" at any zoom level is a single `BETWEEN` range query. A region query runs the S2 region coverer (up to 20 cells) and ORs the per-cell ranges. Bitmap population is fixed at the slice width (~65) regardless of data density, precision, or query zoom.

```js
const inView = await db.list({
    features: ['data/abstraction/file'],
    filters: ['geo:bbox:47.5,15.5,48.8,17.8', 't:content:2023-01-01..2023-12-31'],
    sortBy: 'content',
});

const nearby = await db.list({ filters: ['+geo:near:48.1486,17.1077,5km', '!tag/private'] });

// Programmatic (returns RoaringBitmap32):
await db.geo.queryBBox(minLat, minLon, maxLat, maxLon);
await db.geo.queryRadius(lat, lon, radiusMeters);
await db.geo.queryCells([cellId, …]);
```

Candidate-set semantics are deliberately lossy: coverings may slightly overshoot the region boundary. Precise containment (and rendering) is the client's job via the raw `metadata.geo` coordinates.

## Bitmap index

Roaring bitmaps back every membership lookup. Allowed key prefixes are validated in `src/indexes/bitmaps/lib/keys.js`: `internal/`, `context/`, `vfs/`, `feature/`, `device/`, `client/`, `tag/`, `data/`, `custom/`. See **Features** for the prefix conventions.

> `rel/` is deliberately **absent** from that list. Typed edges moved to dupsort adjacency in v3, and keeping the prefix out makes any straggler bitmap write throw instead of silently creating a second, stale relation store.

Notable `internal/*` keys:

| Key | Role |
|-----|------|
| `internal/docs/all` | Live-document membership; makes the "all documents" base O(1) |
| `internal/gc/deleted` | Soft-deleted document set (id free pool) |
| `internal/ts/<timeline>/<scale>/{start,end,ts}` | Timeline BSI tiers (`ts` for point timelines) |
| `internal/geo/s2` | Spatial S2 cell-id BSI slices |
| `internal/lance/fts` | Lance FTS index coverage |
| `internal/embed/vectors/<space>/<model-slug>` | Vector presence per space+model |
| `internal/embed/seen/<space>/<model-slug>` | Embedding work-ledger ("processed") |
| `internal/schemaVersion` | Applied schema version (an internal-store KV, not a bitmap) |

### Introspection (`db.bitmapIndex`)

```js
const keys = await db.bitmapIndex.listBitmaps();                              // omits internal/*
const allKeys = await db.bitmapIndex.listBitmaps('', { includeInternal: true });
const timelineKeys = await db.bitmapIndex.listBitmaps('internal/ts');
const treeLayers = await db.bitmapIndex.listBitmaps(`context/${treeId}`);
```

- **No prefix**: all keys except `internal/*`, unless `includeInternal: true`.
- **With prefix**: range scan under that prefix (`prefix + '/'`), with no extra `internal/*` filtering.

Load a bitmap with `getBitmap(key)`, which returns a `Bitmap` instance with `size`, `has(id)`, `toArray()`, and friends. Find which bitmaps contain a document via `getBitmapsForDocument(id, prefix?)` on the main `db` object.

(canvas-server exposes an HTTP equivalent; its routes are documented in that project's `docs/API.md`, not here — synapsd itself has no HTTP surface.)

## Trees

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

db.getTreePaths('filesystem');   // ['/', '/docs', '/docs/contracts', …]
db.getTreeJson('projects');      // { id, type, name, children: [...] }
```

### Staging pattern (consumer convention)

SynapsD has no built-in concept of "incoming" or "staging". If your app needs one, create a dedicated tree and use `link` / `unlink` to promote documents:

```js
await db.createTree('incoming', 'directory');

const id = await db.put(
    { schema: 'data/abstraction/email', data: { subject: 'Invoice', from: 'billing@example.com' } },
    { directory: { tree: 'incoming', path: '/email/imap/account-a/inbox' } },
);

await db.link(id, { context: { tree: 'projects', path: '/finance/invoices' }, features: ['tag/triaged'] });
await db.unlink(id, { directory: { tree: 'incoming', path: '/email/imap/account-a/inbox' } });

const docs = await db.list({ paths: ['!ctx:/staging'] });
```

Tree metadata lives in the internal store; tree memberships map to typed bitmap namespaces.

## Datasets

Datasets are path-independent ingest provenance: a `data/dataset/<name>` key stamped at ingest via `spec.features` (and preserved on the row across updates that omit it).

They get their own algebra bucket in `resolveCandidates`. Every document implicitly belongs to a **virtual `default` dataset** (= stamped with none), and the candidate set is intersected with the union of *selected* datasets, with `default` selected to begin with:

- `anyOf data/dataset/X` — **adds** X to the mix.
- `allOf data/dataset/X` — shows only X (the ordinary feature AND constrains).
- `noneOf data/dataset/X` — deselects X.

`anyOf`/`noneOf` dataset keys are pulled out of the generic feature buckets, because a plain OR-union would let dataset documents bypass the caller's other feature filters.

```js
await db.listDatasets();                              // [{ name, key, documentCount }]
await db.deleteDataset('scan-2026-08', { dropDocuments: true });
```

## Migration and rebuild

The v3 refactor bumped the persisted schema version to **2**. The migration **rewrites every document row**, which is why a stale database **refuses to open** rather than migrating implicitly on a server restart — it is an operator action, taken deliberately, ideally after a backup.

```sh
# Per workspace DB directory, e.g. server/users/<user>/workspaces/<ws>/db
node scripts/migrate-v3.js -d <workspace-db-dir> --dry-run
node scripts/migrate-v3.js -d <workspace-db-dir>
```

Or programmatically: `new SynapsD({ path, migrate: true })`, or by environment: `CANVAS_SYNAPSD_MIGRATE=true` (accepts `1`/`true`/`yes`/`on`). The env var exists because `migrate` is a whole-database switch and the DB is usually constructed deep inside a host process — canvas-server opens one per workspace — where threading a flag down means touching every call site. After `start()`, `db.lastMigrationStats` holds the counters (`null` when nothing ran). A brand-new or empty database is stamped and skips the gate.

What the migration does — all of it idempotent, since every step makes the row match what current code would produce:

1. Recovers asserted tags that existed **only** in bitmaps (pre-2026-07-15 rows had no doc-side record — the last state with no rebuild source, which is the whole reason `features[]` moved onto the row).
2. Drops the derived namespaces this rev removed or reshaped: `rel/*`, `data/source/*`, `data/backend/*`, `data/kind/*`.
3. Per row: drops `indexOptions`; moves `metadata.features` → root `features[]` (stripping derived keys); migrates Dotfile `data.repoPath` → normalized `data.url`; stamps `kind`.
4. Replays the derived plane from the rewritten rows — facet/kind/mime bitmaps, location-derived device and backend features, asserted feature membership, and asserted edges from `data.relations`.

It does **not** rename schema ids: `data/abstraction/*` stays, so the one document class with no rebuild source outside the DB (tabs) is never re-keyed.

### `rebuildL3()`

The same replay, available on demand — the rebuild invariant made executable. It composes the existing reindexers rather than paralleling them.

```js
await db.rebuildL3();                                   // edges + bitmaps (defaults)
await db.rebuildL3({ src: 'extractor:ner' });           // only that extractor's derived edges
await db.rebuildL3({ timelines: true, search: true });  // + crud timelines, + FTS
```

| Option | Default | Effect |
|--------|---------|--------|
| `edges` | `true` | Drop and re-derive edges. With `src`, only that source's derived edges (asserted ones have no meta row and are reproduced from the rows anyway); without it, the whole edge plane is cleared |
| `bitmaps` | `true` | Drop and re-derive `data/kind/*`, `data/backend/*`, `data/mime/*` |
| `timelines` | `false` | `reindexCrudTimelines()` |
| `search` | `false` | `reindexSearchIndex({ rebuild: true })` |
| `embeddings` | `false` | `reindexEmbeddings()` (expensive) |

Targeted reindexers remain available: `reindexCrudTimelines()`, `reindexMimeBitmaps()`, `reindexSearchIndex()`, `reindexEmbeddings()`.

## Events (`src/utils/events.js`)

Event names live in the frozen `EVENTS` map. Rename a constant there to rename the string everywhere consumers match on.

**Lifecycle**: `started` (`STARTED`), `beforeShutdown` (`BEFORE_SHUTDOWN`), `shutdown` (`SHUTDOWN`)

**Document CRUD**: `document.inserted`, `document.updated`, `document.removed`, `document.deleted`

**Batch variants** — one event per bulk op, so a 1000-doc insert does not fan out into 1000 socket emits: `document.inserted.batch` (`{ ids, count, context, directory }`), `document.updated.batch`, `document.removed.batch`, `document.deleted.batch`. Back-compat: insert/update batches *also* emit the singular event once with `{ ids, batch: true }`. Batch-aware consumers should match on the `.batch` names.

**Membership**:

- `document.linked` / `document.unlinked`: first-class membership events carrying the **full document** plus what changed. The full document is the point: automation can match on *content*, which the membership-only `document.updated`/`document.removed` payloads cannot support. Back-compat: `link`/`unlink` also emit the older membership-only forms.
- `membership.changed`: emitted post-commit with the exact collection bitmap keys ticked or unticked — `{ changes: [{ docId, op: 'tick'|'untick', keys }] }`. Drives precise live invalidation in `QuerySession`. Fires before the corresponding `document.*` event, so a session re-resolves against already-committed bitmaps.

**Tree management**: `tree.created`, `tree.deleted`, `tree.renamed`
**Tree path**: `tree.path.inserted|moved|copied|removed|locked|unlocked`
**Tree layer**: `tree.layer.merged|subtracted|converted|updated`
**Tree document**: `tree.document.inserted[.batch]`, `tree.document.removed[.batch]`, `tree.document.deleted[.batch]` — tree-scoped mirrors of the document events, driving the web UI and browser extension.
**Tree lifecycle**: `tree.recalculated`, `tree.saved`, `tree.loaded`, `tree.error`
**Datasets**: `dataset.deleted` (a literal string, not yet an `EVENTS` constant)

Payloads are wrapped with `SynapsDEvent` (helpers `createEvent` / `createTreeEvent`). The envelope always carries `event`, `eventId` (usable as an idempotency key), `source`, an ISO `timestamp`, the **provenance** triple (`origin`, `causedBy`, `depth`), and `treeId`/`treeName`/`treeType` on tree-scoped events. That triple is what lets automation bound its own cascades — a rule reacting to `document.inserted` can stop when `depth` exceeds its budget or when it recognizes its own `causedBy` chain.

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

Legacy method names like `findDocuments`, `ftsQuery`, and `insertDocument` are no longer the intended API and should be treated as dead.

### Reads

| Method | Notes |
|--------|-------|
| `get(id, options?)` | `options = { parse }` |
| `query(match, spec?)` | `match: string \| { text }`; ranked when `match` is set |
| `list(spec?)` | Equals `query(null, spec)`; structural listing, no ranking |
| `search(spec)` | Wrapper: `query(spec.query ?? spec.search ?? spec.q, spec)` |
| `searchRefined(queries[], baseSpec?, opts?)` | Stateless multi-query refinement; `opts = { limit, offset, mode }` |
| `searchCompound(lines[], opts?)` | Fuses per-line rankings instead of chaining them |
| `openSession(specs?, opts?)` | Long-running refinable/live query session |
| `getByChecksumString(checksum, options?)` | `options = { parse, schema }` |
| `has(id, spec?)` / `hasByChecksumString(checksum, spec?)` | Membership probe, no document fetch |
| `resolveCandidates(spec)` | Candidate-set stage: `{ bitmap, keys, collectionKeys, coarse }` |
| `rank(bitmap, match, opts?)` | Materialize/score stage |
| `listTreeDocuments(treeNameOrId, options?)` | |

### Writes

| Method | Notes |
|--------|-------|
| `put(document, spec?)` | Creates or updates; returns the numeric id |
| `putMany(documents, spec?)` | |
| `putManyDirectoryPaths(items, treeName, features?, options?)` | Bulk directory-tree ingest |
| `link(idOrIds, spec?)` / `linkMany(ids, spec?)` | Membership only |
| `unlink(idOrIds, spec?)` / `unlinkMany(ids, spec?)` | Membership only; document stays |
| `delete(id, options?)` / `deleteMany(ids, options?)` | Removes the row and all index entries |
| `relate(from, p, to, opts?)` / `unrelate(from, p, to)` | Typed edges; `opts = { meta, inheritMemberships }` |

### Trees and schemas

`createTree(name, type?, options?)`, `listTrees(type?)`, `getTree(nameOrId)`, `deleteTree(nameOrId)`, `renameTree(nameOrId, newName)`, `getTreePaths(nameOrId)`, `getTreeJson(nameOrId)`, `getDefaultContextTree()`, `getDefaultDirectoryTree()`, `listDocumentTreePaths(id, tree)`, `listDocumentTreeMemberships(id, tree)`, `hasDocumentTreeMembership(id, tree)`, `migrateDocumentMemberships(fromId, toId, opts?)`

`listSchemas(prefix?)`, `getSchema(id)`, `hasSchema(id)`, `getDataSchema(id)`, `getJsonSchema(id)` — registration itself goes through the `schemaRegistry` singleton (`registerSchema` / `unregisterSchema` / `getSchemaEntry` / `resolveKind`).

### Maintenance and introspection

| Method | Notes |
|--------|-------|
| `getStats()` | Async stats including FTS and dense-vector internals |
| `setSearchTuning(tuning)` | `{ imageMaxDistance, searchWeights }` at runtime |
| `storeDocumentEmbeddings(docId, schema, updatedAt, chunks, opts?)` | Externally-computed vectors; `opts = { space }` |
| `getUnembeddedDocIds(space?, schemas?)` | Embedding work-ledger; pure bitmap read, restart-safe |
| `rebuildL3(opts?)` | Umbrella L3 rebuild (see **Migration and rebuild**) |
| `reindexCrudTimelines(opts?)` | `{ scanned, created, updated }` |
| `reindexSearchIndex(opts?)` | Backfill or rebuild FTS, idempotent |
| `reindexEmbeddings(opts?)` | Reports the embedding gap for an external embedder |
| `reindexMimeBitmaps(opts?)` | Rebuild derived `data/mime/*` facets |
| `listDatasets()` / `deleteDataset(name, opts?)` | |
| `dumpDocuments(dstDir, …)` / `dumpBitmaps(dstDir, keys?)` | |

Sub-index handles: `db.timeline`, `db.geo`, `db.bitmapIndex`, `db.checksumIndex`, `db.synapses`, `db.edges`, `db.semantic`, `db.internalStore`, `db.lastMigrationStats`.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/migrate-v3.js -d <db-dir> [--dry-run]` | Apply the v3 schema migration |
| `scripts/reindex-crud.js -d <db-dir>` | Rebuild the `crud:*` timelines |
| `scripts/scan.js` | Recursively scan a directory into a DB, or query it (see `scripts/scan.readme.md`) |
| `scripts/bench-putmany.js`, `scripts/bench-tick-bitmaps.js` | Write-path benchmarks |

## Known limits

- **One position per timeline** per document — declaring more throws (see **Timelines**). Multi-position indexing is wanted but not built.
- **`rel` is one hop.** Multi-hop traversal is deliberately out of scope.
- **`g:`/`re:` filters** are recognised but unimplemented, and throw at parse time.
- **Sigil consistency for raw bitmap keys**: raw keys in `filters` AND together, while `t:`/`geo:` tokens default to anyOf-OR. Known inconsistency, to be resolved in one sweep.
- **Recipient edges** (email To/Cc → identity) are deferred: the role is distinct from authorship and cannot live in edge meta without colliding with the asserted-edge convention. `data.to`/`data.cc` stay ordinary fields until the reverse query is actually wanted.
- **`link()` features are bitmap-only** and do not survive an L3 rebuild — put durable tags on the document.

## References

- [LMDB Documentation](http://www.lmdb.tech/doc/)
- [Roaring Bitmaps](https://roaringbitmap.org/)
- [LanceDB](https://lancedb.com/)
- [S2 Geometry](https://s2geometry.io/)
- [RFC 5545 (iCalendar)](https://datatracker.ietf.org/doc/html/rfc5545)
- [Why-not-indices](https://stackoverflow.com/questions/1378781/proper-terminology-should-i-say-indexes-or-indices)

## License

Licensed under AGPL-3.0-or-later. See main project LICENSE file.

---
This project is funded by [Augmentd Labs](https://augmentd.eu/en/labs)
