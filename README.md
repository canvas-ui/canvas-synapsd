# SynapsD

SynapsD is a small KV database built on top of `LMDB` with `roaring-bitmap` and `lancedb` based indexes, primarily used as an in-process index and, secondarily, as a JSON document store for [Canvas Workspaces](https://github.com/canvas-ui/canvas-server).

This module is meant to index all data from configured data sources of a Workpace (files, emails, notes, browser tabs, github repos, dotfiles etc), and provide a unified virtual fs-like tree abstraction on top that should ideally mimick whatever mental model you need to make work with your data more efficient.

## View abstractions

### Context trees

Contex trees are built on top of unique-by-name layers linked to bitmaps.
- `ctx:/work/customer-a/devops/issues/issue-1001` - Does a logical AND on all path-based bitmaps, result bitmap represents all data linked to issue 1001
- `ctx:/work/customer-a/devops/issues/issue-1002` - Result bitmap represents all data linked to issue 1002
- `ctx:/work/customer-a/devops/issues` - Result bitmap shows all data linked to all indexed issues
- `ctx:/issues` - Ad-hoc path that would show all data related to all issues across all customers

Compared to FS-like trees, there are a couple of additinal methods for day-to-day use
- `merge layer` - Merge a selected layer(bitmap) to 1-N additional layers (more comprehensive description TBD)
- `subract layer` - Subtract a selected layer(bitmap) from 1-N additional layers (description TBD)

Context trees enable a natural "zoom" feature on top of indexed data, and paired with session-based "evolving queries" a way to fine-tune retrieval dynamically (query for "project emails", add thisWeek, add !today, add "dc migration", add "*.pdf")

### Directory trees

More familiar UX, a virtual directory is a self-contained movable/copyable container; 

### Sessions for real-time contextual data streaming

v4 feature for evolving long-running queries

## Core components

- `LMDB` as the storage backend(for now at least).
- `Roaring bitmaps` context, feature and membership lookups.
- `LanceDB` handles ranked search: BM25 full-text plus dense-vector / hybrid (RRF).
- `ContextTree` provides layered/intersection semantics.
- `DirectoryTree` provides exact folder semantics with unique node IDs.

## Canonical API (v3)

The public read surface is just `list()` + `query()`. Writes take `(document, spec)`
where `spec = { paths, features }`.

- `get(id, options?)`
- `query(match, spec?)` - `match: string | { text }`; ranked when `match` is set
- `list(spec?)` - equals `query(null, spec)`; structural listing, no ranking
- `search(spec)` - thin wrapper kept for back-compat: `query(spec.query, spec)`
- `put(document, spec?)` - `spec = { paths, features }`
- `putMany(documents, spec?)`
- `link(idOrIds, spec?)`
- `linkMany(ids, spec?)`
- `has(id, spec?)`
- `unlink(idOrIds, spec?)`
- `unlinkMany(ids, spec?)`
- `delete(id, options?)`
- `deleteMany(ids, options?)`
- `getByChecksumString(checksum, options?)`
- `hasByChecksumString(checksum, spec?)`
- `resolveCandidates(spec) -> { bitmap, keys }` - the candidate-set stage of a query, exposed for sessions
- `rank(bitmap, match, { mode, limit, offset }) -> page` - the materialize/score stage
- `storeDocumentEmbeddings(docId, schema, updatedAt, chunks)` - app-provided vectors (see **Semantic search**)
- `getStats()` - async stats incl. FTS + dense-vector internals
- `listDocumentTreePaths(id, treeNameOrId)`
- `listDocumentTreeMemberships(id, treeNameOrId)`
- `hasDocumentTreeMembership(id, treeNameOrId)`
- `createTree(name, type?, options?)`
- `listTrees(type?)`
- `getTree(nameOrId)`
- `deleteTree(nameOrId)`
- `renameTree(nameOrId, newName)`
- `getTreePaths(nameOrId)`
- `getTreeJson(nameOrId)`
- `getDefaultContextTree()`
- `getDefaultDirectoryTree()`

Legacy method names like `findDocuments`, `ftsQuery`, `insertDocument`, and friends are no longer the intended API and should be treated as dead.

## CRUD examples

Assumes a started database:

```js
const db = new SynapsD({ path: '...' });
await db.start();
```

Reusable write spec. `paths` uses the `ctx:`/`dir:` grammar (default trees); for a
non-default tree pass a tree-qualified selector via `context`/`directory`:

```js
const noteSpec = {
    paths: ['ctx:/work/project-a'],
    features: ['data/abstraction/note', 'tag/inbox'],
};
// tree-qualified equivalent:
const projectTreeSpec = { context: { tree: 'projects', path: '/work/project-a' } };
```

Write methods tick every feature you pass. Query feature buckets default to `anyOf`;
`+` promotes to `allOf`, `!` excludes (`noneOf`).

### Create

`put()` creates a new row when the document has no existing `id`. It returns the numeric document id.

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
    { context: { tree: 'projects', path: ['/work/project-a', '/work/shared'] }, features: ['data/abstraction/note'] },
);
```

### Read

`get()` and `getByChecksumString()` return a parsed document instance by default. Pass `{ parse: false }` to get raw stored data. Tree-aware membership checks use `has()` / `hasByChecksumString()`.

```js
const doc = await db.get(id);
const rawDoc = await db.get(id, { parse: false });

const docByChecksum = await db.getByChecksumString('sha256:...');

const existsAnywhere = await db.has(id);
const existsInProjectsTree = await db.has(id, { context: { tree: 'projects', path: '/work/project-a' } });
const existsWithInboxFeature = await db.has(id, { paths: ['ctx:/work/project-a'], features: ['tag/inbox'] });

const checksumExistsInProject = await db.hasByChecksumString(
    'sha256:...',
    { context: { tree: 'projects', path: '/work/project-a' }, features: ['data/abstraction/note'] },
);
```

Structural and ranked listing use `list(spec)` and `search(spec)`; see **Query shape** below.

### Update

`put()` updates when `document.id` already exists.

Important fix: `put({ id, data: ... })` replaces `data`; it does not deep-merge fields. If you want to change a single field, read the document first and send the full updated `data` object. If you only want to change memberships, use `link()` / `unlink()`.

```js
const current = await db.get(id);

await db.put(
    {
        id,
        schema: current.schema,
        data: {
            ...current.data,
            title: 'Updated title',
        },
        metadata: current.metadata,
    },
    noteSpec,
);

await db.link(id, { context: { tree: 'projects', path: '/work/project-a' }, features: ['tag/reviewed'] });
await db.link(id, { directory: { tree: 'filesystem', path: ['/notes', '/archive/notes'] }, features: ['tag/filed'] });
```

### Delete

`unlink()` removes memberships only. The document stays in LMDB.

`delete()` removes the document row, checksum index entries, timeline index entries, and synapse memberships. It returns `true` when a document was deleted and `false` when the id was not found.

Context-tree root `/` is a selector for "anything in this tree", not a real removable membership. Directory-tree root `/` is just the literal root folder.

```js
await db.unlink(id, { context: { tree: 'projects', path: '/work/project-a/deep' }, features: ['tag/inbox'] });

await db.unlink(id, { context: { tree: 'projects', path: '/work/project-a/deep' }, recursive: true });

await db.unlink(id, { directory: { tree: 'incoming', path: '/' } });

const deleted = await db.delete(id);
await db.delete(id, { emitEvent: false });

const linkResult = await db.linkMany([id1, id2], { context: { tree: 'projects', path: '/work/project-a' }, features: ['tag/reviewed'] });
const unlinkResult = await db.unlinkMany([id1, id2], { context: { tree: 'projects', path: '/work/project-a' }, features: ['tag/inbox'] });

const deleteResult = await db.deleteMany([id1, id2]);
```

`unlinkMany()` and `deleteMany()` return `{ successful, failed, count }`. Batch delete/unlink ids must be numbers; numeric strings are accepted by `get()` / `put()` but rejected by the batch helpers.

## Querying: one seam, two entry points

A query is two pure stages:

```
resolveCandidates(spec) -> { bitmap, keys }   // paths ∩ features ∩ filters
rank(bitmap, match, { mode, limit, offset })  // match=null => slice; else fts/vector/hybrid
query(match, spec) = rank(resolveCandidates(spec).bitmap, match, spec)
list(spec)         = query(null, spec)
```

### `list(spec)` - structural listing

`query(null, spec)`. Returns documents matching the candidate set (tree membership,
features, timeline/bitmap filters) in insertion order. No ranking. With no buckets,
`list` returns every document. Default limit is 100; pass `limit: 0` to return all
matches.

### `query(match, spec)` / `search(spec)` - ranked retrieval

`match` is a string (or `{ text }`). The candidate set scopes a full-text/vector
search (LanceDB), ranked by relevance. `search(spec)` is a thin wrapper that pulls
`match` from `spec.query`. Default limit is 50. `mode` selects `hybrid` (default),
`fts`, or `vector`; vector/hybrid fall back to `fts` when the dense stack is down.

### Spec buckets and sigil algebra

Buckets intersect (`paths ∩ features ∩ filters`); items within a bucket follow a
uniform sigil algebra: default `anyOf` (OR), `+` `allOf` (gate), `!` `noneOf` (exclude).

| Field | Description |
|-------|-------------|
| `paths` | `['ctx:/a/b', 'dir:/x', '!ctx:/staging']` or `{ in, not }`. `ctx:`/`dir:` target default trees |
| `context` / `directory` | Tree-qualified selector `{ tree, path }` - use when you need a non-default tree |
| `features` | `['+tag/red', 'tag/blue', '!tag/spam']` or `{ allOf, anyOf, noneOf }` |
| `filters` | `['t:crud:updated:thisWeek', '+t:wikipedia:1996', '!t:crud:created:today']` (see filter grammar) |
| `mode` | `hybrid` (default) \| `fts` \| `vector` (ranked queries only) |
| `limit` | Max documents (`list`: 100, `query`: 50; `0` = all matches) |
| `offset` / `page` | Pagination |
| `parse` | Set `false` to return raw stored data |

### Filter grammar

Filters share the sigil algebra and dispatch on a type prefix:

- `t:<name>:<spec>` - temporal. Reserved lifecycle form `t:crud:<action>:<timeframe|range>`
  (e.g. `t:crud:updated:thisWeek`, `t:crud:created:2026-01-01..2026-05-10`); content
  timelines use `t:<name>:<point|range>` (e.g. `t:wikipedia:1996`, `t:wikipedia:1996..1999`).
- `g:<glob>` and `re:<regexp>` - recognised but **not yet implemented** (throw).

Anything without a recognised prefix is treated as a raw bitmap key (ANDed).

### Return value

Both return an array with attached metadata:

- `result.count` - number of documents in this page
- `result.totalCount` - total matching documents (before pagination)
- `result.error` - error message string, or `null`

### Examples

```js
// list: all files in a path, excluding deleted, updated today
const docs = await db.list({
    paths: ['ctx:/foo/bar'],
    features: { allOf: ['data/abstraction/file'], noneOf: ['tag/deleted'] },
    filters: ['t:crud:updated:today'],
    limit: 100,
});

// list: directory tree, multiple paths (non-default tree -> selector)
const exactDirectoryMatches = await db.list({
    directory: { tree: 'filesystem', path: ['/docs/contracts', '/docs/invoices'] },
    features: ['data/abstraction/file'],
});

// list: everything except a staging context
const withoutStaging = await db.list({
    paths: ['!ctx:/staging'],
    features: ['data/abstraction/file'],
});

// query: ranked full-text within a scoped path
const ranked = await db.query('invoice', {
    paths: ['ctx:/finance/2026'],
    features: ['data/abstraction/file', 'tag/finance'],
    limit: 20,
});
```

## Semantic search (vectors)

`query()` defaults to `mode: 'hybrid'`: dense-vector kNN fused with BM25 via RRF. The
candidate bitmap (`paths ∩ features ∩ filters`) still scopes retrieval first; ranking
runs only on survivors. `vector`/`hybrid` degrade to `fts` when the dense stack is
unavailable, and `list()` (`match = null`) never embeds.

Dense vectors live in a LanceDB `vec_text` table at chunk granularity (one row per
`(docId, chunkId)`). Coverage is tracked by the `internal/lance/vectors` bitmap.

### What gets embedded

Only schemas in `embeddableSchemas` (default `['data/abstraction/note']`) are embedded
by the server. For those, it reads the schema's `vectorEmbeddingFields`, chunks the
text, and embeds the chunks. Everything else is FTS-only unless the app ships its own
vectors.

Files (`data/abstraction/file`) are **not** embedded: a file doc carries only
`locationUrls` (the `stored://` blob refs), not content. To make text searchable by
vector, ingest it as a `note`/`document` (which hold inline `data`), not as a blob.

### How it runs

- **Model:** local in-process ONNX via `fastembed`, `bge-small-en-v1.5` (384-dim). The
  worker thread is spawned lazily on first embed/query; the model is cached under
  `<root>/lance/models` (first use downloads ~130 MB).
- **Async + resumable:** `put`/`putMany` enqueue embeddable docs; the `EmbeddingQueue`
  embeds off the main thread. The presence bitmap lets it skip already-embedded docs,
  and `start()` backfills the unfinished tail after a crash/restart.
- **Query time:** the query string is embedded once, then vector/hybrid searched.

### App-provided vectors

For blobs/media the server can't read, compute vectors in the app and store them
directly (bypasses the queue):

```js
await db.storeDocumentEmbeddings(docId, schema, updatedAt, [
    { chunkId: 0, text: 'caption or transcript', vector: [/* dim floats */] },
]);
```

### Config & introspection

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

`await db.getStats()` returns a `.semantic` block (`model`, `dim`, `embeddableSchemas`,
plus `vector`, `embedder`, and `queue` sub-status) for diagnostics UIs.

## Timelines & Intervals

SynapsD supports source/domain timelines (`wikipedia`, `britannica`, `historian-x`, `crud:updated`) backed by internal scale tiers. The developer-facing name stays simple; internally each timeline owns lazy per-scale tiers for `Gyr`, `Myr`, `Kyr`, `year`, `month`, `day`, `second`, `ms`, and `ns`.

Each stored interval is normalized to `{ scale, start, end }`. If you omit `scale`, SynapsD infers it from the input and errors when it cannot do that safely. Inference is a convenience at the API edge; the index core always stores an explicit scale. No fake precision. Dinosaurs did not have millisecond timestamps, despite what software would like to believe.

### Storage modes: interval vs point-event

A tier is stored one of two ways:

- **Interval (Dual-BSI)** — two bit-sliced indexes per tier (`start` + `end`). Used for ranges that genuinely span time (`wikipedia` 1720–1750, geology eras). Overlap query: `start <= range.end AND end >= range.start`.
- **Point-event (single-BSI)** — one bit-sliced index per tier (`ts`). Used for **instants** (a thing happened at a moment). For an instant `start === end`, so the interval model's `end` BSI is pure duplication; the point tier halves the slice bitmaps **and** the per-insert slice writes. Range query: `ts >= range.start AND ts <= range.end`. The BSI's existence bitmap (`ebm`) doubles as the "which ids have this event" presence set — no separate membership bitmap needed.

A timeline is point-mode when its name is a `crud:*` lifecycle stamp (by convention) or is registered explicitly:

```js
// Register extra point-event timelines at construction.
const timeline = new TimelineIndex(bitmapIndex, { pointTimelines: ['visited', 'opened'] });
```

The mode is deterministic from the name, so it is stable across restarts without persisting a flag. Queries are identical regardless of mode — `queryInterval(...)` works the same; it just reads one BSI instead of two for point timelines. Existing interval timelines are unaffected.

### Open (unbounded) intervals

Interval timelines support open ends for things that started but have not finished — a person's life, an ongoing subscription, an unended era. Use the object form with an open marker:

```js
// Born 1912-12-12, still alive.
await db.timeline.insert('life', personId, { start: '1912-12-12', end: Infinity });

// Open lower bound: "everything up to 2000".
await db.timeline.insert('until', id, { start: -Infinity, end: '2000' });
```

Accepted open markers: `Infinity` / `-Infinity`, or the strings `'inf'`, `'+inf'`, `'infinity'`, `'∞'`, `'ongoing'`, `'present'` (upper) and `'-inf'`, `'-infinity'`, `'-∞'` (lower). The scale comes from the bounded endpoint; the open side is stored as a BSI extreme sentinel, so the normal overlap test (`end >= range.start`, `start <= range.end`) extends to ±∞ with no special query path. A query like "alive in 2026" (`{ start: '2026', end: '2026' }`) matches every still-open life automatically.

> For **inserts**, use the **object form** (`{ start, end }`) for open intervals — open markers are not supported in the positional `insert(name, id, start, end)` form, where an omitted end means "instant" (so crud stamps stay points).

**Open-ended queries.** On `queryInterval`, a `null`/omitted bound means open on that side — handy for "from X onwards" / "up to Y":

```js
await db.timeline.queryInterval('life', '1990');        // [1990, +∞): anything still active at/after 1990
await db.timeline.queryInterval('life', null, '2000');  // (-∞, 2000]: anything that had started by 2000
await db.timeline.queryInterval('life', '2008', '2008'); // bounded point: active in 2008
```

(The filter layer always passes explicit start+end, so `t:` timeline filters are unaffected.)

### Multi-timeline retrieval — `mode: 'grouped'` (zeitgeist)

`queryInterval` takes one or more timeline names and a query `mode`:

- `union` (default) — one flat id array across all timelines and scales.
- `layers` — `{ name: { scale: [ids] } }`, per timeline **and** per scale.
- `grouped` — `{ name: [ids] }`, per timeline with scales pre-unioned.

`grouped` is the one-call primitive for "what was the world like at instant X" — pick a point and fan it across every relevant timeline at once. Because queries span all scale tiers, a single instant matches a king's reign stored at `year` **and** the geological era stored at `Myr` in the same call; open-ended ("ongoing") intervals match naturally.

```js
// Zeitgeist of the year 600: one id list per timeline.
const z = await db.timeline.queryInterval(
  ['wikipedia', 'historian-foo', 'geology', 'climate'],
  { start: '600', end: '600' },   // the instant
  { mode: 'grouped' },
);
// → {
//   wikipedia:        [periodId, ...],   // "Early Middle Ages" (500–800)
//   'historian-foo':  [kingId, ...],     // rulers/authors alive in 600 (incl. open-ended dynasties)
//   geology:          [eraId],           // Quaternary  (−2 Myr → ongoing)  — NOT Paleozoic (long over)
//   climate:          [],                // requested but nothing indexed → []
// }
```

Every requested timeline is present in the result (empty as `[]`). Scale precision is intentional: year 600 converts to ~0 `Myr`, so it lands "in the Quaternary" — the `Myr` tier distinguishes eras, the `year` tier distinguishes centuries. Composing the per-timeline ids into a single narrative object is left to the caller; `grouped` just hands you the buckets.

Canonical calendar/time semantics:
- Calendar dates use the proleptic Gregorian calendar internally.
- Year numbering is astronomical internally (`0` = `1 BCE`, `-1` = `2 BCE`). Importers/UI can translate BCE/CE for humans.
- Modern instants are treated as UTC-ish civil time.
- Leap seconds are ignored. This is a personal/workspace event database, not a spacecraft.
- Deep-time values should use scaled coordinates (`Gyr`, `Myr`, `Kyr`) instead of calendar dates.

### System CRUD Timelines

Document lifecycle events are automatically indexed into `crud:created`, `crud:updated`, and `crud:deleted` timelines. These are **point-event** timelines (instants, single-BSI) pinned to **second** resolution — ms precision on a wall-clock lifecycle stamp is spurious and only widens the BSI. You filter queries using `t:` strings in the `filters` array.

Formats:
- `t:crud:ACTION:TIMEFRAME` (e.g., `t:crud:updated:thisWeek`)
- `t:crud:ACTION:START..END` (e.g., `t:crud:created:2026-01-01..2026-05-10`)

Supported timeframe tokens: `now` (current hour), `today`, `yesterday`, `tomorrow`, `lastWeek`, `thisWeek`, `nextWeek`, `lastMonth`, `thisMonth`, `nextMonth`, `lastYear`, `thisYear`, `nextYear`, `lastDecade`, `thisDecade`, `nextDecade`, `lastCentury`, `thisCentury`, `nextCentury`, `lastMillennium`, `thisMillennium`, `nextMillennium`.

```js
// allOf gate: created this week AND updated today
const recentDocs = await db.list({
    paths: ['ctx:/projects'],
    filters: ['+t:crud:created:thisWeek', '+t:crud:updated:today'],
});
```

CRUD timestamps are stored at second resolution as point events; timeframe queries fan out across the internal tiers so `today`, `thisWeek`, and explicit ranges still find matching CRUD events regardless of the tier they were written to.

#### Reindexing crud timelines

The crud timelines moved from interval/ms (dual-BSI) to point-event/second (single-BSI) storage. A DB populated **before** that change has crud memberships in tiers the new code never reads — `t:crud:*` filters will return nothing for those docs until the timelines are rebuilt. Run the one-time, idempotent rebuild (deletes the stale crud bitmaps, re-derives `crud:created`/`crud:updated` from each document's `createdAt`/`updatedAt`):

```sh
# Per workspace DB directory (e.g. server/users/<user>/workspaces/<ws>/db)
node scripts/reindex-crud.js -d <workspace-db-dir>
```

Or programmatically: `await db.reindexCrudTimelines()`. Note: `crud:deleted` is not rebuilt — those documents are gone — so past deletion history is dropped.

### Custom Timelines

Use `db.timeline` for custom source/domain timelines.

```js
await db.timeline.createTimeline('wikipedia');
await db.timeline.createTimeline('britannica');

const wikiEventId = await db.put({ schema: 'event', data: { title: 'Fall of Rome' } });
const britEventId = await db.put({ schema: 'event', data: { title: 'Roman Empire collapses' } });

// Scale inferred as day.
await db.timeline.insert('wikipedia', wikiEventId, {
    start: '0476-01-01',
    end: '0476-12-31',
});

// Scale inferred as second.
await db.timeline.insert('britannica', britEventId, {
    start: '0476-09-04T00:00:00Z',
    end: '0476-09-04T23:59:59Z',
});
```

Supported inference examples:

```js
await db.timeline.insert('wikipedia', id, { start: '1720', end: '1720' });         // year
await db.timeline.insert('wikipedia', id, { start: '17200101', end: '17201231' }); // day
await db.timeline.insert('wikipedia', id, { start: '1720-01', end: '1720-12' });   // month
await db.timeline.insert('wikipedia', id, { start: '1720-01-01', end: '1720-12-31' }); // day
await db.timeline.insert('wikipedia', id, { start: '1720-01-01T00:00:00Z' });      // second
await db.timeline.insert('wikipedia', id, { start: '1720-01-01T00:00:00.123Z' });  // ms
await db.timeline.insert('wikipedia', id, { start: '541 MYA', end: '252 MYA' });   // Myr
```

Use explicit scale when the input is ambiguous or already normalized:

```js
await db.timeline.insert('wikipedia', paleozoicId, {
    start: { scale: 'Myr', value: -541n },
    end: { scale: 'Myr', value: -252n },
});
```

Documents can also carry app-extracted timeline entries at the root. SynapsD indexes these on `put()` / `putMany()` and refreshes them on update. The database does not extract dates from content; ingestion/app code owns that.

```js
const articleId = await db.put({
    schema: 'data/abstraction/document',
    data: {
        title: 'Magna Carta',
        text: 'Magna Carta was agreed at Runnymede in 1215.',
    },
    timelines: [
        {
            name: 'wikipedia',
            start: '1215',
            end: '1215',
        },
    ],
});
```

For a precise event, use one entry at the appropriate scale:

```js
const signingEventId = await db.put({
    schema: 'data/abstraction/document',
    data: {
        title: 'Magna Carta sealed',
        text: 'King John sealed Magna Carta on 1215-06-15.',
    },
    timelines: [
        {
            name: 'wikipedia',
            start: '1215-06-15',
        },
    ],
});
```

`name` is the source/domain timeline. `timeline` is accepted as an alias for `name`. `scale` is optional at the API edge and inferred when safe. Internally every entry is stored with explicit scale. On document update, SynapsD removes the document from timelines declared on the old or new document, then indexes the new entries. Manually-added timeline entries that are not declared on the document are left alone.

Queries fan out across the relevant internal tiers by default:

```js
// "What overlaps the year 476?"
const wikiMatches = await db.timeline.queryInterval('wikipedia', {
    start: '0476',
    end: '0476',
});

// Same query across multiple source timelines, deduped as one ID array.
const ids = await db.timeline.queryInterval(['wikipedia', 'britannica'], {
    start: '0476-09-04',
    end: '0476-09-04',
});

// Search every known timeline. `all` is also accepted.
const happenedIn1215 = await db.timeline.queryInterval('*', {
    start: '1215',
    end: '1215',
});

// Preserve layer/tier structure for UI overlays.
const layers = await db.timeline.queryInterval(['wikipedia', 'britannica'], {
    start: '0476',
    end: '0476',
}, {
    mode: 'layers',
});
```

Layer mode returns IDs grouped by source timeline and internal scale tier:

```js
{
    wikipedia: {
        day: [12, 18],
        second: [44]
    },
    britannica: {
        day: [21]
    }
}
```

Timeline management:

```js
await db.timeline.createTimeline('wikipedia');
const timelines = await db.timeline.listTimelines();
const exists = db.timeline.hasTimeline('wikipedia');
await db.timeline.deleteTimeline('wikipedia');
```

Current interval semantics are closed intervals: `[start, end]`. Open interval support belongs in the next pass.

## Bitmap index

Roaring bitmaps back every membership lookup. Keys use typed prefixes - validated in `indexes/bitmaps/lib/keys.js`:

| Prefix | Role |
|--------|------|
| `context/<treeId>/<layerUlid>` | Context-tree layer membership |
| `vfs/<treeId>/...` | Directory-tree folder membership |
| `tag/`, `data/`, `device/`, `custom/`, … | Feature/schema filters (also usable in query `filters`) |
| `internal/...` | Engine-managed indexes - hidden from default listings |

Notable `internal/*` keys:

- `internal/ts/<timeline>/<scale>/start|end` - timeline Dual-BSI tiers
- `internal/lance/fts`, `internal/lance/vectors` - Lance search index coverage
- `internal/gc/deleted` - soft-deleted document set

### Introspection (`db.bitmapIndex`)

```js
// User-facing bitmaps only (default - omits internal/*)
const keys = await db.bitmapIndex.listBitmaps();

// All keys, including engine-managed internal/*
const allKeys = await db.bitmapIndex.listBitmaps('', { includeInternal: true });

// Prefix scan - always returns keys under that prefix (internal/* included when prefix matches)
const timelineKeys = await db.bitmapIndex.listBitmaps('internal/ts');
const treeLayers = await db.bitmapIndex.listBitmaps(`context/${treeId}`);
```

`listBitmaps(prefix, { includeInternal })` behavior:

- **No prefix:** all keys except `internal/*`, unless `includeInternal: true`.
- **With prefix:** range scan under that prefix; no extra `internal/*` filtering.

Load a bitmap with `getBitmap(key)` (returns a `Bitmap` instance with `size`, `has(id)`, `toArray()`, etc.). Find which bitmaps contain a document via `getBitmapsForDocument(id, prefix?)` on the main `db` object (also omits `internal/*` when `prefix` is empty).

REST equivalent: `GET /rest/v2/workspaces/:id/bitmaps?includeInternal=true` (workspace must be started). See project `docs/API.md` for `includeData`, prefix paths, raw `.roar` download, and delete protections.

## Trees

SynapsD supports multiple named trees per workspace database. Trees are views on top of your documents - they organise membership and structure, not data. A single document can live in many trees at once.

Two tree types:

- **`context`** - layers with path-intersection semantics. Nodes in a context tree are called **layers**. Querying a path ANDs the bitmaps of every layer along that path.
- **`directory`** - unique folder nodes with filesystem-like semantics. Nodes are **directories**. Each directory has its own bitmap; recursive queries OR them.

### Tree management

```js
const meta = await db.createTree('projects', 'context');
const fsMeta = await db.createTree('filesystem', 'directory');

const trees = await db.listTrees();              // all trees
const contextTrees = await db.listTrees('context'); // filtered by type

const tree = db.getTree('projects');              // by name or ID
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

SynapsD has no built-in concept of "incoming" or "staging". If your app needs a staging area, create a dedicated tree and use the standard `link`/`unlink` API to promote documents. For example:

```js
await db.createTree('incoming', 'directory');

const id = await db.put(
    {
        schema: 'data/abstraction/email',
        data: { subject: 'Invoice', from: 'billing@example.com' },
    },
    { directory: { tree: 'incoming', path: '/email/imap/account-a/inbox' } },
);

// promote into a user tree, then remove from staging
await db.link(id, { context: { tree: 'projects', path: '/finance/invoices' }, features: ['tag/triaged'] });
await db.unlink(id, { directory: { tree: 'incoming', path: '/email/imap/account-a/inbox' } });

// exclude a staging context from broad queries
const docs = await db.list({ paths: ['!ctx:/staging'] });
```

Tree metadata lives in the internal store, while tree memberships are mapped to typed bitmap namespaces.

## Events (`src/utils/events.js`)

All `emit()` paths use the frozen `EVENTS` map. Rename a constant there to rename the string everywhere consumers match on.

Canonical strings (constant on `EVENTS` in parentheses):

### Lifecycle

- `started` (`STARTED`)
- `beforeShutdown` (`BEFORE_SHUTDOWN`)
- `shutdown` (`SHUTDOWN`)

### Document CRUD

- `document.inserted` (`DOCUMENT_INSERTED`)
- `document.updated` (`DOCUMENT_UPDATED`)
- `document.removed` (`DOCUMENT_REMOVED`)
- `document.deleted` (`DOCUMENT_DELETED`)

### Tree management

- `tree.created` (`TREE_CREATED`)
- `tree.deleted` (`TREE_DELETED`)
- `tree.renamed` (`TREE_RENAMED`)

### Tree path (structural)

- `tree.path.inserted` (`TREE_PATH_INSERTED`)
- `tree.path.moved` (`TREE_PATH_MOVED`)
- `tree.path.copied` (`TREE_PATH_COPIED`)
- `tree.path.removed` (`TREE_PATH_REMOVED`)
- `tree.path.locked` (`TREE_PATH_LOCKED`)
- `tree.path.unlocked` (`TREE_PATH_UNLOCKED`)

### Tree layer

- `tree.layer.merged` (`TREE_LAYER_MERGED`)
- `tree.layer.subtracted` (`TREE_LAYER_SUBTRACTED`)

### Tree document

- `tree.document.inserted` (`TREE_DOCUMENT_INSERTED`)
- `tree.document.inserted.batch` (`TREE_DOCUMENT_INSERTED_BATCH`)
- `tree.document.removed` (`TREE_DOCUMENT_REMOVED`)
- `tree.document.removed.batch` (`TREE_DOCUMENT_REMOVED_BATCH`)
- `tree.document.deleted` (`TREE_DOCUMENT_DELETED`)
- `tree.document.deleted.batch` (`TREE_DOCUMENT_DELETED_BATCH`)

### Tree lifecycle

- `tree.recalculated` (`TREE_RECALCULATED`)
- `tree.saved` (`TREE_SAVED`)
- `tree.loaded` (`TREE_LOADED`)
- `tree.error` (`TREE_ERROR`)

Payloads are wrapped with `SynapsDEvent` (or helpers `createEvent` / `createTreeEvent`). The envelope always carries `event`, `source` (`db` / `tree` / caller), ISO `timestamp`, and optional `treeId`, `treeName`, `treeType`; remaining keys come from the detail object without clobbering those fields. `createTreeEvent` fills tree metadata from a tree object and sets `source` to `tree`.

## Errors (`src/utils/errors.js`)

`SynapsDError` is the base class (correct `name`, captured stack). Specialized types:

| Class | Extra fields |
| ------- | ---------------- |
| `ValidationError` | `details` |
| `NotFoundError` | `id` |
| `DuplicateError` | `id` |
| `DatabaseError` | `operation` |
| `ArgumentError` | `argument` |

## Notes

- Checksums are first-class lookup keys.
- Batch methods return structured success/failure results.
- Query results are arrays with attached `count`, `totalCount`, and `error` metadata.
- Tree-scoped emissions should populate `treeId`, `treeName`, and `treeType` via the event envelope (see **Events** above).

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
