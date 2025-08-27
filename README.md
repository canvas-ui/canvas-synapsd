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
  - **embeddingFields**: Concatenated fields to calculate embedding vectors
  - **embeddingModel**: Model to use for embedding
  - **embeddingDimensions**: Dimensions of the embedding vectors
  - **embeddingProvider**: Provider to use for embedding
  - **embeddingProviderOptions**: Options for the embedding provider
  - **chunking**: Chunking options
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

## API Documentation

### API Patterns

SynapsD follows a hybrid API pattern - for better or worse - 

#### Single Document Operations

Single document operations:

```javascript
try {
    const docId = await db.insertDocument(doc);
    // Success case
} catch (error) {
    // Error handling
}
```

Available single document operations:

- `insertDocument(doc, contextSpec, featureBitmapArray)`
- `updateDocument(docId, updateData, contextSpec, featureBitmapArray)`
- `deleteDocument(docId)`
- `getDocument(docId)`
- `getDocumentById(id)`
- `getDocumentByChecksumString(checksumString)`

#### Batch Operations

Batch operations return a result object:

```javascript
const result = await db.insertDocumentArray(docs);
if (result.failed.length > 0) {
    // Handle partial failures
}
// Access successful operations
const successfulIds = result.successful.map(s => s.id);

// Using findDocuments
const result = await db.findDocuments('/some/path', ['feature1'], ['filter1']);
if (result.error) {
    console.error('Query failed:', result.error);
} else {
    console.log(`Found ${result.count} documents:`, result.data);
}

// Using query
const queryResult = await db.query('some query', ['context1'], ['feature1']);
if (queryResult.error) {
    console.error('Query failed:', queryResult.error);
} else {
    console.log(`Found ${queryResult.count} documents:`, queryResult.data);
}
```

Result object structure:

```typescript
interface BatchResult {
    successful: Array<{
        index: number;    // Original array index
        id: number;       // Document ID
    }>;
    failed: Array<{
        index: number;    // Original array index
        error: string;    // Error message
        doc: any;        // Original document
    }>;
    total: number;       // Total number of operations
}
```

Available batch operations:

- `insertDocumentArray(docs, contextSpec, featureBitmapArray)`
- `updateDocumentArray(docs, contextSpec, featureBitmapArray)`
- `deleteDocumentArray(docIds)`
- `getDocumentsByIdArray(ids)`
- `getDocumentsByChecksumStringArray(checksums)`

#### Query Operations

Pagination is supported for all queries. Default page size is 100 documents.

Options:
- `limit` (number): page size (default 100)
- `offset` (number): starting index (default 0)
- `page` (number): 1-based page number (ignored if `offset` provided)
- `parse` (boolean): parse into schema instances (default true)

Usage:

```javascript
// First page (implicit): limit=100, offset=0
const docs = await db.findDocuments(contextSpec, featureBitmapArray, [], { limit: 100 });
console.log(docs.length, docs.count); // docs has .count metadata

// Second page via page
const page2 = await db.findDocuments(contextSpec, featureBitmapArray, [], { page: 2, limit: 100 });

// Or using offset directly
const next100 = await db.findDocuments(contextSpec, featureBitmapArray, [], { offset: 100, limit: 100 });
```

Return shape:
```typescript
type QueryResultArray = Array<any> & { count: number; error: string | null };
```

Available query operations:

- `findDocuments(contextSpec, featureBitmapArray, filterArray, options)`
- `query(query, contextBitmapArray, featureBitmapArray, filterArray)`
- `ftsQuery(query, contextBitmapArray, featureBitmapArray, filterArray)`

### Error Handling

SynapsD uses standard JavaScript Error objects with specific error types:

- `ValidationError`: Document validation failed
- `NotFoundError`: Document not found
- `DuplicateError`: Document already exists
- `DatabaseError`: General database errors

Example:
```javascript
try {
    await db.insertDocument(doc);
} catch (error) {
    if (error instanceof ValidationError) {
        // Handle validation error
    } else if (error instanceof DatabaseError) {
        // Handle database error
    }
}
```

## TODO

- add support for chunking
- add support for versioning
- add support for embeddings (we should calculate embeddings on the db side if none are provided)
- add support for vector search
- move the contextTree functionality from Canvas to this module (db will present a tree view on top of the dataset)
- switch to (andBitmapArray, orBitmapArray, filterArray) instead of contextBitmapArray and featureBitmapArray
- For 2.0 we should move entirely to Collections (prefix based, not dataset based)
- We should move all internal bitmaps out of view, list methods should not return them nor should it be possible to edit them directly(maybe a dedicated dataset for internal bitmaps?)
- We need to **implement a ignoreMissingBitmaps** option for list methods; this module is consumed by tool calls from ai agents and minions, compiling a list of bitmaps may not be very accurate
- Add proper stats() support
  - We should keep track of bitmap usage
  - The above implies having "static" and "dynamic" bitmaps, static would be kept regardless of their usage but dynamic would be removed when not in use
- Implement nested bitmaps (simplest would be to just detect if a bitmap key ends with a ID or something like _nested:id or_ref:id)
- All of the above is a breeze with todays tools, goes to show that the only limiting factor in most scenarios will prominently become time!

## References

- [LMDB Documentation](http://www.lmdb.tech/doc/)
- [Node.js Crypto Documentation](https://nodejs.org/docs/latest-v20.x/api/crypto.html)
- [Roaring Bitmaps](https://roaringbitmap.org/)
- [LlamaIndex](https://www.llamaindex.ai/)
- [FlexSearch](https://github.com/nextapps-de/flexsearch)
- [LanceDB](https://lancedb.com/)
- [Why-not-indices](https://stackoverflow.com/questions/1378781/proper-terminology-should-i-say-indexes-or-indices)
