# SynapsD

SynapsD is the indexed store behind Canvas. It keeps document records, roaring bitmap memberships, timestamp/checksum indexes, and named tree views on top of LMDB.

It is not the app layer. Source adapters, device logic, workspace hooks, and other domain-specific mapping stay outside `synapsd`.

## Core pieces

- `LMDB` is the storage backend.
- `Roaring bitmaps` power attribute and membership lookups.
- `LanceDB` handles ranked/full-text search.
- `ContextTree` provides layered/intersection semantics.
- `DirectoryTree` provides exact folder semantics with unique node IDs.

## Canonical API

The current public API shape is:

- `get(id, options?)`
- `put(record, memberships?)`
- `putMany(records, memberships?)`
- `has(id, spec?)`
- `getByChecksumString(checksum, options?)`
- `hasByChecksumString(checksum, spec?)`
- `unlink(id, membershipsOrSpec, options?)`
- `unlinkMany(ids, membershipsOrSpec, options?)`
- `delete(id, options?)`
- `deleteMany(ids, options?)`
- `find(spec)`
- `search(spec)`

Legacy method names like `findDocuments`, `ftsQuery`, `insertDocument`, and friends are no longer the intended API and should be treated as dead.

## Query shape

`find(spec)` and `search(spec)` use explicit object-shaped inputs.

Common fields:

- `context`
- `directory`
- `attributes.allOf`
- `attributes.anyOf`
- `attributes.noneOf`
- `filters`
- `limit`
- `offset`
- `page`
- `parse`

Example:

```js
const docs = await db.find({
    context: { tree: 'projects', path: '/foo/bar' },
    attributes: {
        allOf: ['data/abstraction/file'],
        noneOf: ['tag/deleted'],
    },
    filters: ['datetime:updated:today'],
    limit: 100,
});

const ranked = await db.search({
    query: 'invoice',
    context: { tree: 'projects', path: '/finance/2026' },
    attributes: { allOf: ['data/abstraction/file'] },
    limit: 20,
});
```

## Trees

SynapsD supports multiple named trees per workspace database.

- `context` trees use shared logical layers and path-intersection semantics
- `directory` trees use unique folder nodes and filesystem-like semantics

Tree metadata lives in the internal store, while tree memberships are mapped to typed bitmap namespaces.

## Notes

- Checksums are first-class lookup keys.
- Batch methods return structured success/failure results.
- Query results are arrays with attached `count`, `totalCount`, and `error` metadata.
- Event payloads should include `treeId`, `treeName`, and `treeType` consistently.

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
