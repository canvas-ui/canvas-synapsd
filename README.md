# SynapsD

SynapsD is the indexed store behind Canvas. It keeps document records, roaring bitmap memberships, timestamp/checksum indexes, and named tree views on top of LMDB.

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
- `put(record, treeSelector?, features?, options?)`
- `putMany(records, treeSelector?, features?, options?)`
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

`put()` creates a new row when the record has no existing `id`. It returns the numeric document id.

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

`put()` updates when `record.id` already exists.

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

## Query shape

`find(spec)` and `search(spec)` use explicit object-shaped inputs.

Common fields:

- `tree`
- `path`
- `features`
- `features.allOf`
- `features.anyOf`
- `features.noneOf`
- `filters`
- `excludeTree`
- `excludeTrees`
- `limit`
- `offset`
- `page`
- `parse`

Example:

```js
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

const ranked = await db.search({
    query: 'invoice',
    tree: 'projects',
    path: '/finance/2026',
    features: ['data/abstraction/file', 'tag/finance'],
    limit: 20,
});

const exactDirectoryMatches = await db.find({
    tree: 'filesystem',
    path: ['/docs/contracts', '/docs/invoices'],
    features: ['data/abstraction/file'],
});

const rootListingWithoutStaging = await db.find({
    excludeTree: 'incoming',
    features: ['data/abstraction/file'],
});
```

## Trees

SynapsD supports multiple named trees per workspace database.

- `context` trees use shared logical layers and path-intersection semantics
- `directory` trees use unique folder nodes and filesystem-like semantics

`incoming` should be a normal named `directory` tree used for staged records. Promotion is just link/unlink:

```js
const stagedId = await db.put(
    {
        schema: 'data/abstraction/email',
        data: { subject: 'Invoice', from: 'billing@example.com' },
    },
    { tree: 'incoming', path: '/email/imap/account-a/inbox' },
);

await db.link(stagedId, { tree: 'projects', path: '/finance/invoices' }, ['tag/triaged']);
await db.unlink(stagedId, { tree: 'incoming', path: '/email/imap/account-a/inbox' });
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
