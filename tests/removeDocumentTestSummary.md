# removeDocument Root Context Protection & Hierarchical Removal Tests

## Issues Fixed

### 1. Root Context Protection
The `removeDocument` method was originally designed to remove documents from specific context paths (like removing symlinks from folders), but it was incorrectly allowing removal from the root "/" context, which conceptually should not be allowed.

### 2. Hierarchical Removal Behavior  
The `removeDocument` method was removing documents from ALL hierarchical contexts by default (`/projects/web/frontend` → removes from `projects`, `web`, AND `frontend`), which was counterintuitive. Users expected removal from the specific context only.

## Solutions Implemented

### 1. Root Context Protection
Modified the `removeDocument` method in `src/index.js` to:
- **Prevent removal from root context only**: If the contextSpec resolves to only `["/"]`, throw an error
- **Filter root from mixed contexts**: If the contextBitmapArray contains "/" along with other paths, remove the "/" from the array before processing
- **Validate filtered results**: After filtering, ensure at least one context remains to operate on

### 2. Hierarchical Removal Control
Added an `options.recursive` parameter to control hierarchical removal behavior:
- **Default (non-recursive)**: Remove from leaf context only (most intuitive)
- **Explicit recursive**: Remove from entire hierarchy when `{ recursive: true }` is passed

## API Changes

### New Method Signatures
```javascript
// Single document removal
async removeDocument(docId, contextSpec = '/', featureBitmapArray = [], options = { recursive: false })

// Array document removal  
async removeDocumentArray(docIdArray, contextSpec = '/', featureBitmapArray = [], options = { recursive: false })
```

### Usage Examples
```javascript
// Remove from leaf context only (new default)
await db.removeDocument(docId, '/projects/web/frontend');
// → Removes from 'frontend' only, preserves 'projects' and 'web'

// Remove from entire hierarchy (explicit)
await db.removeDocument(docId, '/projects/web/frontend', [], { recursive: true });
// → Removes from 'projects', 'web', AND 'frontend'

// Still prevents root removal (both modes)
await db.removeDocument(docId, '/'); 
// → Throws error: "Cannot remove document from root context"
```

## Key Protection Logic
```javascript
// Check if we're trying to remove from root context only
if (contextBitmapArray.length === 1 && contextBitmapArray[0] === '/') {
    throw new Error('Cannot remove document from root context "/". Use deleteDocument to permanently delete documents.');
}

// Remove root "/" from the array if it exists alongside other contexts
let filteredContextArray = contextBitmapArray.filter(context => context !== '/');

// Handle recursive vs non-recursive removal
if (!options.recursive) {
    // Non-recursive: remove from leaf context only (last element in the path)
    const leafContext = filteredContextArray[filteredContextArray.length - 1];
    filteredContextArray = [leafContext];
} else {
    // Recursive: remove from all contexts in the hierarchy (old behavior)
}
```

## Tests Passed

### Test 1: Root Context Protection (`removeDocumentRootTest.js`)
- ✅ Prevents removal from explicit root "/" 
- ✅ Prevents removal from empty string (defaults to "/")
- ✅ Prevents removal from null/undefined (defaults to "/")
- ✅ Allows removal from specific contexts like "/test/specific/path"
- ✅ Preserves document in root after removal from specific context

### Test 2: Mixed Context Handling (`removeDocumentMixedContextTest.js`)  
- ✅ Properly filters out "/" from mixed context arrays like `['/test/path1', '/', '/test/path2']`
- ✅ Removes document from specified paths while preserving root presence
- ✅ Document exists in root but not in specific paths after removal

### Test 3: Recursive vs Non-Recursive Behavior (`recursiveRemovalTest.js`)
- ✅ **Non-recursive (default)**: Removes from leaf context only
- ✅ **Recursive (explicit)**: Removes from entire hierarchy when requested
- ✅ **Array operations**: Support both modes consistently
- ✅ **Backward compatibility**: Existing code works with new default behavior

### Test 4: Existing Functionality (`fullApiTest.js`)
- ✅ Existing legitimate usage patterns continue to work correctly
- ✅ `removeDocument(docId, '/test/path')` works as expected with new default

## Conceptual Model

### Document Removal Operations
- **`removeDocument`** (non-recursive): Removes documents from specific context paths only (like unlinking a single symlink) - **cannot remove from root "/"**
- **`removeDocument`** (recursive): Removes documents from entire context hierarchy (like unlinking symlink and all parent directories if empty)
- **`deleteDocument`**: Permanently deletes documents from the database entirely (like deleting the actual file)

### Context Hierarchy Behavior
```
Before: removeDocument(id, '/projects/web/frontend')
- Old behavior: Removed from projects, web, AND frontend  
- New behavior (default): Removes from frontend ONLY
- New behavior (recursive): Removes from projects, web, AND frontend (explicit opt-in)
```

The root "/" context represents the fundamental existence of the document, similar to how the actual file exists on disk. `removeDocument` can only remove "symlinks" (context associations) but cannot remove the fundamental document existence, and now provides intuitive control over hierarchical removal scope.
