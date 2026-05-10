# SynapsD

## High level architecture

### Layer 1: JSON Store

- LMDB KV backend levaraging LMDB datasets for documents, all indexes(inverted, roaring), high level abstractions(layers/tree nodes and internal structures)
- Values are always schema-validated JSON documents or BLOBs(roaring bitmaps) with content(data) and/or location URLs pointint to non-local data

### Layer 2: Indexes

- Bitmap (roaring bitmaps)
- Inverted
  - Checksums
  - Synapses (nested bitmaps, to be replaced eventually)
- Bit-sliced indexes (current timeline implementation)
  - Reference: https://www.pilosa.com/docs/architecture/#bsi-range-encoding
- Vector (LanceDB)

### Layer 3: Semantic projection

## Views

### Trees

- `contextTree`
- `directoryTree`

### Buckets

### Timelines

## TODO

### Generic

- [] Ensure all batch methods are using the accompanied backend(LMDB/Lance) batch methods too whereever it makes sense
- [] Add backup/restore or dump/import functionality internally
- [] Add DB snapshot/restore option(on top of versioning? fetaures) to enable undo/redo ops || db op logs + traversal
- [] Add proper support for Layer of type "label", this type of layer is not bound to a bitmap, hence not processed when supplied via contextSpec/contextArray
- [] Ensure locked layers can not be moved/removed/deleted/renamed
- [] Add a new "root" (universe) layer type, prevent all ops on the root layer, root "/" layer should always be locked
- [] Support the following format option
  - Ids
  - metadata portion only 
  - full document

### "!tag" shorthand (optional sugar)

* If a string in `allOf/anyOf` starts with `!`, move it to `none` internally.
* Keeps compatibility with quick one-liners.

## Canonical V2 API leftovers

- [] Finalize canonical query object shape:
  - [ ] `filters.glob`
  - [ ] `filters.regexp`

## Membership Engine Extraction

- [ ] Extract shared document-target linking into one internal module/service.
- [ ] Support linking targets for:
  - [ ] context paths
  - [ ] directory paths
  - [ ] attributes
  - [ ] future document relations if needed
- [ ] Make trees translate path semantics into generic membership operations.
- [ ] Keep document-to-document relations out of tree APIs.

## Schema and Adapter Cleanup

- [ ] Reduce app-specific abstractions inside `synapsd`.
- [ ] Move source-specific normalization/mapping to app/workspace layer.
- [ ] Keep `synapsd` input shape generic and canonical.

## Tests

- [ ] Add a proper test suite for the current API
- [ ] Add tests for `list(spec)`:
  - [ ] attributes `allOf`
  - [ ] attributes `anyOf`
  - [ ] attributes `noneOf`
  - [ ] context-only
  - [ ] directory-only
  - [ ] timeline filters
  - [ ] glob/regexp filters
  - [ ] pagination
- [ ] Add tests for `search(spec)`:
  - [ ] global search
  - [ ] context-filtered search
  - [ ] attribute-filtered search
  - [ ] timeline-filtered search
- [ ] Add workspace integration tests against new API translation layer.

