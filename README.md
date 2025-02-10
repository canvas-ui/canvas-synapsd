# SynapsD

A very simple, naive implementation of a JSON document store with some bitmap indexes in the mix. Module primarily but not exclusively for use with Canvas (https://github.com/canvas-ai/canvas-server)

## Architecture

### Components

- **LMDB**, to-be-replaced by pouchdb or rxdb as the main KV backend (https://www.npmjs.com/package/lmdb)
- **Compressed (roaring) bitmaps** (https://www.npmjs.com/package/roaring)
- **FlexSearch** for full-text search (https://www.npmjs.com/package/flexsearch)
- **LanceDB** (https://www.npmjs.com/package/@lancedb/lancedb)

### JSON Document Store

- Simple LMDB KV store with enforced document schemas (See `./src/schemas` for more details)
- Every data abstraction schema (File, Note, Browser tab, Email etc) defines its own indexing options; currently supported **indexOptions**:
  - **checksumAlgorithms**: Checksums to calculate
  - **checksumFields**: JSON document fields to calculate checksums
  - **searchFields**: Full text search fields
  - **embeddingFields**: Concatenated fields to calculate embedding vectors (no chunk support for now)

### Index implementation

#### Hashmaps / Inverted indexes

- **algorithm/checksum | docID**  
  Example: sha1/4e1243.. => document ID)
- **timestamp | docID**  
  Example: 20250212082411.1234 => document ID  
We could use composite keys and LMDB range queries instead (timestamp/docID => document) but for now this way is more practical.

#### Bitmap indexes

The following bitmap index prefixes are enforced to organize and filter documents:

- `context/` - Context path bitmaps, used internally by Canvas (as context tree nodes, context/uuid)
- `data/abstraction/<schema>` - Schema type filters (incl subtrees like data/abstraction/file/ext/json)
- `data/mime/<type>`
- `data/content/encoding/<encoding>`
- `index/`
- `system/`
- `client/os/`
- `client/application/`
- `client/device/<device-id>`
- `user/`
- `tag/` - Generic tag bitmaps
- `nested/` - Nested bitmaps (contacts are a good example)
- `custom/` - Throw what you need here

## References

- [LMDB Documentation](http://www.lmdb.tech/doc/)
- [Node.js Crypto Documentation](https://nodejs.org/docs/latest-v20.x/api/crypto.html)
- [Roaring Bitmaps](https://roaringbitmap.org/)
- [LlamaIndex](https://www.llamaindex.ai/)
- [FlexSearch](https://github.com/nextapps-de/flexsearch)
- [LanceDB](https://lancedb.com/)
- [Why-not-indices](https://stackoverflow.com/questions/1378781/proper-terminology-should-i-say-indexes-or-indices)
