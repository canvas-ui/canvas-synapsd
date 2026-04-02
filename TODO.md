# TODO

## Cleanup data abstractions


## Implementation of synapses

- We'll need to revisit this corner of the code

## Generic

- Add backup policy, backup DB every day at 2AM server time, keep 7 days of backups(default, configurable for each workspace, config in workspace.json at each workspace path, should work on an active workspace only)
- Add backup/restore functionality internally
- Add DB snapshot/restore option(on top of versioning?) to enable undo/redo ops || db op logs + traversal
- Add proper support for Layer of type "label", this type of layer is not bound to a bitmap, hence not processed when supplied via contextSpec/contextArray
- Ensure locked layers can not be moved/removed/deleted/renamed
- Add a new "root" (universe) layer type, prevent all ops on the root layer, root "/" layer should always be locked
- Support the following format option
  - full document
  - data portion only
  - meta data portion only
- Besides standard document abstractions, we need to support Canvases and Workspaces(so that a user could link a foreign workspace subtree within his tree, might be a can of worms)

### "!tag" shorthand (optional sugar)
* If a string in `allOf/anyOf` starts with `!`, move it to `none` internally.
* Keeps compatibility with quick one-liners.

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
- [x] Finalize public db API:
  - [x] `get(id, options?)`
  - [x] `put(document, memberships?)`
  - [x] `has(id, options?)`
  - [x] `unlink(id, membershipsOrSpec)`
  - [x] `delete(id)`
  - [x] `find(spec)`
  - [x] `search(spec)`
- [x] Finalize naming:
  - [x] use `attributes` instead of `features`/`facets`
  - [x] use `filters` for operator-like constraints
  - [x] keep `Context` vs `ContextTree` naming explicit everywhere
- [x] Finalize canonical query object shape:
  - [x] `context`
  - [x] `directory`
  - [x] `attributes.allOf`
  - [ ] `attributes.anyOf`
  - [x] `attributes.noneOf`
  - [x] `filters.timeline`
  - [ ] `filters.glob`
  - [ ] `filters.regexp`
  - [x] pagination/options
- [x] Make `find(spec)` the only structural query entrypoint worth keeping.
- [x] Make `search(spec)` the only ranked/text query entrypoint worth keeping.

## Phase 2: Migrate Runtime Callers Directly
- [x] Replace workspace-facing code with canonical `find(spec)` / `search(spec)` usage.
- [x] Replace context-facing code with canonical `find(spec)` / `search(spec)` usage.
- [x] Replace transport branching between structural/text query wrappers with canonical query builders.
- [x] Remove `contextSpec`, `featureBitmapArray`, `filterArray` plumbing from workspace-facing code.
- [ ] Add narrow query-builder helpers only where they remove code instead of hiding complexity:
  - [x] merge active context focus
  - [x] merge client/server context
  - [x] merge user-provided attributes
  - [x] merge filters/pagination

## Phase 3: Delete Legacy API Surface
- [x] Remove `findDocuments(...)`.
- [x] Remove `ftsQuery(...)`.
- [x] Remove `query(...)`.
- [x] Remove old positional argument normalization.
- [x] Remove route/query helpers that exist only to translate legacy shapes.
- [x] Remove dead wrappers in `Workspace`, `Context`, `ContextTree`, and transports.

## Phase 4: Context/Directory Tree Cleanup
- [x] Export trees cleanly from db:
  - [x] `db.contextTree`
  - [x] `db.directoryTree`
- [x] Keep tree APIs on the tree objects, not flattened onto db.
- [ ] Unify shared tree internals:
  - [x] path normalization
  - [x] document membership linking
  - [x] unlinking
  - [x] event shapes
  - [x] shared list/find helpers where possible
- [x] Keep different public semantics:
  - [x] `ContextTree` = layered/intersection semantics
  - [x] `DirectoryTree` = exact location semantics
- [x] Review and normalize all emitted event shapes across `synapsd`:
  - [x] tree events
  - [x] document lifecycle events
  - [x] payload naming consistency (`treeId`, `treeName`, `treeType`, etc.)
  - [x] transport forwarding expectations

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
- [x] Mark old methods deprecated in code comments/tests.
- [x] Remove legacy wrappers after workspace/routes/UI migration is complete.
- [x] Delete unused helpers tied to `featureBitmapArray` / `filterArray` / `contextSpec` positional signatures.
- [ ] Simplify tests around only the v2 API shape.

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

