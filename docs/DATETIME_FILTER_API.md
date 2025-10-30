# Datetime Filter API

## Overview

The TimestampIndex is now integrated with the main SynapsD filter API. You can filter documents by timestamp using either **string-based** or **object-based** filters in the `filterArray` parameter of `findDocuments()`, `listDocuments()`, and `ftsQuery()`.

## Filter Formats

### String-Based Filters (Simple & Concise)

```javascript
// Timeframe filters
'datetime:updated:today'         // Files updated today
'datetime:created:yesterday'     // Files created yesterday
'datetime:updated:thisWeek'      // Files updated this week
'datetime:created:thisMonth'     // Files created this month
'datetime:deleted:thisYear'      // Files deleted this year

// Range filters
'datetime:updated:range:2023-10-01:2023-10-31'  // Files updated in October 2023
'datetime:created:range:2025-01-01:2025-12-31'  // Files created in 2025
```

### Object-Based Filters (Structured)

```javascript
// Timeframe filter
{
  type: 'datetime',
  action: 'updated',      // 'created' | 'updated' | 'deleted'
  timeframe: 'today'      // 'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'thisYear'
}

// Range filter
{
  type: 'datetime',
  action: 'created',
  range: {
    start: '2023-10-01',
    end: '2023-10-31'
  }
}
```

## Usage Examples

### Example 1: Find files updated today

```javascript
// String-based
const todayFiles = await db.findDocuments(
  '/',                              // contextSpec
  [],                               // featureBitmapArray
  ['datetime:updated:today']        // filterArray
);

// Object-based
const todayFiles = await db.findDocuments(
  '/',
  [],
  [{
    type: 'datetime',
    action: 'updated',
    timeframe: 'today'
  }]
);
```

### Example 2: Find notes created this week

```javascript
const thisWeekNotes = await db.findDocuments(
  '/projects/canvas',               // context
  ['canvas/Note'],                  // feature: only Note documents
  ['datetime:created:thisWeek']     // filter: created this week
);
```

### Example 3: Find files updated in a specific date range

```javascript
const octoberUpdates = await db.findDocuments(
  '/',
  [],
  ['datetime:updated:range:2023-10-01:2023-10-31']
);

// Or with object syntax
const octoberUpdates = await db.findDocuments(
  '/',
  [],
  [{
    type: 'datetime',
    action: 'updated',
    range: {
      start: '2023-10-01',
      end: '2023-10-31'
    }
  }]
);
```

### Example 4: Combine datetime filters with other filters

```javascript
// Find important notes updated today
const importantTodayNotes = await db.findDocuments(
  '/projects/canvas',
  ['canvas/Note'],
  [
    'feature/important',           // Regular bitmap filter
    'datetime:updated:today'       // Datetime filter
  ]
);
```

### Example 5: Full-text search with datetime filtering

```javascript
// Search for "typescript" in files updated this week
const results = await db.ftsQuery(
  'typescript',                    // search query
  '/',                             // context
  [],                              // features
  ['datetime:updated:thisWeek'],   // filters
  { limit: 50 }
);
```

### Example 6: Multiple datetime filters (advanced)

```javascript
// Files created this month OR updated today
// Note: Multiple datetime filters are ANDed together
const recent = await db.findDocuments(
  '/',
  [],
  [
    'datetime:created:thisMonth',
    'datetime:updated:today'
  ]
);
```

## Supported Actions

- **`created`** - Filter by document creation timestamp
- **`updated`** - Filter by document update timestamp  
- **`deleted`** - Filter by document deletion timestamp

## Supported Timeframes

- **`today`** - Documents from today
- **`yesterday`** - Documents from yesterday
- **`thisWeek`** - Documents from this week (Sunday to today)
- **`thisMonth`** - Documents from this month
- **`thisYear`** - Documents from this year

## Date Format

All dates must be in **ISO 8601 format**: `YYYY-MM-DD`

Examples:
- `2023-10-26`
- `2025-01-01`
- `2024-12-31`

## Filter Behavior

1. **Multiple filters are ANDed** - All filters must match
2. **Datetime filters work with context/feature filters** - They're combined efficiently using bitmap operations
3. **Invalid filters are skipped** - The query continues with valid filters
4. **Empty results** - If no documents match, returns empty array

## Performance Notes

- ✅ **Efficient**: Uses bitmap operations for fast filtering
- ✅ **Scalable**: Works with millions of documents
- ✅ **Combined filters**: Context + Features + Datetime filters are all optimized
- ⚠️ **Index required**: TimestampIndex must be initialized (happens on `db.start()`)

## API Methods Supporting Datetime Filters

All methods that accept `filterArray` now support datetime filters:

- `findDocuments(contextSpec, featureBitmapArray, filterArray, options)`
- `listDocuments(contextSpec, featureBitmapArray, filterArray, options)` (alias)
- `ftsQuery(queryString, contextSpec, featureBitmapArray, filterArray, options)`

## Error Handling

Invalid datetime filters are logged and skipped gracefully:

```javascript
// Invalid action - skipped
'datetime:viewed:today'  // ❌ 'viewed' is not a valid action

// Invalid timeframe - skipped
'datetime:updated:lastWeek'  // ❌ 'lastWeek' not supported (use 'thisWeek')

// Invalid date format - may throw
'datetime:updated:range:2023/10/01:2023/10/31'  // ❌ Use YYYY-MM-DD format
```

## Migration from Direct TimestampIndex Usage

If you were using `db.timestampIndex` directly:

```javascript
// OLD (direct access)
const ids = await db.timestampIndex.findByTimeframe('today', 'updated');
const docs = await db.getDocumentsByIdArray(ids);

// NEW (integrated API)
const docs = await db.findDocuments(
  null,
  [],
  ['datetime:updated:today']
);
```

## Design Rationale

### Why Both String and Object Formats?

- **Strings**: Simple, concise, URL-friendly, easy to serialize
- **Objects**: Type-safe, validated, extensible, IDE-friendly

### Why Prefix with `datetime:`?

- Prevents collision with bitmap filter keys
- Makes filter type immediately obvious
- Allows future filter types: `geo:`, `numeric:`, etc.

### Why Action is Required?

- Documents have 3 timestamp types (created, updated, deleted)
- Explicit action prevents ambiguity
- Allows precise filtering: "created today" vs "updated today"

---

**Integrated in:** SynapsD v2.0.0-alpha.2+  
**Index:** TimestampIndex (bitmap-based)  
**Format:** ISO 8601 dates (YYYY-MM-DD)

