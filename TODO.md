# TODO

## Principles

- Keep `synapsd` focused on store/index/query only.
- Keep `contextTree` and `directoryTree` as separate view semantics over shared internals.

## High priority

- Ensure all batch methods are using the accompanied backend(LMDB/Lance) batch methods too!
- One canonical key normalizer for every index. No more casing roulette.
- One write path for document membership. documents, bitmaps, synapses, lance should not all cosplay as source of truth.
- Proper transaction boundary semantics. Either LMDB owns durability or we stop pretending.
- Lance as a rebuildable projection only. Never part of correctness.
- Invariant tests for: insert, link, unlink, import existing doc, restart, search.


## Generic

- [] Add backup/restore or dump/import functionality internally
- [] Add DB snapshot/restore option(on top of versioning?) to enable undo/redo ops || db op logs + traversal
- [] Add proper support for Layer of type "label", this type of layer is not bound to a bitmap, hence not processed when supplied via contextSpec/contextArray
- [] Ensure locked layers can not be moved/removed/deleted/renamed
- [] Add a new "root" (universe) layer type, prevent all ops on the root layer, root "/" layer should always be locked
- [] Support the following format option
  - Ids
  - meta data portion only- 
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
- [ ] Reassess which current schema classes belong in core vs app layer.

## Tests

- [ ] Add a proper test suite for the current API
- [ ] Add tests for `find(spec)`:
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

