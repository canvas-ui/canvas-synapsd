# removeDocument Usage Examples

## Overview
The `removeDocument` method provides precise control over removing documents from context hierarchies, following standard conventions found in file systems and other hierarchical data structures.

## API Signature
```javascript
async removeDocument(docId, contextSpec = '/', featureBitmapArray = [], options = { recursive: false })
async removeDocumentArray(docIdArray, contextSpec = '/', featureBitmapArray = [], options = { recursive: false })
```

## Standard Behavior Examples

### 1. Non-Recursive Removal (Default)
Remove from the specific (leaf) context only - the most intuitive behavior.

```javascript
// Document exists in: /, projects, web, frontend
await db.removeDocument(docId, '/projects/web/frontend');

// Result: Document now exists in: /, projects, web (frontend removed)
console.log(await db.hasDocument(docId, '/projects'));        // true
console.log(await db.hasDocument(docId, '/projects/web'));    // true  
console.log(await db.hasDocument(docId, '/projects/web/frontend')); // false
```

### 2. Recursive Removal (Explicit)
Remove from the entire context hierarchy when explicitly requested.

```javascript
// Document exists in: /, projects, web, backend
await db.removeDocument(docId, '/projects/web/backend', [], { recursive: true });

// Result: Document now exists in: / only (all hierarchy removed)
console.log(await db.hasDocument(docId, '/projects'));        // false
console.log(await db.hasDocument(docId, '/projects/web'));    // false
console.log(await db.hasDocument(docId, '/projects/web/backend')); // false
```

### 3. Root Context Protection
The root "/" context cannot be removed - use `deleteDocument` instead.

```javascript
// These all throw errors:
await db.removeDocument(docId, '/');                    // ❌ Error
await db.removeDocument(docId, '');                     // ❌ Error 
await db.removeDocument(docId, null);                   // ❌ Error

// Correct way to permanently delete:
await db.deleteDocument(docId);                         // ✅ Deletes entirely
```

## Practical Use Cases

### Document Organization System
```javascript
// Organize a research paper in multiple categories
const paperId = await db.insertDocument(paper, '/research/ai/nlp/transformers');

// Remove from specific subcategory only (non-recursive default)
await db.removeDocument(paperId, '/research/ai/nlp/transformers');
// → Still accessible via /research, /research/ai, /research/ai/nlp

// Remove from entire AI research branch (recursive)
await db.removeDocument(paperId, '/research/ai/nlp/transformers', [], { recursive: true });
// → Only accessible via /research (everything under /ai removed)
```

### File System-like Operations
```javascript
// File exists in: /docs/projects/2024/reports
const reportId = await db.insertDocument(report, '/docs/projects/2024/reports');

// "Unlink" from reports folder only
await db.removeDocument(reportId, '/docs/projects/2024/reports');
// → File still exists in parent directories: /docs, /projects, /2024

// "Recursive unlink" from 2024 and all subdirectories  
await db.removeDocument(reportId, '/docs/projects/2024/reports', [], { recursive: true });
// → File only exists in: /docs, /projects
```

### Tag Management System
```javascript
// Document tagged with: /tags/work/urgent/priority1
const taskId = await db.insertDocument(task, '/tags/work/urgent/priority1');

// Remove specific priority tag only
await db.removeDocument(taskId, '/tags/work/urgent/priority1');
// → Still tagged with: /tags, /work, /urgent

// Remove entire work context
await db.removeDocument(taskId, '/tags/work/urgent/priority1', [], { recursive: true });
// → Only tagged with: /tags
```

## Array Operations

### Batch Non-Recursive Removal
```javascript
const docIds = [101, 102, 103, 104];

// Remove all documents from 'completed' status only
const result = await db.removeDocumentArray(
    docIds, 
    '/projects/status/completed',
    [],
    { recursive: false }  // default
);

console.log(`Removed ${result.successful.length} documents from 'completed' status`);
// Documents still exist in /projects and /projects/status
```

### Batch Recursive Removal
```javascript
// Remove documents from entire project hierarchy
const result = await db.removeDocumentArray(
    docIds,
    '/projects/status/completed', 
    [],
    { recursive: true }
);

// Documents removed from: projects, status, AND completed contexts
```

## Comparison with File System Commands

| Operation | File System | SynapsD removeDocument |
|-----------|-------------|----------------------|
| Remove file from directory | `rm /path/file` | `removeDocument(id, '/path')` |
| Remove directory recursively | `rm -r /path/` | `removeDocument(id, '/path', [], {recursive: true})` |
| Cannot remove root | `rm /` → protected | `removeDocument(id, '/')` → throws error |
| Delete file permanently | `shred file` | `deleteDocument(id)` |

## Migration from Old Behavior

### Before (v1 - Recursive by Default)
```javascript
// Old: Always removed from entire hierarchy
await db.removeDocument(docId, '/projects/web/frontend');
// Removed from: projects, web, AND frontend
```

### After (v2 - Non-Recursive by Default)
```javascript
// New default: Remove from leaf only
await db.removeDocument(docId, '/projects/web/frontend');
// Removes from: frontend ONLY

// Explicit recursive for old behavior
await db.removeDocument(docId, '/projects/web/frontend', [], { recursive: true });
// Removes from: projects, web, AND frontend (same as old)
```

## Best Practices

1. **Use non-recursive by default** - it's more predictable and follows principle of least surprise
2. **Be explicit with recursive** - only use when you specifically need hierarchical removal
3. **Use deleteDocument for permanent removal** - don't try to remove from root "/"
4. **Batch operations** - use `removeDocumentArray` for better performance on multiple documents
5. **Error handling** - wrap in try/catch to handle validation errors gracefully

```javascript
try {
    await db.removeDocument(docId, contextPath, features, options);
} catch (error) {
    if (error.message.includes('root context')) {
        // Handle root removal attempt
        console.log('Use deleteDocument for permanent deletion');
    } else {
        // Handle other errors
        console.error('Removal failed:', error.message);
    }
}
``` 
