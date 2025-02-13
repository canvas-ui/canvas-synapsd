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
- **storageOptions**:
  - **supportedBackends**: Array of backend names to use
  - **defaultBackend**: Default backend to use
  - **defaultBackendOptions**: Default backend options

### Index implementation

#### Hashmaps / Inverted indexes

- **algorithm/checksum | docID**  
  Example: sha1/4e1243.. => document ID)
- **timestamp | docID**  
  Example: 20250212082411.1234 => document ID  
We could use composite keys and LMDB range queries instead (timestamp/docID => document) but for now this way is more practical.

#### Bitmap indexes

The following bitmap index prefixes are enforced to organize and filter documents:

- `internal/` - Internal bitmaps
- `context/` - Context path bitmaps, used internally by Canvas (as context tree nodes, context/uuid)
- `data/abstraction/<schema>` - Schema type filters (incl subtrees like data/abstraction/file/ext/json)
- `data/mime/<type>`
- `data/content/encoding/<encoding>`
- `client/os/<os>`
- `client/application/<application>`
- `client/device/<device-id>`
- `client/network/<network-id>` -We support storing documents on multiple backends(StoreD), when a canvas application connects from a certain network, not all backends may be reachable(your home NAS from work for example)
- `user/`
- `tag/` - Generic tag bitmaps
- `custom/` - Throw what you need here

## TODO

- For 2.0 we should move entirely to Collections (prefix based, not dataset based)
- API should be 
  - db.createCollection('collectionName', options); options at least rangeMin/rangeMax; returns a Collection obj
  - db.listCollections()
  - db.getCollection('collectionName')
  - collection.listBitmaps()
  - collection.getBitmap() // createBitmap, removeBitmap, hasBitmap and the whole spiel
  - tick(key, ids)
  - tickMany(keyArray, ids)
  - tickAll(ids)
  - untick(key, ids)
  - untickMany(keyArray, ids)
  - unticAll(ids)
- We should move all internal bitmaps out of view, list methods should not return them nor should it be possible to edit them directly(maybe a dedicated dataset for internal bitmaps?)
- We need to **implement a ignoreMissingBitmaps** option for list methods; this module is consumed by tool calls from ai agents and minions, compiling a list of bitmaps may not be very accurate
- Add proper stats() support
- Cleanup existing methods; implement the same consistent api to Bitmap, BitmapCollection and the main DB class
- Implement nested bitmaps (simplest would be to just detect if a bitmap key ends with a ID or something like _nested:id or _ref:id)
- All of the above is a breeze with todays tools, goes to show that the only limiting factor in most scenarios will prominently become time!

## References

- [LMDB Documentation](http://www.lmdb.tech/doc/)
- [Node.js Crypto Documentation](https://nodejs.org/docs/latest-v20.x/api/crypto.html)
- [Roaring Bitmaps](https://roaringbitmap.org/)
- [LlamaIndex](https://www.llamaindex.ai/)
- [FlexSearch](https://github.com/nextapps-de/flexsearch)
- [LanceDB](https://lancedb.com/)
- [Why-not-indices](https://stackoverflow.com/questions/1378781/proper-terminology-should-i-say-indexes-or-indices)
