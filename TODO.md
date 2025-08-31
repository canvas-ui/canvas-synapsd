# Generic TODO

- Add backup policy, backup DB every day at 2AM server time, keep 7 days of backups(default, configurable for each workspace, config in workspace.json at each workspace path, should work on an active workspace only)

- Add backup/restore functionality internally (full db backup/restore, we'll implement snapshoting for undo/redo ops later)

- Update mergeUp/Down + subtractUp/Down methods to use layerName, contextPath  instead of contextPath only

## current API

- mergeUp(contextPath): merge the bitmap of layer "foo" in context path "/work/foo/bar/baz" to bitmaps "bar" and "baz"
- mergeDown(contextPath): merge the bitmap of layer "foo" in context path "/work/foo/bar/baz" to bitmap "work"
- subtractUp(contextPath): subtract the bitmap of layer "foo" in context path "/work/foo/bar/baz" from bitmaps "bar" and "baz"
- subtractDown(contextPath): subtract the bitmap of layer "foo" in context path "/work/foo/bar/baz" from bitmap "work"

## alternative (TBD?) API

- mergeUp(layerName, contextPath): merge the bitmap of layer "foo" in context path "/work/foo/bar/baz" to bitmaps "bar" and "baz"
- mergeDown(layerName, contextPath): merge the bitmap of layer "foo" in context path "/work/foo/bar/baz" to bitmap "work"
- subtractUp(layerName, contextPath): subtract the bitmap of layer "foo" in context path "/work/foo/bar/baz" from bitmaps "bar" and "baz"
- subtractDown(layerName, contextPath): subtract the bitmap of layer "foo" in context path "/work/foo/bar/baz" from bitmap "work"

- Add support for layer type Label -> label type does not have a bitmap and should be removed form contextSpec as its not counted
- Ensure locked layers can not be moved/removed/deleted/renamed

- ! Implement a off-thread worker to post-process ingested documents (to calculate embeddings, tag bitmaps etc)
- ! Create a *proper* collection abstraction, esp. for Bitmaps
- ! Refactor those ***UGLY*** insert/updateDocument methods!!!
- ! Add a new "root" layer type, prevent all ops on the root layer, root "/" layer should always be locked
- format option
  - full
  - data+meta (data)
  - meta
- Add zod validators to internal schemas
- Add zod-to-json (zod v4) schema support
- Besides standard document abstractions, we need to support Canvases and Workspaces, most probably we should remove them from internal or create a proper document abstraction for this type, anyway, todo, lets finally focus on a *usable* mvp damn it!!

# findDocuments API Refactor (Bitmap Filter DSL)

## Motivation
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

## To eval

- Integrate storeD, we want to be able to store documents in different locations while keeping a simple SPOT index what is stored where and from what location it is reachable. This would allow us to store data in different formats - lets say using a simple file backend for on-disk storage as markdown text files
- Use https://unstorage.unjs.io/ instead of a custom lmdb wrapper?, in worst cases we can write a small lmdb driver for unstorage if we'll feel its justified

### Transaction support

- We want to support dynamic (stateful) vector-store-powered retrieval
- We should start a query transaction and dynamically update the tree/bitmap arrays based on retrieved document metadata we received which should stay cached in-memory for the duration of that transaction. But more importantly, we should be able to refine which snippets/keywords/factoids we want to focus on dynamically - this means that instead of chunking up the whole document to calculate embedding vectors, we'd first process it to generate specific topics/tags/factoids/concepts, calculate and store embeddings of those, parse our query into the same and do a vector-db similarity search. Once a batch of documents is retrieved - as metadata - we can further refine the query (dive "deeper" into the memory) by silencing/removing/reorganizing items in the factoid/concept array (while optionally - simultaneously updating our context tree/bitmap refs) and update the resulting document metadata array. We can then retrieve the top N documents in full with the rest of as metadata only. Should be fairly simple to test:
  - Ingestion pipeline that would off-thread process documents, we need to do this anyway for things like browser tabs (I'd like to download a ofline copy and process it for RAG whenever a tab gets inserted), same for notes, emails etc
    - Pipeline would first fetch the linked content if applicable
    - Extract concepts, factoids, tags from the data and store them in the metadata part of the document(we will need to update our schemas a little), not used directly but will be useful when using different embedding models
    - Calculate embeddings for all data and store them in a vector DB(not sure it'd make sense to store them in the document object itself, we support embeddings directly for use-cases like file indexing where the client itself would calculate embeddings)
  
