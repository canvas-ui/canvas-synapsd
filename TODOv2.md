# SynapsD V2 Refactor TODO

## Principles
- Keep `synapsd` focused on store/index/query only.
- Keep source/channel adapters at the `Workspace` or app layer.
- Keep `remove` and `delete` as separate public operations.
- Keep `contextTree` and `directoryTree` as separate view semantics over shared internals.
- Replace positional array-heavy query APIs with explicit object-shaped APIs.

## Phase 0: Freeze Current Direction
- [x] Remove dead backend abstraction and keep LMDB-only backend.
- [x] Fix feature filter semantics and negation support.
- [x] Fix root-context and nonexistent-path query bugs.
- [x] Fix global search without bitmap prefilters.
- [x] Confirm adapter/source integrations stay outside `synapsd`.

## Phase 1: Define V2 Core API
- [ ] Finalize public db API:
  - [ ] `get(id, options?)`
  - [ ] `put(record, memberships?)`
  - [ ] `has(id, options?)`
  - [ ] `remove(id, membershipsOrSpec)`
  - [ ] `delete(id)`
  - [ ] `find(spec)`
  - [ ] `search(spec)`
- [ ] Finalize naming:
  - [ ] use `attributes` instead of `features`/`facets`
  - [ ] use `filters` for operator-like constraints
- [ ] Finalize query object shape:
  - [ ] `context`
  - [ ] `directory`
  - [ ] `attributes.allOf`
  - [ ] `attributes.anyOf`
  - [ ] `attributes.noneOf`
  - [ ] `filters.timeline`
  - [ ] `filters.glob`
  - [ ] `filters.regexp`
  - [ ] pagination/options
- [ ] Decide whether `search(spec)` supports all `find(spec)` constraints plus `query`.

## Phase 2: Introduce V2 API Without Breaking Everything
- [ ] Implement `db.find(spec)` as the new canonical structural query method.
- [ ] Implement `db.search(spec)` as the new canonical ranked/text query method.
- [ ] Make old methods delegate internally:
  - [ ] `findDocuments(...) -> find(spec)`
  - [ ] `ftsQuery(...) -> search(spec)`
  - [ ] `query(...) -> search(spec)` or remove after migration
- [ ] Add normalization helpers:
  - [ ] legacy args -> v2 spec
  - [ ] route query params -> v2 spec
  - [ ] workspace list/search options -> v2 spec

## Phase 3: Workspace Migration
- [ ] Replace `Workspace.list(options)` old signature with v2 `find(spec)` usage.
- [ ] Replace any workspace search wrapper to call `db.search(spec)`.
- [ ] Remove `contextSpec`, `featureBitmapArray`, `filterArray` plumbing from workspace-facing code.
- [ ] Add a workspace query builder/helper if needed:
  - [ ] merge active context
  - [ ] merge client/server context
  - [ ] merge user-provided attributes
  - [ ] merge filters/pagination
- [ ] Update route handlers that currently branch between `findDocuments` and `ftsQuery`.

## Phase 4: Context/Directory Tree Cleanup
- [ ] Export trees cleanly from db:
  - [ ] `db.contextTree`
  - [ ] `db.directoryTree`
- [ ] Keep tree APIs on the tree objects, not flattened onto db.
- [ ] Unify shared tree internals:
  - [ ] path normalization
  - [ ] document membership linking
  - [ ] unlinking
  - [ ] event shapes
  - [ ] shared list/find helpers where possible
- [ ] Keep different public semantics:
  - [ ] `ContextTree` = layered/intersection semantics
  - [ ] `DirectoryTree` = exact location semantics

## Phase 5: Membership Engine Extraction
- [ ] Extract shared document-target linking into one internal module/service.
- [ ] Support linking targets for:
  - [ ] context paths
  - [ ] directory paths
  - [ ] attributes
  - [ ] future document relations if needed
- [ ] Make trees translate path semantics into generic membership operations.
- [ ] Keep document-to-document relations out of tree APIs.

## Phase 6: Schema and Adapter Cleanup
- [ ] Reduce app-specific abstractions inside `synapsd`.
- [ ] Move source-specific normalization/mapping to app/workspace layer.
- [ ] Keep `synapsd` input shape generic and canonical.
- [ ] Reassess which current schema classes belong in core vs app layer.

## Phase 7: Old API Removal
- [ ] Mark old methods deprecated in code comments/tests.
- [ ] Remove legacy wrappers after workspace/routes/UI migration is complete.
- [ ] Delete unused helpers tied to `featureBitmapArray` / `filterArray` / `contextSpec` positional signatures.
- [ ] Simplify tests around only the v2 API shape.

## Tests
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
git sta
## Immediate Next Step
- [ ] Refactor `findDocuments(...)` into `find(spec)` and migrate `Workspace.list(...)` first.git
