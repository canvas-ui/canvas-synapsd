# SynapsD

SynapsD is a small KV DB built on top of LMDB, primarily used as a in-process index and JSON document store for Canvas Workspaces.  

Its meant to index all data from a configured data source of a workpace (files, emails, notes, browser tabs, github repos, dotfiles etc), and provide a unified tree abstraction on top that should ideally mimick whatever mental model you need to make work with your data more efficient.

Context or Directory tree paths `/travel/2025/barcelona` and `/work/architecture/interior design/living room/` can return the same list of photos regardless whether they are stored at nas@home, beefy-pc, s3 or "corsair-usb"(client/consumer app can choose which indexed data path to use based on its contextual data).

Search is powered by roaring bitmaps and its api could use a cleanup :)  
Context tree - as one of the tree view abstractions - is built on top of bitmap-based "layers" directly and may take some time to get used-to.

Within a Context Tree, a `reports` layer in `/work/customer-a/reports` and `/work/customer-b/reports` is stored under the same uuid linking to the same bitmap - renaming/removing/updating one will update all occurences in the context tree.

Context layers filter different data based on `where they are placed`. Iow, 
- Moving `reports` to `/reports` would show you all data linked to the `reports` layer within your Universe
- Moving `reports` under `/work/customer-a/reports` would do a logical `AND` on the `work`, `customer-a` and `reports` layer bitmaps and result in a filtered view of data that are linked to `all of` the layers in your path(iow, return only data linked to customer-a).

## Core components

- `LMDB` as the storage backend(for now at least).
- `Roaring bitmaps` context, feature and membership lookups.
- `LanceDB` handles ranked/full-text search.
- `ContextTree` provides layered/intersection semantics.
- `DirectoryTree` provides exact folder semantics with unique node IDs.

## Canonical API (v3)

The public read surface is just `list()` + `query()`. Writes take `(document, spec)`
where `spec = { paths, features }`.

- `get(id, options?)`
- `query(match, spec?)` — `match: string | { text }`; ranked when `match` is set
- `list(spec?)` — equals `query(null, spec)`; structural listing, no ranking
- `search(spec)` — thin wrapper kept for back-compat: `query(spec.query, spec)`
- `put(document, spec?)` — `spec = { paths, features }`
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
- `resolveCandidates(spec) -> { bitmap, keys }` — the candidate-set stage of a query, exposed for sessions
- `rank(bitmap, match, { mode, limit, offset }) -> page` — the materialize/score stage
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

### `list(spec)` — structural listing

`query(null, spec)`. Returns documents matching the candidate set (tree membership,
features, timeline/bitmap filters) in insertion order. No ranking. With no buckets,
`list` returns every document. Default limit is 100; pass `limit: 0` to return all
matches.

### `query(match, spec)` / `search(spec)` — ranked retrieval

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
| `context` / `directory` | Tree-qualified selector `{ tree, path }` — use when you need a non-default tree |
| `features` | `['+tag/red', 'tag/blue', '!tag/spam']` or `{ allOf, anyOf, noneOf }` |
| `filters` | `['t:crud:updated:thisWeek', '+t:wikipedia:1996', '!t:crud:created:today']` (see filter grammar) |
| `mode` | `hybrid` (default) \| `fts` \| `vector` (ranked queries only) |
| `limit` | Max documents (`list`: 100, `query`: 50; `0` = all matches) |
| `offset` / `page` | Pagination |
| `parse` | Set `false` to return raw stored data |

### Filter grammar

Filters share the sigil algebra and dispatch on a type prefix:

- `t:<name>:<spec>` — temporal. Reserved lifecycle form `t:crud:<action>:<timeframe|range>`
  (e.g. `t:crud:updated:thisWeek`, `t:crud:created:2026-01-01..2026-05-10`); content
  timelines use `t:<name>:<point|range>` (e.g. `t:wikipedia:1996`, `t:wikipedia:1996..1999`).
- `g:<glob>` and `re:<regexp>` — recognised but **not yet implemented** (throw).

Anything without a recognised prefix is treated as a raw bitmap key (ANDed).

### Return value

Both return an array with attached metadata:

- `result.count` — number of documents in this page
- `result.totalCount` — total matching documents (before pagination)
- `result.error` — error message string, or `null`

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

## Timelines & Intervals

SynapsD supports source/domain timelines (`wikipedia`, `britannica`, `historian-x`, `crud:updated`) backed by internal scale tiers. The developer-facing name stays simple; internally each timeline owns lazy Dual-BSI tiers for `Gyr`, `Myr`, `Kyr`, `year`, `month`, `day`, `second`, `ms`, and `ns`.

Each stored interval is normalized to `{ scale, start, end }`. If you omit `scale`, SynapsD infers it from the input and errors when it cannot do that safely. Inference is a convenience at the API edge; the index core always stores an explicit scale. No fake precision. Dinosaurs did not have millisecond timestamps, despite what software would like to believe.

Canonical calendar/time semantics:
- Calendar dates use the proleptic Gregorian calendar internally.
- Year numbering is astronomical internally (`0` = `1 BCE`, `-1` = `2 BCE`). Importers/UI can translate BCE/CE for humans.
- Modern instants are treated as UTC-ish civil time.
- Leap seconds are ignored. This is a personal/workspace event database, not a spacecraft.
- Deep-time values should use scaled coordinates (`Gyr`, `Myr`, `Kyr`) instead of calendar dates.

### System CRUD Timelines

Document lifecycle events are automatically indexed into `crud:created`, `crud:updated`, and `crud:deleted` timelines. You filter queries using `t:` strings in the `filters` array.

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

CRUD timestamps are stored with their natural Date precision, but timeframe queries fan out across the internal tiers so `today`, `thisWeek`, and explicit ranges still find matching CRUD events.

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

Roaring bitmaps back every membership lookup. Keys use typed prefixes — validated in `indexes/bitmaps/lib/keys.js`:

| Prefix | Role |
|--------|------|
| `context/<treeId>/<layerUlid>` | Context-tree layer membership |
| `vfs/<treeId>/...` | Directory-tree folder membership |
| `tag/`, `data/`, `device/`, `custom/`, … | Feature/schema filters (also usable in query `filters`) |
| `internal/...` | Engine-managed indexes — hidden from default listings |

Notable `internal/*` keys:

- `internal/ts/<timeline>/<scale>/start|end` — timeline Dual-BSI tiers
- `internal/lance/fts`, `internal/lance/vectors` — Lance search index coverage
- `internal/gc/deleted` — soft-deleted document set

### Introspection (`db.bitmapIndex`)

```js
// User-facing bitmaps only (default — omits internal/*)
const keys = await db.bitmapIndex.listBitmaps();

// All keys, including engine-managed internal/*
const allKeys = await db.bitmapIndex.listBitmaps('', { includeInternal: true });

// Prefix scan — always returns keys under that prefix (internal/* included when prefix matches)
const timelineKeys = await db.bitmapIndex.listBitmaps('internal/ts');
const treeLayers = await db.bitmapIndex.listBitmaps(`context/${treeId}`);
```

`listBitmaps(prefix, { includeInternal })` behavior:

- **No prefix:** all keys except `internal/*`, unless `includeInternal: true`.
- **With prefix:** range scan under that prefix; no extra `internal/*` filtering.

Load a bitmap with `getBitmap(key)` (returns a `Bitmap` instance with `size`, `has(id)`, `toArray()`, etc.). Find which bitmaps contain a document via `getBitmapsForDocument(id, prefix?)` on the main `db` object (also omits `internal/*` when `prefix` is empty).

REST equivalent: `GET /rest/v2/workspaces/:id/bitmaps?includeInternal=true` (workspace must be started). See project `docs/API.md` for `includeData`, prefix paths, raw `.roar` download, and delete protections.

## Trees

SynapsD supports multiple named trees per workspace database. Trees are views on top of your documents — they organise membership and structure, not data. A single document can live in many trees at once.

Two tree types:

- **`context`** — layers with path-intersection semantics. Nodes in a context tree are called **layers**. Querying a path ANDs the bitmaps of every layer along that path.
- **`directory`** — unique folder nodes with filesystem-like semantics. Nodes are **directories**. Each directory has its own bitmap; recursive queries OR them.

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
