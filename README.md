# SynapsD

SynapsD is the indexed store behind Canvas. It keeps documents, roaring bitmap memberships, timestamp/checksum indexes, and named tree views on top of LMDB.

It is not the app layer. Source adapters, device logic, workspace hooks, and other domain-specific mapping stay outside `synapsd`.

## Core pieces

- `LMDB` is the storage backend.
- `Roaring bitmaps` power feature and membership lookups.
- `LanceDB` handles ranked/full-text search.
- `ContextTree` provides layered/intersection semantics.
- `DirectoryTree` provides exact folder semantics with unique node IDs.

## Canonical API

The current public API shape is:

- `get(id, options?)`
- `put(document, treeSelector?, features?, options?)`
- `putMany(documents, treeSelector?, features?, options?)`
- `link(id, treeSelector?, features?, options?)`
- `linkMany(ids, treeSelector?, features?, options?)`
- `has(id, treeSelector?, features?)`
- `getByChecksumString(checksum, options?)`
- `hasByChecksumString(checksum, treeSelector?, features?)`
- `unlink(id, treeSelector?, features?, options?)`
- `unlinkMany(ids, treeSelector?, features?, options?)`
- `delete(id, options?)`
- `deleteMany(ids, options?)`
- `find(spec)`
- `search(spec)`
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

Reusable tree selector and feature list:

```js
const projectTree = { tree: 'projects', path: '/work/project-a' };
const projectNoteFeatures = ['data/abstraction/note', 'tag/inbox'];
```

Write methods tick every feature you pass. Query methods treat `features: ['a', 'b']` as `anyOf`.

### Create

`put()` creates a new row when the document has no existing `id`. It returns the numeric document id.

```js
const id = await db.put(
    {
        schema: 'data/abstraction/note',
        data: {
            title: 'Hello',
            content: 'First draft',
        },
    },
    projectTree,
    projectNoteFeatures,
);

const ids = await db.putMany(
    [
        {
            schema: 'data/abstraction/note',
            data: { title: 'A', content: 'Alpha' },
        },
        {
            schema: 'data/abstraction/note',
            data: { title: 'B', content: 'Beta' },
        },
    ],
    { tree: 'projects', path: ['/work/project-a', '/work/shared'] },
    projectNoteFeatures,
);
```

### Read

`get()` and `getByChecksumString()` return a parsed document instance by default. Pass `{ parse: false }` to get raw stored data. Tree-aware membership checks use `has()` / `hasByChecksumString()`.

```js
const doc = await db.get(id);
const rawDoc = await db.get(id, { parse: false });

const docByChecksum = await db.getByChecksumString('sha256:...');

const existsAnywhere = await db.has(id);
const existsInProjectsTree = await db.has(id, { tree: 'projects', path: '/work/project-a' });
const existsWithInboxFeature = await db.has(id, projectTree, ['tag/inbox']);

const checksumExistsInProject = await db.hasByChecksumString(
    'sha256:...',
    { tree: 'projects', path: '/work/project-a' },
    ['data/abstraction/note'],
);
```

Structural and ranked listing use `find(spec)` and `search(spec)`; see **Query shape** below.

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
    projectTree,
    projectNoteFeatures,
);

await db.link(id, { tree: 'projects', path: '/work/project-a' }, ['tag/reviewed']);
await db.link(id, { tree: 'filesystem', path: ['/notes', '/archive/notes'] }, ['tag/filed']);
```

### Delete

`unlink()` removes memberships only. The document stays in LMDB.

`delete()` removes the document row, checksum index entries, timestamp index entries, and synapse memberships. It returns `true` when a document was deleted and `false` when the id was not found.

Context-tree root `/` is a selector for "anything in this tree", not a real removable membership. Directory-tree root `/` is just the literal root folder.

```js
await db.unlink(id, { tree: 'projects', path: '/work/project-a/deep' }, ['tag/inbox']);

await db.unlink(id, { tree: 'projects', path: '/work/project-a/deep' }, [], { recursive: true });

await db.unlink(id, { tree: 'incoming', path: '/' });

const deleted = await db.delete(id);
await db.delete(id, { emitEvent: false });

const linkResult = await db.linkMany([id1, id2], { tree: 'projects', path: '/work/project-a' }, ['tag/reviewed']);
const unlinkResult = await db.unlinkMany([id1, id2], { tree: 'projects', path: '/work/project-a' }, ['tag/inbox']);

const deleteResult = await db.deleteMany([id1, id2]);
```

`unlinkMany()` and `deleteMany()` return `{ successful, failed, count }`. Batch delete/unlink ids must be numbers; numeric strings are accepted by `get()` / `put()` but rejected by the batch helpers.

## Querying: `find` vs `search`

SynapsD has two query methods. They accept the same filtering/scoping fields but serve different purposes.

### `find(spec)` — bitmap-filtered listing

Returns documents that match structural criteria: tree membership, features, and datetime/bitmap filters. Results are returned in insertion order (by numeric ID). No ranking is performed.

Use `find` when you know *where* or *what kind* of documents you want — "all notes in this project", "files updated today", "everything except staging".

With no filters, `find` returns all documents in the store.

### `search(spec)` — full-text ranked search

Requires a `query` string. First applies the same bitmap filters as `find` to narrow the candidate set, then runs a full-text search (via LanceDB) over those candidates. Results are ranked by relevance.

Use `search` when you have a text query and want the best matches — "find invoices mentioning 'overdue' in the finance tree".

Default limit is 50 (vs unlimited for `find`).

### Shared spec fields

Both methods accept:

| Field | Description |
|-------|-------------|
| `tree` | Tree name or ID to scope the query |
| `path` | Path(s) within the tree — string or array of strings |
| `features` | Feature keys as array (treated as `anyOf`) or `{ allOf, anyOf, noneOf }` |
| `filters` | Array of filter strings — bitmap keys and `datetime:` expressions |
| `excludeTree` | Tree name/ID to exclude from results |
| `excludeTrees` | Array of tree names/IDs to exclude |
| `limit` | Max documents to return (`find`: unlimited, `search`: 50) |
| `offset` | Skip N documents before returning results |
| `page` | Page number (alternative to offset, uses limit as page size) |
| `parse` | Set `false` to return raw stored data instead of parsed document instances |

`search` additionally requires:

| Field | Description |
|-------|-------------|
| `query` | The full-text search string (also accepts `search` or `q` as aliases) |

### Return value

Both return an array with attached metadata:

- `result.count` — number of documents in this page
- `result.totalCount` — total matching documents (before pagination)
- `result.error` — error message string, or `null`

### Examples

```js
// find: all notes in a project, excluding deleted
const docs = await db.find({
    tree: 'projects',
    path: '/foo/bar',
    features: {
        allOf: ['data/abstraction/file'],
        noneOf: ['tag/deleted'],
    },
    filters: ['datetime:updated:today'],
    limit: 100,
});

// find: directory tree, multiple paths
const exactDirectoryMatches = await db.find({
    tree: 'filesystem',
    path: ['/docs/contracts', '/docs/invoices'],
    features: ['data/abstraction/file'],
});

// find: everything except a specific tree
const withoutStaging = await db.find({
    excludeTree: 'incoming',
    features: ['data/abstraction/file'],
});

// search: ranked full-text within a scoped tree
const ranked = await db.search({
    query: 'invoice',
    tree: 'projects',
    path: '/finance/2026',
    features: ['data/abstraction/file', 'tag/finance'],
    limit: 20,
});
```

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
    { tree: 'incoming', path: '/email/imap/account-a/inbox' },
);

// promote into a user tree, then remove from staging
await db.link(id, { tree: 'projects', path: '/finance/invoices' }, ['tag/triaged']);
await db.unlink(id, { tree: 'incoming', path: '/email/imap/account-a/inbox' });

// exclude staging from broad queries
const docs = await db.find({ excludeTree: 'incoming' });
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
