# SynapsD TODO and Review Notes

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
