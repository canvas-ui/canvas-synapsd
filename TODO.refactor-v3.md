# synapsd v3 refactor — implementation plan

Starting point for Claude Code. Grounded against `canvas-ui/canvas-synapsd@9f74f50`
(2026-08-02). Companion design doc: `synapsd-schema-v3-l0-l3.md` (L0–L3 spec) — this
file is the *how*, that file is the *why*. No backward compatibility anywhere: no
alias tables, no dual-namespace reads, one migration command, hard break.

## Architecture recap (1 paragraph)

synapsd is an index; `stored`/backends own bytes. L0 = storage facts as row fields
(`checksumArray`, `locations[]` — already top-level in BaseDocument.js:108–130, orphan
lifecycle already landed). L1 = entity documents under a new `data/entity/*`
namespace with subtype-as-`kind`, minimal core set + runtime-registered app schemas.
L2 = asserted edges declared in `data.relations`, mirrored into dupsort adjacency
DBIs. L3 = derived plane (extracted edges, kind/mime bitmaps, embeddings, timeline,
checksums) — deletable, recomputable from rows. Rebuild invariant: rows + extractors
reproduce every index structure.

## Verified platform facts (do not re-litigate)

`lmdb@3.5.2` (pinned in package.json) supports `dupSort: true` via `openDB` on the
existing root env. Verified behavior on this exact version:

- `put(key, value)` into a dup set is sorted, deduped (repeat key/value = no-op ⇒
  idempotent edge writes).
- `getValues(key)` iterates the dup set sorted; accepts `{start}` for seek/pagination.
- `getValuesCount(key)` = O(1)-ish out-degree from the B-tree.
- `doesExist(key, value)` = point edge-existence check.
- `remove(key, value)` removes a single pair.
- `getRange({start:[id], end:[id, Infinity]})` prefix-scans across predicates with
  `ordered-binary` array keys.
- Caveats: dupsort values inherit key-class size limits (~8KB) — fine for int ids,
  but edge payloads must NOT go in dup values; reverse `getValues` iteration had a
  historical `start`-ignoring bug — use forward iteration only; use
  `snapshot:false` for long scans.

---

## Phase 1 — EdgeIndex (new storage primitive)

**New:** `src/indexes/edges/index.js` (+ `src/indexes/edges/predicates.js`)

`predicates.js` — closed registry, 1-byte ids:

```js
export const PREDICATES = {
  'includes':     { id: 1 },
  'references':   { id: 2 },
  'derived-from': { id: 3 },
  'mentions':     { id: 4 },
  'replies-to':   { id: 5 },
};
```

Five predicates, five ids, forward names only. **There are no inverse predicate
names anywhere in the system** — not in the registry, not in persisted data, not in
the query grammar. Direction is an axis (`out`/`in`), expressed by which method you
call (`outgoing`/`incoming`) or a `dir` parameter, never by a string. (An earlier
draft had an ALIASES map resolving `mentioned-by → mentions`; rejected — it erases
direction at the callsite and produces silently-wrong forward scans.)

Naming: **kebab-case is the wire/persisted form** — predicate strings appear in
`data.relations` payloads and query specs alongside the codebase's existing
kebab-cased data strings (`derived-from`, `t:crud:updated`). JS-internal constants
may be whatever; anything serialized is kebab. Ids are persisted in keys ⇒
append-only; never renumber. Adding a predicate is a code change by design.

Datasets (same env, via `LmdbBackend.createDataset` with dupsort passthrough — small
change in `src/backends/lmdb/index.js:~138` to forward `dupSort`/`keyEncoding`/
`encoding` options):

```
edges_fwd   dupSort, keys [fromId, predId] (ordered-binary), values toId
edges_inv   dupSort, keys [toId, predId]   (ordered-binary), values fromId
edge_meta   plain,   keys [fromId, predId, toId], values { src, ts, conf? }
```

Both DBIs store the same predicate id; direction is which DBI you scan.

API — the graph layer is document-unaware: it speaks uint32 **node ids** and
predicates, nothing else (no schema, bitmap, or row knowledge). All writes run
inside the caller's `transactionSync`, matching existing dataset usage:

```js
link(from, p, to, meta?)        // meta = {src, conf?}; writes edge_meta iff meta given
unlink(from, p, to)             // removes fwd+inv pair + meta record
linkMany(edges)                 // edges: [{from, p, to, meta?}] — batch, one txn;
unlinkMany(edges)               //   dupsort idempotent puts make in-batch dedup free
exists(from, p, to)             // point check (doesExist)
edge(from, p, to)               // → {from, p, to, meta} | null; meta defaults to
                                //   {src:'doc'} when no meta record exists — the
                                //   asserted-edge convention never leaks to callers
outgoing(id, p?, opts?)         // lazy iterator over dup set(s); opts: {start, limit}
incoming(id, p?, opts?)         //   same, scanning edges_inv
degree(id, p, dir = 'out')      // getValuesCount on the corresponding DBI
edgesOf(id)                     // → { outgoing: [{p, to}], incoming: [{p, from}] }
deleteNode(id)                  // prefix-delete fwd; walk lists to clean inv mirrors;
                                //   same from inv side; prefix-delete edge_meta
removeEdges({ src, p? })        // edge_meta scan; deletes matching edges. Derived-only
                                //   by construction (asserted edges have no meta row);
                                //   throws on src:'doc'; requires ≥1 selector — no
                                //   silent wipes. Full wipe = explicit clear().
clear()                         // drop all three DBIs (L3 rebuild path)
```

Iterator caveat (put in JSDoc): live iterators pin an LMDB read txn — drain
promptly, never hold across awaits; long scans (removeEdges, rebuilds) pass
`snapshot: false`.

Provenance rule: **asserted edges (derived from `data.relations`) write no meta
record** — absence of meta ⇒ `src:'doc'`, synthesized by `edge()`. Extractor/agent
edges MUST pass `{src:'extractor:<name>'|'agent:<hookId>'}`. `removeEdges({src})` +
re-run extractor = L3 rebuild for edges.

**Tests (new `tests/edges.test.js`):** idempotent link; sorted outgoing/incoming;
degree per direction; pagination via `{start}`; unlink removes both mirrors + meta;
linkMany/unlinkMany batch semantics incl. in-batch duplicates; edge() meta synthesis
for asserted edges; deleteNode leaves zero keys mentioning the id in any of the
three DBIs (assert by full scan); removeEdges removes derived, cannot touch
asserted, throws on `src:'doc'` and on empty selector; predicate rejection for
unknown names and for any inverse-style name (`mentioned-by` must throw, not
resolve).

## Phase 2 — kill bitmap relations

- Delete `src/indexes/inverted/Relations.js`; re-point every consumer (grep
  `relate(`, `unrelate(`, `getRelated(`, `rel/` across `src/` and `src/index.js`) to
  EdgeIndex. Keep the public method names on the SynapsD class stable if convenient,
  but the `rel/` bitmap namespace dies: remove `'rel/'` from
  `src/indexes/bitmaps/lib/keys.js` allowed prefixes so any straggler write throws.
- Do NOT implement `rel/has/*` coarse bitmaps (parked; additive later).
- `Synapses.js` interplay: check `inheritMemberships` call sites that took the
  bitmap-based relations; adapt to adjacency arrays.

**Tests:** existing relations tests ported 1:1 to EdgeIndex semantics; a canary test
asserting `bitmapIndex` refuses `rel/` keys.

## Phase 3 — schema namespace v3 (`data/entity/*`)

Mapping (registry-level; delete files where noted):

```
data/abstraction/document     → data/entity/document
data/abstraction/file         → data/entity/file
data/abstraction/message      → data/entity/message           (schema kept; platform enum → data.type)
data/abstraction/email        → data/entity/message  kind:email      (Email.js: fold zod into message
                                                                      email-variant validator, delete file)
data/abstraction/todo         → data/entity/task               (rename Todo.js → Task.js)
data/abstraction/contact      → data/entity/identity type:person     (rename/generalize Contact.js)
data/abstraction/device       → data/entity/device
data/abstraction/application  → data/entity/application
data/abstraction/note         → data/entity/document kind:note        (app-level; see registry split)
data/abstraction/tab          → data/entity/document kind:browser-tab (app-level)
data/abstraction/link         → data/entity/document kind:link        (app-level)
data/abstraction/dotfile      → data/entity/file     kind:dotfile     (app-level)
data/abstraction/bucket       → DELETED (folders are tree nodes; DirectoryTree covers it)
+ NEW data/entity/event       (type: calendar | alert | activity)
```

Registry split (`src/schemas/SchemaRegistry.js`):

- Core set hardcoded: document, file, message, event, task, identity, device,
  application. All `schemaVersion: '3.0'`.
- `registerSchema(id, { dataSchema, kind?, indexOptions?, relationsMap? })` runtime
  API for app schemas (Note/Tab/Link/Dotfile variants register from canvas-server;
  ship a `examples/` registration or keep them in a `src/schemas/contrib/` loaded
  explicitly by tests until canvas-server lands its side).
- Delete `'BaseDocument'` alias and every `data/abstraction/*` id in the same commit.

Row shape changes (`src/schemas/BaseDocument.js`):

- **Remove `indexOptions` from rows** (lines ~78, 156–184). It becomes a property of
  the schema registration; resolution order: registration → core defaults. Ingest
  reads it from the registry, never from the row.
- **Add top-level `kind` and `mime`** (optional strings), stamped at ingest;
  mirrored to `data/kind/<v>` and `data/mime/<type>/<subtype>` bitmaps (prefixes
  already exist? verify in `keys.js`; add if missing).
- Feature auto-injection at BaseDocument.js:198–204 keeps mirroring the (new)
  schema id.
- `data.relations` (optional array of `{p, to}`) accepted by the base zod schema;
  excluded from `checksumFields` and embedding fields defaults.

**Tests:** registry resolves all core ids and rejects `data/abstraction/*`;
registerSchema round-trip incl. indexOptions resolution; kind/mime stamped and
bitmap-mirrored; checksum stability when only `data.relations` changes.

## Phase 4 — ingest derivation of asserted edges

In the insert/update path in `src/index.js` (locate `insertDocument`/`putMany` batch
pipeline):

- On insert: for each `data.relations[{p,to}]` → `edges.link(id, p, to)` (no meta).
- On update: diff old vs new `data.relations`; link/unlink the delta. Asserted edges
  are *owned* by the row — an update removing an entry removes the edge, but must
  not touch derived edges between the same pair (meta presence distinguishes).
- On delete: `edges.deleteNode(id)` joins the existing per-doc cleanup
  (bitmaps, checksums, timeline) inside the same txn.
- Dangling `to` ids: policy = allow (log at debug); edges to nonexistent docs are
  filtered at query time by candidate-set intersection anyway; `deleteNode`
  cleanup keeps them from accumulating for known ids.

**Tests:** insert/update/delete round-trips; update-diff preserves derived edge
between same pair; batch `putMany` derives edges for all docs in one txn.

## Phase 5 — query integration (`rel` bucket)

`src/utils/spec.js` — add a `rel` bucket to `parseSpec` output. Structured form
(primary; token sugar can come later if the CLI wants it):

```js
query(match, {
  rel: { p: 'mentions', of: 123 },                 // docs that 123 mentions
  rel: { p: 'mentions', of: 123, dir: 'in' },      // docs mentioning 123 (direction is an axis)
  rel: [ {p:'replies-to', of: 55}, {op:'noneOf', p:'derived-from', of: 55} ],
})
```

Semantics: each entry resolves `outgoing(of, p)` / `incoming(of, p)` per `dir`
(default `'out'`) → materialized sorted array → ephemeral roaring bitmap →
composes into the existing candidate pipeline under sigil algebra (`op`:
anyOf default / allOf / noneOf — same trio as features). One hop only in v3;
multi-hop traversal is out of scope (park it).

Implementation: in the query execution path where path/feature bitmaps are
intersected (SynapsD.query/list internals), lift each rel entry's sorted int array
via `RoaringBitmap32.deserialize`-free construction (`new RoaringBitmap32(array)` is
fine — arrays arrive sorted) and AND/OR/ANDNOT per `op`.

**Tests:** rel-only query; rel ∧ context path; rel ∧ features noneOf; empty
adjacency ⇒ empty result fast-path; `dir:'in'` equals swapped-DBI scan.

## Phase 6 — migration + rebuild command

`scripts/migrate-v3.js` (or extend existing scripts/):

1. Env version gate: write `internal/version = 3` marker; refuse v2 opens without
   `--migrate` (check `metadata`/`internal` dataset conventions at
   src/index.js:235–247).
2. Single pass over `documents`: rewrite `schema` per mapping table (incl.
   email→message+kind), stamp `kind`/`mime` (registry-driven detection), move any
   schema-specific edge-ish fields into `data.relations` (email attachments if
   modeled, tab→offline-file derivations — audit per schema), drop `indexOptions`,
   normalize `metadata.features` (old schema id out, new in).
3. Drop all `rel/` bitmap keys; drop feature bitmaps keyed by old schema ids.
4. Replay ingest derivation: edges from `data.relations`; kind/mime bitmaps;
   (checksums/timeline/embeddings untouched — ids stable).
5. `synapsd rebuild --plane l3 [--src <s>]` subcommand: `removeEdges({src})`/drop derived
   structures + re-run ingest derivation. Even a minimal version (edges + kind/mime
   only) locks in the rebuild invariant mechanically.

**Tests:** migrate a fixture v2 env (build one in tests/fixtures via the old code
path pinned as JSON rows) → assert schema ids, kind, edges, absent rel/ keys,
absent indexOptions; idempotency (running migrate twice = no-op).

## Phase 7 — docs & sweep

- Update README/TODO architecture sections; move the L0–L3 spec into `docs/`.
- Grep sweep: `data/abstraction`, `indexOptions`, `rel/`, `Bucket`, `'BaseDocument'`
  must return zero hits in `src/` (tests may reference fixtures).

## Sequencing & risk notes

- Phases 1–2 are independent of 3–4 and land first (edge primitive is
  self-contained; bitmap-relations deletion is low-blast-radius — predicate surface
  is tiny today).
- Phase 3 is the big-bang commit; 4 and 5 depend on it. Keep 3+4 in one PR so the
  repo never has entity rows without edge derivation.
- Watch: `src/index.js` is 4.9k lines — the insert/update/delete and query paths are
  the two integration surfaces; everything else is additive files. Backend change in
  Phase 1 (dupsort passthrough) is ~5 lines but verify `datasetOptions` doesn't
  already strip unknown keys.

## Non-goals (explicitly out)

Version chains / same-path-new-checksum successor migration (reconciliation design
owns it); `rel/has/*` coarse bitmaps; multi-hop traversal; MDB_DUPFIXED packing;
token-string sugar for the rel bucket; any back-compat shims.
