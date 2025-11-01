# TODO

## Generic

- Add backup policy, backup DB every day at 2AM server time, keep 7 days of backups(default, configurable for each workspace, config in workspace.json at each workspace path, should work on an active workspace only)
- Add backup/restore functionality internally
- Add DB snapshot/restore option(on top of versioning?) to enable undo/redo ops || db op logs + traversal
- Add proper support for Layer of type "label", this type of layer is not bound to a bitmap, hence not processed when supplied via contextSpec/contextArray
  Feature can enable a more directory-tree like UX
- Ensure locked layers can not be moved/removed/deleted/renamed
- ? Add support for CRUD operations on top of single layers (currently can be done using existing methods)
- ? Implement a off-thread worker to post-process ingested documents (to calculate embeddings, tag bitmaps etc)
- ! Refactor those ***UGLY*** insert/updateDocument methods!!!
- Add a new "root" (universe) layer type, prevent all ops on the root layer, root "/" layer should always be locked
- Support the following format option
  - full document
  - data portion only
  - meta data portion only
- Besides standard document abstractions, we need to support Canvases and Workspaces(so that a user could link a foreign workspace subtree within his tree, might be a can of worms)

## Update mergeUp/Down + subtractUp/Down methods to use (layerName, contextPath)  instead of (contextPath) only

### current API

- mergeUp(contextPath): merge the bitmap of layer "foo" in context path "/work/foo/bar/baz" to bitmaps "bar" and "baz"
- mergeDown(contextPath): merge the bitmap of layer "foo" in context path "/work/foo/bar/baz" to bitmap "work"
- subtractUp(contextPath): subtract the bitmap of layer "foo" in context path "/work/foo/bar/baz" from bitmaps "bar" and "baz"
- subtractDown(contextPath): subtract the bitmap of layer "foo" in context path "/work/foo/bar/baz" from bitmap "work"

### New API

- mergeLayer(layerName, contextPath): merge the bitmap of layer "foo" in context path "/work/foo/bar/baz" to bitmaps "bar" and "baz"
- subtractLayer(layerName, contextPath): subtract the bitmap of layer "foo" in context path "/work/foo/bar/baz" from bitmaps "bar" and "baz"

## findDocuments API Refactor (Bitmap Filter DSL)

### Update (probably more human-understandable then the chatgpt conversation summary below)
- (andArray, orArray, filterArray, options)
- Support for !foo (NOT bitmap), this was always planned in as a handy feature
- Some bitmaps could be referenced indirectly using faiss or simillar, multi-head hierarchical approach to RAG will be moved fron canvas-agentd to synapsd when properly tested

### Motivation
Current signature:
```js
findDocuments(contextSpec = null, featureBitmapArray = [], filterArray = [], options = { parse: true })
```
* `contextSpec`  – AND-ed context bitmaps (hierarchical)
* `featureBitmapArray` – **OR** of feature bitmaps plus ad-hoc "!tag" NOT hack
* `filterArray`  – intended extra AND but only partially implemented

This asymmetry makes callers second-guess how to combine bitmaps (example: wanting an intersection you have to mix OR & AND arrays).

## Proposed unified interface
Expose *one* options object with explicit boolean intent.

```ts
interface FindOptions {
  context?: string | string[]; // a single context path, e.g. "/foo/bar" or ['foo', 'bar']

  all?:  string[];   // AND  – every bitmap must be present
  any?:  string[];   // OR   – at least one bitmap present
  none?: string[];   // NOT  – none of these bitmaps present

  // existing flags
  parse?: boolean;   // default true
  limit?: number;    // default undefined (= no limit)
}
```

### Bitmap logic
```
start = context ? AND(contextBitmaps) : allDocs
if (all.length)   start &= AND(all)
if (any.length)   start &= OR(any)
if (none.length)  start &= NOT(OR(none))
```

### "!tag" shorthand (optional sugar)
* If a string in `all/any` starts with `!`, move it to `none` internally.
* Keeps compatibility with quick one-liners.

## Migration path
1. Rename existing implementation to `findDocumentsLegacy`.
2. Implement `findDocumentsV2(opts)` as per above.
3. Provide shim:
   ```js
   findDocuments(context = null, featureOR = [], filterAND = [], opts = {}) {
     return this.findDocumentsV2({
       context,
       any: featureOR,
       all: filterAND,
       ...opts
     });
   }
   ```
4. Update CLI/service code incrementally.

## Tasks
- [ ] Implement `splitNot()` utility to separate `!tag` sugar.
- [ ] Add new options-object overload & unit tests (context, all, any, none combinations).
- [ ] Ensure `findDocumentsLegacy` continues to pass existing test-suite.
- [ ] Document examples in README/dev-guide.

## Examples
```js
// dotfiles active on this device
await db.findDocumentsV2({
  context: '/',
  all: ['data/abstraction/dotfile', `client/device/id/${deviceId}`]
});

// notes OR todos, NOT archived, under /work/foo
await db.findDocumentsV2({
  context: '/work/foo',
  any:  ['data/abstraction/note', 'data/abstraction/todo'],
  none: ['flag/archived']
});
```

## Helpers
```ts
function normalizeContext(context?: string | string[]): string {
  if (!context) return '/';
  if (Array.isArray(context)) {
    if (context.length > 0 && context.some(c => c.includes('/'))) {
      throw new Error(`Invalid context array – should be parts, not full paths`);
    }
    return '/' + context.join('/');
  }
  return context;
}
```


## Bitmap index cosmetics

all: [bm.sym('dotfile'), bm.deviceId(deviceId)]

Where bm is a bitmap key namespace builder, so:

We generate keys through functions instead of interpolated strings

We enforce prefix + suffix composition rules

We can memoize + validate + document every domain prefix

```js
const bm = {
  data: (key: string) => `data/${key}`,
  tag:  (key: string) => `tag/${key}`,
  client: (key: string) => `client/${key}`,
  deviceId: (id: string) => `client/device/id/${id}`,
  // etc.
};
```

## 🧪 V3 Proposal – Composable Filter DSL

### Motivation

Enable expressive, human-centric queries that cleanly represent complex logic like:

> *Find all documents with context `/foo/bar/baz` AND on device1 or device2 AND with featureA and (featureB or featureC but not featureD) and timeline between 2022 and 2024.*

### Interface

```ts
type FilterClause =
  | { op: 'and' | 'or' | 'not'; tags: string[] }  // bitmap filters
  | { field: 'timeline'; between: [string, string] }; // special filter

interface FindOptionsV3 {
  context?: string | string[]; // One path only (string or segments)
  filters?: FilterClause[];    // Composable logic filters
  parse?: boolean;             // default true
  limit?: number;              // default undefined
}
```

### Example Usage

```ts
await db.findDocumentsV3({
  context: '/foo/bar/baz',
  filters: [
    { op: 'or', tags: [bm.device('device1'), bm.device('device2')] },
    { op: 'and', tags: [bm.feature('A')] },
    { op: 'or', tags: [bm.feature('B'), bm.feature('C')] },
    { op: 'not', tags: [bm.feature('D')] },
    { field: 'timeline', between: ['2022-01-01', '2024-01-01'] }
  ]
});
```

---

### ✨ Optional Sugar Syntax via Helper DSL

To improve ergonomics and enforce tag safety, provide a builder API:

```ts
filters: [
  bm.or(bm.device('device1'), bm.device('device2')),
  bm.feature('A'), // implicit AND
  bm.or(bm.feature('B'), bm.feature('C')),
  bm.not(bm.feature('D')),
  bm.timelineBetween('2022-01-01', '2024-01-01')
]
```

Where `bm` is a bitmap helper module that abstracts key formatting:

```ts
bm.device(id: string): string
bm.feature(name: string): string
bm.not(...tags: string[]): FilterClause
bm.or(...tags: string[]): FilterClause
bm.and(...tags: string[]): FilterClause
bm.timelineBetween(start: string, end: string): FilterClause
```

---

### Notes

* Logic is **flat and composable**, no recursive trees.
* `context` continues to act as a separate bitmap scope (AND-ed with filters).
* Encourages maintainable, intent-driven queries for both agents and users.
* Aimed at CLI, internal agents, and future UI/graph tooling.

## Transaction support

- We want to support dynamic (stateful) vector-store-powered retrieval
- Feature to be moved from canvas-agentd

## ContextTree (`src/views/tree/index.js`) Review Findings

### 1. Recursive Operations

*   **`movePath(pathFrom, pathTo, recursive = false)`**:
    *   **Finding**: The `recursive` parameter is present, and the debug message acknowledges it, but the actual logic to move child nodes recursively is missing. If `recursive` is true, the children of the `nodeToMove` should also be moved under the new destination.
    *   **Proposal**: Implement recursive moving of child nodes when `recursive = true`. This would involve iterating over `nodeToMove.children` and for each child, appropriately reconstructing its new path under `normalizedPathTo` and recursively calling `movePath` or a similar helper logic.

*   **`removePath(path, recursive = false)`**:
    *   **Finding**: The current implementation for recursive removal seems to rely on `parentNode.removeChild(nodeToRemove.id)` to correctly handle the entire subtree rooted at `nodeToRemove`.
    *   **Clarification Needed**: Verify if `TreeNode.removeChild()` is designed to dispose of or detach the entire subtree.
    *   **Proposal**: If `TreeNode.removeChild()` only detaches the direct child, `removePath` (when `recursive = true`) should explicitly iterate through `nodeToRemove.children` and call `removePath` (or a dedicated recursive removal helper) on each child *before* removing `nodeToRemove` itself.

### 2. Unused Parameters/Options

*   **`#showHiddenLayers` (Constructor Option)**:
    *   **Finding**: The `showHiddenLayers` option is initialized in the `ContextTree` constructor but does not appear to be used in any subsequent logic (e.g., in `#buildPathArray`, `buildJsonTree`, or path resolution methods).
    *   **Proposal**: Either implement functionality that respects this option (e.g., filtering out layers/paths marked as hidden) or remove the option if it's not intended for use.

### 3. Potential Method Call Typos

*   **`recalculateTree()`**:
    *   **Finding**: The method calls `this.save()` to persist the recalculated tree.
    *   **Proposal**: There is no public `save()` method in `ContextTree`. This should likely be `await this.#saveTreeToDataStore();` to correctly call the private method for saving.

### 4. Event Payload Consistency

*   **`mergeUp(path)` / `mergeDown(path)`**:
    *   **Finding**: The event payloads for `tree:layer:merged:up` and `tree:layer:merged:down` use `layerName: node.name`. `TreeNode` instances (`node`) do not have a direct `name` property; the layer's name is in `node.payload.name`.
    *   **Proposal**: Change `layerName: node.name` to `layerName: node.payload.name` in these event emissions for correctness.

### 5. Normalization Consistency (Critical)

*   **Path vs. Layer Name Normalization**:
    *   **Finding**: `ContextTree` uses `#normalizePath()` (lowercasing, specific character set `[^a-z0-9._-]`) for path segments. `LayerIndex` is responsible for managing `Layer` objects and likely has its own normalization for layer names (e.g., `Layer.name` should be stored in its canonical, normalized form).
    *   **Concern**: If the normalization schemes of `ContextTree` (for path segments) and `LayerIndex` (for `Layer.name`) are different, or if `LayerIndex.getLayerByName()` is case-sensitive after `ContextTree` has lowercased a segment, then `#getNodesForPath()` could fail to find layers.
    *   **Proposal**:
        *   Ensure that the normalization applied to layer names within `LayerIndex` (and upon `Layer` creation/modification) is consistent with `ContextTree`'s `#normalizePath()` segment normalization.
        *   Ideally, there should be a shared utility or single source of truth for this normalization logic to avoid discrepancies.
        *   Clarify if `Layer.name` is always stored in its normalized form.

### 6. Transactionality and Atomicity

*   **Complex Operations (e.g., `movePath`, `copyPath`)**:
    *   **Finding**: Operations like `movePath` (remove from old parent, add to new parent, save tree) involve multiple steps. These are not currently performed atomically. If a failure occurs mid-operation (e.g., data store write fails), the tree might be left in an inconsistent state.
    *   **Consideration for Future**: For a core database component, implementing or ensuring atomicity for such multi-step tree modifications (perhaps via a transaction mechanism in the `dataStore` or explicit rollback logic) could be beneficial for robustness. This is likely a larger architectural consideration.

### 7. Path Segment Character Set

*   **`#normalizePath()` character restriction**: `segment.toLowerCase().replace(/[^a-z0-9._-]/g, '')`
    *   **Observation**: This restricts path segments (derived from layer names) to lowercase alphanumeric characters, dots, underscores, and hyphens. Spaces and other special characters are removed.
    *   **Note**: This is a valid design choice for structural names. User-friendly display names with richer characters should be stored in `Layer.label` or `Layer.description` and used for UI purposes, while the tree structure relies on these normalized names. This is more of a documentation/design note.

### 8. General Code Clarity and Readability

*   **Overall**: The code is generally well-structured and includes helpful debug messages.
*   **`#db` coupling**: The tight coupling to SynapsD via `this.#db` for document operations is noted. It positions `ContextTree` as an integral view within SynapsD rather than a generic, standalone tree library.

---
Next Steps:
- Review `BitmapCollection.js`
- Review `Bitmap.js`
