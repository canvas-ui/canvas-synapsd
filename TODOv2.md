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

## Phase 1: Canonical V2 API
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
  - [ ] keep `Context` vs `ContextTree` naming explicit everywhere
- [ ] Finalize canonical query object shape:
  - [ ] `context`
  - [ ] `directory`
  - [ ] `attributes.allOf`
  - [ ] `attributes.anyOf`
  - [ ] `attributes.noneOf`
  - [ ] `filters.timeline`
  - [ ] `filters.glob`
  - [ ] `filters.regexp`
  - [ ] pagination/options
- [ ] Make `find(spec)` the only structural query entrypoint worth keeping.
- [ ] Make `search(spec)` the only ranked/text query entrypoint worth keeping.

## Phase 2: Migrate Runtime Callers Directly
- [ ] Replace workspace-facing code with canonical `find(spec)` / `search(spec)` usage.
- [ ] Replace context-facing code with canonical `find(spec)` / `search(spec)` usage.
- [ ] Replace transport branching between structural/text query wrappers with canonical query builders.
- [ ] Remove `contextSpec`, `featureBitmapArray`, `filterArray` plumbing from workspace-facing code.
- [ ] Add narrow query-builder helpers only where they remove code instead of hiding complexity:
  - [ ] merge active context focus
  - [ ] merge client/server context
  - [ ] merge user-provided attributes
  - [ ] merge filters/pagination

## Phase 3: Delete Legacy API Surface
- [ ] Remove `findDocuments(...)`.
- [ ] Remove `ftsQuery(...)`.
- [ ] Remove `query(...)`.
- [ ] Remove old positional argument normalization.
- [ ] Remove route/query helpers that exist only to translate legacy shapes.
- [ ] Remove dead wrappers in `Workspace`, `Context`, `ContextTree`, and transports.

## Phase 4: Context/Directory Tree Cleanup
- [x] Export trees cleanly from db:
  - [x] `db.contextTree`
  - [x] `db.directoryTree`
- [x] Keep tree APIs on the tree objects, not flattened onto db.
- [ ] Unify shared tree internals:
  - [x] path normalization
  - [x] document membership linking
  - [ ] unlinking
  - [x] event shapes
  - [ ] shared list/find helpers where possible
- [x] Keep different public semantics:
  - [x] `ContextTree` = layered/intersection semantics
  - [x] `DirectoryTree` = exact location semantics

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
