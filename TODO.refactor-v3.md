# synapsd v3 refactor — implementation plan

Starting point for Claude Code. Grounded against `canvas-ui/canvas-synapsd@9f74f50`, re-verified
against `505cc93` on 2026-08-02. Companion design doc: `synapsd-schema-v3-l0-l3.md` (L0–L3 spec)
— this file is the *how*, that file is the *why*. No backward compatibility shims anywhere: no
alias tables, no dual-namespace reads, one migration command. **Schema *id strings* are exempt —
they stay `data/abstraction/*` (see D1 below); that is id stability, not a compat shim, and it is
what keeps the hard break confined to a single store.**

## Architecture recap (1 paragraph)

synapsd is an index; `stored`/backends own bytes. L0 = storage facts as row fields
(`checksumArray`, `locations[]` — already top-level in BaseDocument.js:108–130, orphan
lifecycle already landed). L1 = entity documents keeping their `data/abstraction/*`
ids, with subtype-as-`kind`, minimal core set + runtime-registered app schemas.
L2 = asserted edges declared in `data.relations`, mirrored into dupsort adjacency
DBIs. L3 = derived plane (extracted edges, kind/mime bitmaps, embeddings, timeline,
checksums) — deletable, recomputable from rows. Rebuild invariant: rows + extractors
reproduce every index structure.

## Decisions (raised in review 2026-08-02 — both now RESOLVED)

**D1 — RESOLVED 2026-08-02: option (c). The `data/abstraction/*` ids stay; only the model
changes.** ~~Rename to `data/entity/*`.~~ Measured cost of the rename: ~272 occurrences outside
synapsd across **five sibling git submodules** — `ui/web` (47), `browser-extensions` (33),
`ui/fuse` (25, Rust), `ui/cli` (20), `ui/shell` (6) — plus a **public HTTP route path**
(`src/transports/routes/schemas.js:27`, `/data/abstraction/:abstraction`), the embedd router
(`src/services/embedd/src/router.js:34,38,110,117`) and a **shipped config file**
(`server/config/embedd.example.json`). The decisive case was the **browser extension**: installed
in users' browsers, not atomically upgradable with the server, so it keeps writing
`data/abstraction/tab` after any cutover — a hard break there is a support incident, not a
migration. Rejected alternatives: (a) hard break + forced extension update; (b) a route-level
translation shim (keeps the DB alias-free but adds a permanent seam for no gain).

Consequences, applied throughout this document: Phase 3 is now "model v3", not "namespace v3";
Phase 6's migration shrinks to a derivation replay (no row rewrite); Phase 7's sweep no longer
greps `data/abstraction` to zero; the 24-of-29 test-suite port cost disappears. `kind` becomes the
incremental migration path for consumers — see Phase 3. **The rename is deferred, not cancelled:
it becomes its own rev gated on a coordinated submodule release.**

**D2 — RESOLVED 2026-08-02: fold root-level `features[]` into Phase 3 + Phase 6.**

Scope clarification, because the name oversells it: **the declarative mechanism already exists and
works.** `documentFeatureKeys()` (src/index.js:112) reads the array, validates each key, and every
write path ticks/unticks from it with a prev-state stale-diff — shipped 2026-07-15 as the interim
fix. Its own comment states the contract: *"DECLARATIVE and authoritative: the document JSON says
what it is, and bitmaps follow it 1:1."* D2 is therefore **only about where the field lives**, not
about whether features are doc-declared.

Why fold rather than defer: Phase 6's pass **already rewrites every row** to drop `indexOptions`
(461 B, 41% of a measured note) and stamp `kind`/`mime`. The marginal cost of moving one more
field in that same pass is close to zero, whereas deferring means running an identical
full-table pass twice and doing the BaseDocument surgery twice.

Why the move is right on its own merits (TODO.md, 2026-07-15): `metadata` holds EXTRACTED facts
written by derivers; `features` holds ASSERTED membership written by humans/clients. Today they
share a container, and `BaseDocument.update()` merges metadata as a **single shallow spread**
(:299-301) — so an EXIF enrichment patch and a user tag edit take the same code path at wildly
different write frequencies and trust levels. `comment` is the precedent to copy line for line:
top-level, outside `checksumFields`, own `update()` branch outside the `dataUpdated` path, drives
a derived bitmap (BaseDocument.js:104-108, :282-287).

Two related TODO.md items handed to this rev, now also owned by Phase 3: `data/source/*` → derive
from `locations[].metadata.provider` (today it is stamped from the backend descriptor and is
genuinely NOT rebuildable from doc state — it breaks the rebuild-from-docs property this refactor
exists for), and the `indexOptions` merge-order inconsistency (half the schemas silently discard a
caller's `ftsSearchFields`), which becomes load-bearing the moment resolution moves to the
registry.

## Supersedes (decisions in TODO.md this plan overrides — delete or annotate those sections)

- **Schema inheritance / ancestor-chain ticking** (TODO.md "Decision 2": `tab extends link`, a tab
  ticks both `data/abstraction/tab` and `data/abstraction/link`). This plan replaces it with flat
  `kind`. Consequence to state explicitly: "all links finds tabs" becomes a `kind` query, and the
  `extends` key in the registry-shape sketch there is dead.
- **`link` and `bucket` as synapsd core primitives** (TODO.md "Registry shape" / "Schema
  registration facility"). Here `link` is app-level `document kind:link` and `bucket` is deleted
  outright (folders are tree nodes).
- **`rel/snapshot-of`, `rel/depicts`, `rel/authored-by`** referenced by TODO.md's tab→snapshot and
  contact→identity designs. **RESOLVED 2026-08-03 — `snapshot-of` folds into `derived-from`;
  `depicts` (id 6) and `authored-by` (id 7) are ADDED.** See `predicates.js` for the full
  rationale; the short version: the predicate answers "where did this come from", while *what* it
  is already lives on the target (`kind`/mime/location), so `snapshot-of` would split one
  provenance axis in two forever — whereas `depicts`/`authored-by` cannot be recovered from
  `mentions` later, because a human face-tagging a photo writes an ASSERTED edge (no meta row, so
  no `src` to separate it from a hand-written mention). Conflating is a lossy one-way door;
  appending an id is one line. **Email recipients (To/Cc → identity) are deferred, not rejected**
  — see "Recipients" under Phase 4.

## Verified platform facts (do not re-litigate)

`lmdb` supports `dupSort: true` via `openDB` on the existing root env.

**Version reality, corrected during Phase 1 implementation (2026-08-02):** both this package and
the parent declared `"^3.5.2"`, but the actually-installed (hoisted, deduped) copy was **3.5.6** —
so everything below was verified on 3.5.6, not 3.5.2. Both `package.json`s are now pinned to
`3.5.6`. ⚠️ Pinning **only** the submodule would have been actively harmful: it is an npm
workspace member sharing one hoisted `node_modules/lmdb`, so a divergent exact pin forces a second
*native* LMDB build into the same process. Pin both or neither. Nothing in `src/` passed `dupSort`
before this — a genuinely new storage primitive, not a re-use.

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
  historical `start`-ignoring bug — use forward iteration only.
- ❌ **CORRECTED 2026-08-02 (caught by `tests/edges.test.js`): `snapshot:false` is REFUSED on
  dupSort stores** — lmdb throws *"Can not disable snapshot on a dupSort data store"*. The earlier
  "use `snapshot:false` for long scans" advice holds only for the plain `edge_meta` DBI. Practical
  consequence: scans of `edges_fwd`/`edges_inv` always pin a read txn, so
  **drain-then-mutate is mandatory, not merely tidy** — `deleteNode` materializes its work list
  before writing for exactly this reason.

---

## Phase 1 — EdgeIndex (new storage primitive) — ✅ SHIPPED 2026-08-02

Landed as `src/indexes/edges/{index.js,predicates.js}` + `tests/edges.test.js` (17 tests).
Deviations from the sketch below, all deliberate:

- **`outgoing(id, p, opts)` / `incoming(id, p, opts)` take a REQUIRED predicate**, not the
  optional one sketched. Optional would force a polymorphic yield shape (bare ids with a
  predicate, `{p, to}` pairs without) — a callsite bug factory. `edgesOf(id)` is the
  all-predicates view and returns arrays.
- **Backend change was zero lines** as predicted; `createDataset` passthrough carried
  `{dupSort:true, encoding:'ordered-binary'}` straight through.
- Prefix scans use `{start:[id], end:[id+1]}` rather than `[id, Infinity]` — avoids relying on
  `Infinity` surviving ordered-binary encoding, same range.
- `link()` **throws** on an explicit `{src:'doc'}`: the asserted-edge convention is the *absence*
  of a meta row, so passing it as a value would create an ambiguous second representation.

**New:** `src/indexes/edges/index.js` (+ `src/indexes/edges/predicates.js`)

`predicates.js` — closed registry, 1-byte ids:

```js
export const PREDICATES = {
  'includes':     { id: 1 },
  'references':   { id: 2 },
  'derived-from': { id: 3 },
  'mentions':     { id: 4 },
  'replies-to':   { id: 5 },
  'depicts':      { id: 6 },   // added 2026-08-03
  'authored-by':  { id: 7 },   // added 2026-08-03
};
```

Seven predicates, seven ids, forward names only. **There are no inverse predicate
names anywhere in the system** — not in the registry, not in persisted data, not in
the query grammar. Direction is an axis (`out`/`in`), expressed by which method you
call (`outgoing`/`incoming`) or a `dir` parameter, never by a string. (An earlier
draft had an ALIASES map resolving `mentioned-by → mentions`; rejected — it erases
direction at the callsite and produces silently-wrong forward scans.)

**No `installed-on` predicate — device presence is NOT an edge** (evaluated and rejected
2026-08-02; do not re-propose). "Which dotfiles/apps/files are on device X" is already answered by
the `device/id/*` bitmap derivation, schema-agnostically, for every schema at once — see
"Phase 2b — device presence" below for the full mechanism. An edge would be a second answer to a
solved question, and the weaker one: a bitmap drops straight into the `paths ∩ features ∩ filters`
pipeline, whereas the edge needs the Phase 5 rel-bucket to materialize an array into an ephemeral
bitmap to reach the same place, plus a `deviceId -> device doc id` resolution step and a
migrate-devices-first ordering constraint. Rule of thumb for this registry: **edges are for
document-to-document facts with no derivable location; anything expressible as "these bytes live
here" stays in `locations[]` and its derived bitmaps.**

Naming: **kebab-case is the wire/persisted form** — predicate strings appear in
`data.relations` payloads and query specs alongside the codebase's existing
kebab-cased data strings (`derived-from`, `t:crud:updated`). JS-internal constants
may be whatever; anything serialized is kebab. Ids are persisted in keys ⇒
append-only; never renumber. Adding a predicate is a code change by design.

Datasets (same env, via `LmdbBackend.createDataset` — **no backend change needed**, verified
2026-08-02: `src/backends/lmdb/index.js:129` already spreads `...options` straight into `openDB`
with no whitelist, defaulting only `strictAsyncOrder`. All six existing callers pass no options,
so this is the first use of the passthrough):

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

## Phase 2 — kill bitmap relations — ✅ SHIPPED 2026-08-02

`Relations.js` deleted; `'rel/'` removed from `ALLOWED_BITMAP_PREFIXES`; both `clearRelations`
call sites now `edges.deleteNode(id)`. `db.relations` is replaced by **two** surfaces, not one:
`db.edges` (the pure primitive) and `db.relate()/db.unrelate()` on SynapsD — the document-aware
facade, which is where `inheritMemberships` now lives so that row-shaped concerns stay out of the
graph layer. One straggler found outside the submodule and fixed: `Workspace.js:1707` carried a
guard refusing to delete `rel/*` bitmaps, now unreachable by construction.

Blast radius, measured 2026-08-02 — **smaller than this plan assumed**. `Relations.js` is 138
lines and there are **zero production `relate()`/`unrelate()`/`getRelated()` call sites**: edge
creation is exercised only by `tests/relations.test.js`. The entire live surface is
`clearRelations(docId)` at `src/index.js:1967` (bulk/layer clear) and `:3453` (`#deleteOne`), the
import at `:35`, the instantiation at `:514-516`, and `'rel/'` at `keys.js:13`. So Phase 2 is
~4 lines plus a test port — it can land the same day as Phase 1.

- Delete `src/indexes/inverted/Relations.js`; re-point the consumers listed above to
  EdgeIndex. Keep the public method names on the SynapsD class stable if convenient,
  but the `rel/` bitmap namespace dies: remove `'rel/'` from
  `src/indexes/bitmaps/lib/keys.js` allowed prefixes so any straggler write throws.
- Do NOT implement `rel/has/*` coarse bitmaps (parked; additive later).
- `Synapses.js` interplay: check `inheritMemberships` call sites that took the
  bitmap-based relations; adapt to adjacency arrays.

**Tests:** existing relations tests ported 1:1 to EdgeIndex semantics; a canary test
asserting `bitmapIndex` refuses `rel/` keys.

## Phase 2b — device presence (independent; can land before or after 1–2)

Devices are special: they are the one entity where the interesting question is *presence of other
documents on them*, not the document itself. That question is **already answered** — this phase
closes the holes rather than building anything new. Fully independent of the schema rename; no
migration except a reindex.

**The existing mechanism (verified 2026-08-02 — do not rebuild it):**

```
data.links / data.installs / stored mount   (per-schema)
  → locations[] entries  file://<deviceId>/<path>     Dotfile.js:182, Application.js:223,
                                                      WorkspaceStoredIndex.js:1498
  → #deviceFeaturesFromLocations   index.js:4223      parses authority, ticks device/id/<authority>
  → #indexDocument                 index.js:4196      unions into features on EVERY write path
  → #removeStaleDeviceMembership   index.js:4249      pre/post-write location diff unticks
```

Schema-agnostic, already correct, already has a stale-diff lifecycle. A dotfile mapped to 3
devices ticks 3 `device/id/*` bitmaps today. "Everything on device X" is one bitmap AND.

**The four gaps to close:**

- [x] **Pathless installs are invisible** (correctness bug) — ✅ SHIPPED 2026-08-02. `Application.#buildLocations`
      (Application.js:~236) only emits a location `if (state?.path)` — so a flatpak / snap /
      system install with `status:'available'` and no path produces **no location and therefore no
      device presence at all**. Exactly the install types with no filesystem path are the ones
      missing from "what's on this device". Fix, staying schema-agnostic and inside the one
      mechanism: emit `{url: 'device://<deviceId>', metadata:{status}}` for pathless installs, and
      accept `scheme === 'device'` alongside `'file'` in `#deviceFeaturesFromLocations`
      (index.js:4228). ~3 lines in the derivation, one branch in the schema. Everything downstream
      (tick, stale-diff, query) works unchanged because it all keys off the derived tag.
      Implemented as `deviceUrl()` in path-helpers + a `scheme === 'device'` arm in
      `#deviceFeaturesFromLocations`; `Application.deriveLocations()` now emits
      `device://<deviceId>` for installs with no `state.path`.
- [x] **Constructor-only locations drift** — ✅ SHIPPED 2026-08-02, and **narrower than described**.
      Fixed generically: `BaseDocument.deriveLocations()` is now an overridable hook called at the
      end of `update()`, and `Dotfile`/`Application` override it instead of deriving privately in
      their constructors. Any future deriving schema inherits the correct behaviour.

      Two things the investigation corrected, worth keeping so nobody re-derives the wrong
      mental model:
      1. **Schema-ful updates were never affected.** `#updateOne:3276` calls
         `parseInitializeDocument(updateData)` whenever the payload carries a `schema`, which
         re-runs the subclass constructor and derives locations *before* `update()` sees them.
         Only a **schema-less** `put({id, data})` reached the broken path.
      2. **The symptom is invisible in `locations`.** `db.get()` rebuilds the document through
         the constructor, so a READ re-derives and looks correct even when the stored row is
         stale. Only the write-time bitmaps showed it: without the fix, dropping a device left
         its `device/id/*` ticked forever. Regression tests therefore assert on **bitmap
         membership**, never on `doc.locations` — a locations-based assertion passes either way.
- [~] **Query surface** — the API side is DONE and was never actually missing:
      `db.list({features:['device/id/<x>']})` works (now covered by a cross-schema test), and
      `GET /workspaces/:id/documents?allOf=device/id/<x>` already passes through unstripped
      (`routes/workspaces/documents.js:192-195`; `stripDeviceFeatureTags` is a WRITE-path guard
      only). What is missing is a **consumer**, not an endpoint: nothing in the web UI or CLI ever
      constructs such a filter, and `dot/actions/devices.js:25` still iterates `doc.data.links`
      per-document instead of intersecting the bitmap. Remaining work is UI/CLI, in the parent
      repo — and note the web UI has no dotfile/application surface at all today, so this is a
      feature, not a wiring fix.
- [x] **Presence vs. state — ✅ SOLVED 2026-08-03 by porting `stored`'s contract. No status axis
      was needed at all.**

      The resolution came from `stored`, which had the same document × location problem and
      answers it by keeping **presence truthful** rather than adding state to the namespace:
      a vanished file has its `locations[]` entry **removed**
      (`WorkspaceStoredIndex#reconcileRemovedLocations`), state lives in `locations[].metadata`,
      and the only state-ish bitmap is the degenerate `data/no-location` (cardinality zero).
      There is no `data/backend/<x>/<state>` key anywhere in the codebase.

      Ported: `Application.deriveLocations()` now emits a location **only for installs that are
      actually present** — `PRESENT_INSTALL_STATUSES = {available, unknown}`. `installing` is not
      there yet, `error` failed and is not usable, `missing` is gone; `unknown` is the schema
      default and counts as present-but-unverified, matching stored's carry-forward stance.

      Consequences: `device/id/A` now means "usable on A", the false positive **disappears**, and
      "apps missing on device A" is `{allOf:['data/abstraction/application'], noneOf:['device/id/A']}`
      — plain set algebra on keys that already exist, already supported by the routes. Per-install
      detail stays authoritative in `data.installs` + `locations[].metadata.status`.

      Two designs explicitly rejected: doc-level `data/status/*` (false-positives across devices —
      `{A:available, B:missing}` collapses to one key) and `device/status/<deviceId>/<status>`
      (unnecessary once presence is truthful, and compound state keys risk the
      namespace-is-also-a-key trap documented at index.js:147-159, where a bare parent above its
      own children is invisible to a prefix scan of its own namespace — `data/backend/imap` vs
      `data/backend/imap/<account>` is already that shape).

      Todo keeps its doc-level `data/status/*` facet — its status genuinely is per-document.
      Generalizing `STATUS_FACET_SCHEMAS` → `indexOptions.facetFields` (Phase 3) is orthogonal and
      still worth doing.
- [x] **`device/os/*` and `device/type/*` are now DERIVED — ✅ SHIPPED 2026-08-03.** They were
      written only by the parent's `buildDeviceFeatureTags` from `request.client`, i.e. asserted
      by the writing client *about itself*, which made them provenance ("written from a Windows
      box") rather than the wanted fact ("available on Windows") — and stale forever if a machine
      was reinstalled with another OS.

      Now derived: `#deviceFeaturesFromLocations` resolves each device id through its own
      `data/abstraction/device` document (`#deviceFacets`, a small in-memory Map preloaded in
      `start()` via `#loadDeviceFacets`) and emits `device/os/<os>` + `device/type/<type>`
      alongside `device/id/<x>`. So "all applications available on Windows" is a plain bitmap AND:
      `{allOf:['data/abstraction/application','device/os/windows']}` — the CLI/Tauri-client
      use-case.

      **Drift is closed, not merely accepted.** Deriving into stored bitmaps normally means a
      device reinstalled Windows→Linux leaves stale ticks. `#syncDeviceFacets` (called from
      `#indexDocument`, which every write path already goes through) fires when a Device document's
      os/type changes and repairs the affected set — and `device/id/<x>` names that set *exactly*,
      so the repair is proportional to the documents on that one device, not to the corpus. It
      recomputes per document rather than blanket-swapping keys, because a document may sit on
      several devices and another may still legitimately imply the old facet.

      Normalization mirrors the parent's `device-features.js` (`win32`→`windows`, `darwin`→`mac`)
      in `src/utils/device-facets.js` — synapsd is a standalone package and cannot import it.
      ⚠️ **Keep the two in sync**: a divergence puts a client-asserted tag and a derived tag for
      the same machine into different bitmaps.
- [x] **Two producers reconciled — ✅ SHIPPED 2026-08-03. The rule: `device/*` means PRESENT ON,
      never "written by."**

      Stated by the user 2026-08-03, and it is the project's founding use case: this started
      USB-run / roaming-profile centric, where `deviceId` answers *"which machine did I leave
      customer-foo.xlsx on"*. "Written by obsidian on Windows" is a note-metadata or `tag/*`
      concern — it is not a device fact.

      Making os/type derived (previous item) turned the old client assertion into an active bug:
      the parent asserted `device/os/<writing client's OS>` on every routed write, so an
      application installed only on Linux boxes but added from a Windows laptop answered to
      `device/os/windows`. Permanently — `#removeStaleDeviceMembership` never unticks a tag the
      caller asserted in the same write, so the derivation could not clean it up.

      **Fix (final shape, user-directed 2026-08-03): the server asserts NOTHING on a document's
      behalf, and mandates nothing of consumers.**

      - `device/*` is engine-owned and **fully derived**. A client registers (or maps to) a
        device and indexes a local file as `file://<deviceId>/<path>` (or
        `file://<deviceAlias>/<path>`); `device/id`, `device/os` and `device/type` all fall out
        of that. `enforceClientTags` in both document routes is now a **strip, not a merge** —
        it removes client-supplied `device/*` (which would be indistinguishable from a derived
        value while being immune to cleanup) and injects nothing. `mergeDeviceFeatureTags` is
        deleted.
      - `client/*` is the **consumer's own namespace and entirely optional**. An application MAY
        tag `client/app/firefox`, `client/device/os/windows`, `client/device/platform/*` on
        insert; nothing here mandates, injects or strips it. Precedent: the browser extension
        already opts into `client/app/*` on its own terms
        (`extensions/.../tab-manager.js:146-157`) — no server policy made it do that, and none
        should. Recording provenance is the consumer's call.
      - `buildDeviceFeatureTags` survives for its one legitimate caller,
        `core/device/Registry.js`, which tags a Device DOCUMENT with its own identity —
        self-referential and correct, and what keeps "show me my Windows devices" resolvable.
      - `ENGINE_DEVICE_PREFIXES = ['device/']` replaces the old four-prefix strip list;
        `client/device/id/` is no longer stripped, because it is consumer-owned like the rest of
        `client/*`.

      Tests: `tests/utils/device-features.test.js` (parent, 6 tests) — including that the whole
      `client/*` namespace passes through untouched and that a write with no features stays empty.

      This also **closes the "is client-asserted device/id wrong?" question** raised earlier: yes,
      and it is gone. "Written by obsidian on Windows" is note-metadata or `tag/*`, not a device
      fact.

      **Route coverage gap CLOSED 2026-08-03** (the long-standing asymmetry logged in TODO.md).
      Every write path that accepts a client feature array now strips engine-owned `device/*`:
      `PUT /workspaces/:id/documents` (`workspaces/documents.js:670`),
      `POST /workspaces/:id/dotfiles` (`workspaces/dotfiles.js:130`), and both context dotfile
      routes (`contexts/dotfiles.js:135,:180`), joining the paths that already did. Without this
      a client could smuggle a `device/*` key in through the uncovered routes, where it would sit
      underived and un-untickable.

**Also note:** `normalizeBitmapKey` lowercases and sanitizes, so `device/id/<x>` is not reversible
to the raw `deviceId` when it contained uppercase or chars outside `a-z0-9_-./@:+`. Queries match
because they run through the same normalizer, but resolving a bitmap key back to a `Device`
document (`data.deviceId`, the checksum field — Device.js:13,39) needs a normalized comparison,
not raw equality. Either document that or normalize `deviceId` at registration
(`Registry.#requireDeviceId` currently only trims — `src/core/device/Registry.js:202`).

**Tests:** dotfile/application with N device links tick N `device/id/*` keys; pathless install
ticks presence via `device://`; removing a device from `data.links`/`data.installs` through a
generic `update({data})` unticks (this fails today); status facet composes with presence; a
document with only `stored://` / `https://` locations ticks nothing.

## Phase 3 — schema model v3 (`kind` + registry; **ids stay `data/abstraction/*`**)

### START HERE (written 2026-08-03 at the close of Phase 2b — read before writing code)

Phases 1, 2 and 2b are shipped and committed. Baseline: **synapsd 31 suites / 188 tests green,
parent `tests/core/workspace` 145 + `tests/utils` 18 green.** Run both before and after — the
parent suite is `node --test "tests/**/*.test.js"`, synapsd is `npm test` (jest, `maxWorkers: 1`).

**Scope of this phase, in dependency order.** Do NOT try to land it as one commit:

1. ✅ **SHIPPED 2026-08-03.** Registry: `registerSchema()` + core set, `Message` registered,
   `'BaseDocument'` alias deleted, all core `schemaVersion: '3.0'`, `contact`→`identity`,
   `bucket` deleted, **`event` added** (see below). `tests/schema-registry.test.js` (20),
   `tests/events.test.js` (13).

   Registry entries are now records — `{SchemaClass, tier, kind?, kindField?, kindPrefix?,
   indexOptions?}` — in three tiers: **core** (sealed against re-registration), **app**
   (note/tab/link/dotfile, bundled but registered through the same public path canvas-server
   will use, so the move is a deletion not a rewrite) and **internal** (tree layers).
   `getSchema()` still returns the class, so no caller changed.

   Judgment calls inside `contact`→`identity`, all at 0 documents:
   `data.kind`→`data.type` (a data-level `kind` would shadow the reserved top-level row field),
   `data.identities[]`→`data.identifiers[]` + `addIdentifier`/`removeIdentifier`/
   `primaryIdentifier` (an Identity *has* identifiers; it is not a list of them — and this
   touches `checksumFields`, which is free now and would not be later), and `data.tags` dropped
   from `vectorEmbeddingFields` ahead of the D2 `features[]` move so that move cannot silently
   fork every identity's vector.

### `data/abstraction/event` — SHIPPED 2026-08-03 (use case supplied by the user)

Why it exists, in the user's words: *contextualize mostly-unstructured data.* Focus on
`/work/customer-foo/task-bar` and see everything related to that task; zoom out to
`/work/customer-foo` and every app bound to that context loads the widened set. A calendar app
must therefore surface calendar entries **and** todos **and** alerts **and** whatever activity log
a client app chose to store — through one query against a human-readable context tree.

That is why event is ONE entity with a `type` subtype rather than three entities: calendar, alert
and activity are three lenses on one time-bound set, and a client should not have to union three
corpora by hand.

- **One `events` timeline**, deliberately NOT in `pointTimelines`. Calendar entries have duration;
  a start-only entry on an interval timeline is already stored as an instant, so alerts and
  activity points cost nothing. "Everything time-bound in this context" is one timeline scan, and
  `data/kind/event/calendar` narrows it when a caller wants a single lens.
- **Cross-schema by construction:** `filters: ['t:events:today', 't:tasks:today']` under a context
  path returns events and todos together — the sigil combiner already ORs them. No new machinery;
  the zoom-out is the existing context-tree roll-up. Both are covered by tests.
- `type` is **required, not defaulted** — it drives the kind bitmap, so a silent default mis-files
  documents into the exact query the entity exists to serve. `start` is required for the same
  reason: an event with no position on the timeline is not an event.
- `checksumFields: ['data.title', 'data.start', 'data.type']` — same reasoning as Todo's
  `dueDate`: "Standup" at 09:00 and at 14:00 are different events, and a calendar entry is not the
  alert that shares its title.

**Recurrence — the envelope model (decided 2026-08-03).** Driven by a hard index constraint,
verified by probe rather than assumed: **a document occupies exactly ONE position per timeline.**
The timeline is a BSI keyed `id -> a single value`, so a second `insert(name, id, …)` OVERWRITES
the first — two `timelines[]` entries with the same name silently keep only the last. Expanding a
series into N entries on one document is therefore impossible without changing the index.

Chosen: one document per series, whose timeline entry spans an **envelope** — first occurrence to
`UNTIL`, or open when the rule is unbounded — with `data.recurrence` holding the RRULE verbatim and
the CLIENT expanding it to render occurrences. This is what a CalDAV client already does with
VEVENT+RRULE, so it adds no obligation consumers do not already have.

- The envelope is a deliberate **superset**: a weekly standup answers any day-query inside its span
  until the rule is expanded. Same candidate-set-then-refine contract the engine uses elsewhere; it
  never misses an occurrence, which is the property a bitmap pre-filter must have.
- `COUNT=n` yields an **open** envelope, not a computed last occurrence — resolving COUNT needs
  rule expansion, and a guessed end could stop matching before the real final occurrence. Over-
  matching is recoverable by the client; under-matching is not recoverable by anyone.
- On a recurring event `data.end` remains ONE occurrence's duration and does **not** become the
  envelope end.
- `recurrence` is deliberately NOT a checksum field: editing the rule edits the series, it does not
  fork a new event (CalDAV keeps the same UID). Covered by a test.

Rejected: one document per occurrence (infinite rules need an arbitrary horizon, a year of daily
standups is 365 docs, and "change all future occurrences" becomes a mass update) and extending the
timeline index for multi-position ids (correct, but the largest possible change to the storage
model everything else depends on, and not in this plan).

**Parent wiring (same rev):** `classifier.js` gains `SCHEMAS.event` + `isEvent()`, and events join
notes/todos in `isText()` — they carry inline title/description with no contentType, so without it
they would never reach the embedder. `CLASSIFIER_SURFACE` (hook wizard) and the agent's schema list
list it too.

**Pre-existing bug found and fixed while building it** (`src/index.js`,
`#normalizeDocumentTimelineEntries`): `const rawEnd = entry.end ?? entry.start` collapsed an
explicit `null` into `start`, so **no document could ever declare an ongoing interval** even
though `TimelineIndex.insert` supports one and `tests/timeline-open-intervals.test.js` proves it
via direct `t.insert()` calls. Now `undefined` (absent) ⇒ instant, `null` ⇒ open end. This is what
makes an open incident or an ongoing meeting expressible from a document at all.

**RESOLVED 2026-08-03 — kind-prefix rule: ALWAYS prefix with the entity.** A `kindField` value is
always emitted as `<entity>/<value>`: `application/flatpak`, `identity/person`, `event/calendar`,
`dotfile/folder`. Mechanical, no per-schema judgment call, no collision risk, and the parent
segment is a free roll-up (`data/kind/application` = all applications).

**Enforced in code, not by convention:** `registerSchema` throws if `kindField` is set without
`kindPrefix`. Kind values are persisted in bitmap keys and therefore append-only, so an unprefixed
generic value that later collides with another schema's is not fixable without a migration — the
guard makes that unrepresentable rather than merely discouraged.

⚠️ This supersedes the `{allOf:['data/kind/flatpak','device/id/A']}` example in the facet-family
section below: it is now `data/kind/application/flatpak`.
2. Row shape: `indexOptions` off the row → registry; top-level `kind` + `mime`; `data.relations`
   accepted; root-level `features[]` (D2) with the derived-prefix exclusion and the dropped
   schema unshift.
   - [x] **`kind` — SHIPPED 2026-08-03.** Top-level row field, derived via
     `schemaRegistry.resolveKind()` and stamped in all three write paths (`putMany` after the
     `existing.update(doc)` merge, `#putOne` after parse, `#updateOne` after `update()`).
     Client-supplied values are OVERWRITTEN — a kind the engine did not derive is
     indistinguishable from one it did while being immune to cleanup, the same reasoning that made
     `device/*` a strip rather than a merge. Outside `checksumFields`, so it cannot fork identity.
     Mirrored into HIERARCHICAL `data/kind/*` bitmaps (parent AND child ticked, `data/mime/*`
     precedent) via `kindBitmapKeys()`, folded into `facetBitmapKeys()` so it inherits the existing
     tick/untick stale-diff on every write path for free — an application switching
     `data.type` unticks its old key. `tests/kind-bitmaps.test.js` (8), including the migration
     property (`data/kind/browser/tab` returns exactly what `data/abstraction/tab` returns) and the
     negative drift assertion.
   - [ ] **`mime` — NOT DONE, and possibly should not be.** `data/mime/*` bitmaps already derive
     from `metadata.contentType` with parent+child ticking, so a top-level `mime` field adds no
     query capability — it adds a SECOND home for one value, which is the drift class this refactor
     exists to remove. It is also not free: the parent's `classifier.js` reads
     `doc.metadata.contentType` and falls back to deriving it from `locations[]` filenames, so
     promoting the field is a cross-repo change with no payoff. Recommendation: keep
     `metadata.contentType` as the single source and revisit only if/when `metadata` is split into
     extracted-vs-asserted containers. Decide before closing step 2.
   - [x] **`data.relations` — SHIPPED 2026-08-03.** Accepted, round-trips, and validated at
     ingest (`validateDocumentRelations`, called beside `stampDerivedKind` in all three write
     paths). Validation lives in index.js rather than BaseDocument because the predicate registry
     is an index concern and this is exactly where Phase 4 hooks in. Rejects unknown predicates,
     inverse-style spellings, non-arrays, malformed entries and non-positive/non-integer targets —
     a relation that can never become an edge must not be stored, or the row claims a relationship
     the graph does not have.

     **The load-bearing part is the projection exclusion.** The defaults for `checksumFields`,
     `ftsSearchFields` AND `vectorEmbeddingFields` are all literally `['data']` — the WHOLE data
     object — so without an exclusion, asserting an edge would fork the document's identity,
     pollute its search text and trigger a re-embed. `NON_CONTENT_DATA_KEYS = ['relations']` plus
     `BaseDocument.contentData()` strips it from every whole-`data` projection, returning the SAME
     object reference when there is nothing to strip so existing checksums are byte-identical.
     `tests/data-relations.test.js` (11).
   - [x] **`indexOptions` off the row — SHIPPED 2026-08-03. Measured saving: 414 B per note row,
     43.7% of the row (534 B vs 948 B), ~2.9 GB at 7M rows** — close to the 461 B/3.2 GB estimate
     this plan was written against.

     Resolution moved to a `static indexOptions` on each schema class, NOT to a registry lookup:
     BaseDocument cannot import SchemaRegistry (the registry imports every schema, which import
     BaseDocument — a cycle), but `this.constructor.indexOptions` reaches the subclass's static
     with no import at all. `registerSchema({indexOptions})` writes that same static, so there is
     one source of truth rather than a registry copy that looks authoritative while affecting
     nothing; `getSchemaEntry()` reads through to it.

     **Caller overrides are now impossible, deliberately.** A per-document override would apply on
     write and vanish on read once the field is not persisted — silently different behaviour per
     code path. Dropping caller input also settles the inherited merge-order inconsistency
     (Application/Link/Identity let the caller win; Document/Note/Email/Tab/Todo/File/Dotfile/Device
     spread it first then hard-overrode the field lists, silently discarding a caller's
     `ftsSearchFields`) — with no caller input there is one convention and nothing to get wrong.

     Legacy rows still carrying the field are IGNORED on read, so stale stored config can never
     resurrect; Phase 6's pass drops it from the rows themselves.
     `tests/index-options-off-row.test.js` (8), including that checksums are unchanged by the move.
   - [x] **Pre-existing FTS bug fixed in passing (2026-08-03).** `generateFtsData` did
     `String(value)` on objects, so any object/array FTS field indexed the literal text
     `"[object Object]"` — no searchable content at all. Hits `data/abstraction/document` (which
     declares the default `ftsSearchFields: ['data']`), Identity's `identifiers`/`channels`/`links`
     and Email's `from`/`to`. Now JSON-serialized. ⚠️ **Changes FTS content for those documents —
     existing rows need `reindexSearchIndex()` to pick it up.**
   - [x] **root-level `features[]` (D2) — SHIPPED 2026-08-03.** `metadata.features` → root
     `features[]`, modelled on `comment` line for line: top-level, outside `checksumFields`, own
     `update()` branch outside the `dataUpdated` path. The schema-id unshift is GONE (it injected a
     derived key into an asserted-only array on every construct; the schema bitmap is still ticked
     by the derivation). `documentFeatureKeys()` reads `doc.features`.
     `tests/root-features.test.js` (14) — 11 fail without the change.

     **⚠️ The plan's derived-prefix list was wrong and would have caused silent data loss.** It
     names `data/backend/*`, `data/source/*` and `data/no-location` as derived-and-strippable.
     Nothing derives them: `WorkspaceStoredIndex` asserts backend/source (`:1424-1425`) and the
     orphan lifecycle asserts `data/no-location`. Stripping a key that has no deriver does not make
     it derived, it makes it UNSETTABLE — caught by `orphan-succession.test.js`.
     `DERIVED_FEATURE_PREFIXES` therefore contains only what the engine derives today
     (`data/abstraction/`, `data/mime/`, `data/kind/`, `data/status/`, `feature/`, `device/`), each
     annotated with its deriver. **Add the others in the SAME commit that adds their deriver** —
     `data/source/*` from `locations[].metadata.provider` is still an open Phase 3 item.

     `data/dataset/*` is preserved across an update that omits it (`PRESERVED_FEATURE_PREFIXES`),
     so a client resending its own tags cannot silently drop ingest provenance it never knew about.

     **Update semantics, now explicit and tested both ways:** a **schema-LESS** patch
     (`put({id, features})` or `put({id, data})`) is the feature-only path — it skips the
     re-parse in `#updateOne`, so omitting `features` leaves them alone. A **schema-FUL** put is a
     whole-document REPLACE and clears tags it does not resend. That is pre-existing behaviour
     unchanged by this move (the old `metadata` merge wiped them the same way) and it is the same
     footgun already logged for dotfile `links` — worth fixing globally in its own rev, not here.

     Parent moved with it: `WorkspaceStoredIndex` orphan/re-bind paths now read and write root
     `features`, and the re-bind marker drop moved into `#buildDocument`.
     `updatedAt` still bumps on a feature-only update (sync detection); checksums and embedding
     input provably do not change, so bulk-tagging a gallery cannot re-CLIP it.
3. ✅ **SHIPPED 2026-08-03 — Dotfile identity → `data.url`; schema-scoped checksum dedup.**
   `tests/dotfile-identity.test.js` (14).
   - `normalizeDotfileUrl()` in path-helpers, wired as a zod `.transform()` so EVERY writer gets
     it, not just the CLI: trim, NFC, collapse `//`, drop `./`, strip leading/trailing `/`,
     lowercase scheme + host (fragment left case-sensitive — repo paths are), reject `..` and empty
     entries. The four spellings (`shell/bashrc` · `./shell/bashrc` · `shell//bashrc` ·
     `shell/bashrc/`) now resolve to ONE document.
   - A bare path is accepted and resolved to `workspace:dotfiles#<path>` — clients doing the common
     thing should not have to spell out a URI. External repos work:
     `git+ssh://git@github.com/me/dotfiles#shell/bashrc` is a DISTINCT document from the
     workspace-local entry with the same path, which `repoPath` could not express at all.
   - `checksumFields: ['data.url']`; `conflictsWith()` deleted (dead code).
   - **`links` merge on the checksum-match path**, declared by the schema
     (`static mergeOnDedupe = ['data.links']`) rather than hardcoded, so the engine stays
     schema-agnostic. Incoming keys win, omitted ones survive — a partial POST can no longer
     destroy another device's mapping, and the merge re-derives locations so device presence
     widens with it.
   - **Checksum dedup scoped by schema**, opt-in on the three dedup lookups only. The checksum
     index is global per workspace and carries no schema prefix, so `Link['data.uri']` and
     `Tab['data.url']` (both bare URLs) collided and the incoming doc silently overwrote the
     other's id. Plain lookups (`hasByChecksumString`, routes, stored reconciliation) stay
     cross-schema — there "which doc has these bytes" is the correct question.
   - CLI moved in the same commit (`dot` is the only writer): `lib/docs.js` gained
     `entryPath()`/`toWorkspaceUrl()` and converts at the boundary, so the CLI keeps talking to
     users in repo paths. Routes needed no change — they pass dotfiles through as opaque objects,
     which is exactly why schema-level normalization was the right layer.
4. ✅ **SHIPPED 2026-08-03 — `data/*` facet-family consolidation.**
   - `data/kind/*` hierarchical values — done (step 1/2).
   - `data/source/*` — collapsed into `data/backend/*`, both now derived from `locations[]`.
   - **`data/status/*` generalized to schema-declared `static facetFields`.** The engine no longer
     hardcodes a status axis to todo (`STATUS_FACET_SCHEMAS` is gone); a schema declares
     `facetFields = ['data.status']` and the leaf field name becomes the namespace, so a consumer
     abstraction gets the machinery without an engine change. Engine-owned namespaces
     (`kind`, `mime`, `backend`, `source`, `abstraction`, `dataset`, `no-location`) are REFUSED —
     a schema declaring `data.kind` would write into the derived kind axis where it would be
     indistinguishable from a derived value and immune to that derivation's stale-diff.
   - ⚠️ Closing the generalization needed one more thing, found by the Phase 7 sweep: a schema's
     own facet namespace must also be stripped from asserted `features[]`. It is per-schema, so
     `DERIVED_FEATURE_PREFIXES` (a global list) cannot express it — `facetPrefixesFor()` computes
     it from `static facetFields`. Without it an asserted `data/status/done` would be re-asserted
     on every write and the facet stale-diff could never untick it.

**Hard-won facts from Phases 1–2b — do not rediscover these:**

- **`this.documents.get()` is SYNCHRONOUS** (lmdb-js returns the value, not a promise). Attaching
  `.catch()` throws a TypeError. Worse, several write paths wrap derivation in a broad `catch`,
  so a thrown bug looks exactly like "the logic is wrong". `#indexDocument`'s catch now logs;
  when a derivation mysteriously does nothing, **suspect a swallowed throw before the logic**.
- **Assert on BITMAP MEMBERSHIP, never on `doc.locations` / `doc.metadata`.** `db.get()` rebuilds
  a document through its subclass constructor, so reads re-derive and look correct even when the
  stored row is stale. Only write-time bitmaps expose drift. See `tests/device-presence.test.js`
  `featuresOf()` for the helper shape.
- **Verify every regression test actually fails without its fix** — `git stash push <file>`, run,
  `git stash pop`. My first drift test passed either way and proved nothing. This matters doubly
  in Phase 3, where `features[]` has a known silent-failure mode: a positive-only assertion
  passes even when the untick never fires.
- **PITFALL, will bite `features[]` exactly as it bit the others:** in `putMany`,
  `existing.update(doc)` mutates in place and returns the same instance. `prevFeatureKeys` MUST be
  snapshotted BEFORE that call, beside `prevChecksums`/`prevLocations`/`prevComment`/
  `prevTimelineState`/`prevFacetKeys`.
- **`BaseDocument.deriveLocations()` now exists** (added in Phase 2b) — an overridable hook called
  at the end of `update()`; `Dotfile`/`Application` override it. When Phase 3 moves derivation
  config into the registry, route through this hook rather than adding a second derivation path.
- **Test fixtures:** `Application`'s `superRefine` requires a type-appropriate `data.source` —
  flatpak→`ref`, snap→`name`, appimage→`url`, portable→one of `url`/`repoPath`/`path`; `system`
  and `local` need none. `Dotfile` requires `repoPath` + `type` (`file|folder`). A missing
  `source` fails as a confusing zod error, not an obvious fixture problem.
- **lmdb is pinned to `3.5.6` in BOTH root and synapsd `package.json`** — it is an npm workspace
  member sharing one hoisted copy, so pinning only one forces a second *native* build into the
  process. Pin both or neither.
- **`npm run lint` is broken pre-existing** (ESLint 9 wants a flat `eslint.config.js`; the repo
  has `.eslintrc.json`, so every file reports as ignored). Not caused by v3 work — don't chase it.
- Integration surfaces are concentrated: all four write paths funnel through `#applyMembership`
  (`index.js:~4460`), all reads through `#resolveParsed` (`~2547-2681`). `putMany` ~836-1137,
  `#putOne` ~2145-2210, `#updateOne` ~3237-3332, `#deleteOne` ~3421-3528. Line numbers drifted
  during Phases 1–2b — grep, don't trust them.

**D1 RESOLVED 2026-08-02 — option (c): keep the `data/abstraction/*` id strings.** The L1 model
(kind, runtime registry, `data.relations`, `indexOptions` off the row) lands in full; only the
*id rename* is deferred. Rationale: the rename carried ~272 cross-repo occurrences over five
sibling submodules, a public route path and a shipped config, and delivered **none** of v3's
actual value — the value is in the model, and the model is orthogonal to the strings.

**`kind` is the migration path, not just a field.** Stamping `kind` on documents that keep their
existing ids means consumers can migrate their queries from `data/abstraction/tab` to
`data/kind/browser/tab` incrementally, per submodule, on their own release cadence. When every
consumer reads `kind`, the eventual id consolidation becomes a no-op for them. Do the rename as
its own rev, gated on a coordinated submodule release — not here.

Mapping — **id column unchanged**; the work is the `kind` stamp + registry placement:

```
id (UNCHANGED)                kind          registry     note
data/abstraction/document     —             core
data/abstraction/file         —             core
data/abstraction/message      —             core         REGISTER it (see bugs below); platform enum → data.type
data/abstraction/email        email         core-variant fold Email.js zod into the message email-variant validator
data/abstraction/todo         —             core         (Task.js rename deferred with the id)
data/abstraction/device       —             core
data/abstraction/application  data.type     core         kindField (flatpak, snap, appimage, …)
data/abstraction/identity     data.type     core         kindField (person | organization | service | bot)
data/abstraction/event        event/*       core         kindField+prefix (calendar | alert | activity) — SHIPPED
data/abstraction/note         note          app-level
data/abstraction/tab          browser/tab   app-level    (this row said `browser-tab`; the hierarchical
                                                          kind decision below supersedes it)
data/abstraction/link         link          app-level
data/abstraction/dotfile      dotfile/*     app-level    kindField+prefix (file | folder); stays its OWN
                                                          entity — NOT a file (see below)
```

**Correction 2026-08-02 — `dotfile` is NOT a `file`.** An earlier draft mapped
`dotfile → file kind:dotfile`. That is wrong on two independent counts, both verified:

1. **A dotfile can be a directory.** `Dotfile.data.type` is `z.enum(['file','folder'])`
   (Dotfile.js:40) — `~/.ssh`, `~/.config/nvim` are ordinary, arguably the common case. A folder
   has no bytes and no content checksum, so it cannot be a `file` entity at all.
2. **Identity is a path, not content.** `Dotfile` sets `checksumFields: ['data.repoPath']`
   (Dotfile.js:73) — identity is "which entry in the dotfiles repo", unique per workspace by
   `repoPath`. `File` identity is the **content hash** (`File` deliberately does not set
   `checksumFields`, relying on an external `checksumArray` — File.js:46). Folding them would put
   two incompatible identity rules under one entity, which is exactly the class of mistake
   TODO.md's tab-vs-file analysis rejects for the snapshot case.

What a dotfile actually is: a **mapping** between one repo path and N per-device local paths
(`data.links`), whose payload lives in the dotfiles repo. Neither a file nor a folder-as-tree-node
— the `bucket → DELETED, folders are tree nodes` reasoning does not transfer, because a dotfile
folder is a *synced unit*, not a navigational container. It keeps its own entity and its own
`kind:dotfile`. If a `type` axis is wanted for querying, derive `data/kind/dotfile` plus a facet
from `data.type` (`file|folder`) — same facet machinery as the status work in Phase 2b, not a
second entity.

Consequence for Phase 2b: presence derivation is already directory-safe —
`file://<deviceId>/$HOME/.ssh` parses identically to a file path and ticks `device/id/*` the same
way. No change needed there, but do not "optimize" the derivation on a files-only assumption.

### Dotfile identity — `data.repoPath` is unsafe; replace with a URI (decided 2026-08-02)

Driver: dotfiles must be able to reference **external git repos**, not just the one implicit
workspace repo. `repoPath` cannot express that — and it is already unsafe today, at 0 documents.
Verified problems, all live:

1. **No normalization.** `repoPath` is a bare `z.string().min(1)` (Dotfile.js:38) — no trim, no
   leading-`/` strip, no `//` collapse, no `../` rejection. Only the CLI strips leading slashes
   (`dot/actions/add.js:38`) and the REST body schema validates nothing
   (`routes/workspaces/dotfiles.js:104-114`). Since identity is
   `sha*(JSON.stringify(data.repoPath))`, `shell/bashrc` · `./shell/bashrc` · `shell//bashrc` ·
   `shell/bashrc/` are **four documents for one repo file**.
2. **One implicit repo is a hardcoded invariant**, not a modelled fact:
   `<workspace.rootPath>/git/bare.git` (WorkspaceGitRepo.js), and the CLI can only ever target
   the Canvas server (`dot/lib/paths.js:26-29`). There is **no repo field in the schema at all**,
   so `shell/bashrc` in two different repos is one document the moment external repos land.
3. **Whole-document replacement wipes device links.** On the checksum-match path
   (index.js:914-930) the incoming doc *replaces* the stored one (only `id`/`createdAt`/
   `updatedAt` carry over). The CLI compensates by fetch-and-merge client-side (`add.js:60-63`);
   a direct `POST` with a partial `links` map destroys the other devices' mappings. No
   server-side merge exists.
4. **Rename orphans.** No rename action exists in the 14-action `dot` module; `dot add` to a new
   path creates a new document and strands the old one *with its device links*.
   `migrateDocumentMemberships` (index.js:2336) is wired for File succession only
   (WorkspaceStoredIndex.js:842,939).

**Target shape** — a single normalized URI, `checksumFields: ['data.url']`:

```js
data: {
  url:   'git+ssh://git@github.com/me/dotfiles#shell/bashrc',   // external repo
  //     'workspace:dotfiles#shell/bashrc'                       // the workspace's own repo
  type:  'file' | 'folder',
  links: { '<deviceId>': '$HOME/.bashrc' },
  description?, priority,
}
```

`url` (not `uri`) per TODO.md Decision 1, and consistent with `locations[].url` already carrying
`file://` · `stored://` · `imap://` · `s3://`. One field ⇒ one checksum field ⇒ no composite
field-ordering question; repo namespacing falls out of the scheme+authority.

- **Normalize in a zod `.transform()`**, so every client is covered rather than just the CLI:
  trim, collapse `//` in the fragment, reject `..` traversal, NFC-normalize, lowercase
  scheme+host (leave the path fragment case-sensitive). This is the fix that actually closes
  problem 1 — schema-level, not route-level.
- ⚠️ **Do NOT embed the workspace id** in the workspace-local form. The synapsd DB is already
  per-workspace, so the id adds nothing to uniqueness while making identity break on workspace
  rename/move. `workspace:dotfiles#<path>` is deliberately id-free.
- **Blast radius is the CLI only** (0 documents, web UI unwired): `dot` actions add/list/link/
  remove and `dot/lib/paths.js` `repoFilePath()` (`join(dotfilesDir, repoPath)`) must parse the
  path out of the fragment. Do it in the same commit — `dot` is the only writer.
- Server-side **merge on the checksum-match path** for `links` (problem 3) so a partial POST
  cannot delete another device's mapping. Related: give dotfiles a rename that preserves the id
  (the `PUT` path already migrates checksums correctly at index.js:1011-1015 — nothing just calls
  it), or accept rename = new doc and say so explicitly.
- `Dotfile.conflictsWith()` (Dotfile.js:133-142) is dead code — delete it in the sweep.

**Free consolidations — do these now, they have zero cross-repo cost** (measured 2026-08-02:
`document`, `bucket`, `contact`, `application` have **0** occurrences anywhere outside synapsd,
and TODO.md confirms 0 documents exist for contact/bucket):

- `data/abstraction/contact` → `data/abstraction/identity` (`type: person|organization|service|bot`),
  rename/generalize Contact.js. 0 docs, 0 external references — pure code change.
- `data/abstraction/bucket` → **DELETED** (folders are tree nodes; DirectoryTree covers it).

Everything else keeps its id **and its file** for now. Before folding any *other* id (email→message,
note/tab/link→document, todo→task — but never dotfile→file), run the per-directory occurrence check —
`email` alone has 31 external hits, `tab` 83, `note` 60 — and confirm which land in submodules
that ship independently.

Registry split (`src/schemas/SchemaRegistry.js`):

- Core set hardcoded: document, file, message, email, event, todo, identity, device,
  application — all under their existing `data/abstraction/*` ids, all `schemaVersion: '3.0'`.
- `registerSchema(id, { dataSchema, kind?, indexOptions?, relationsMap? })` runtime
  API for app schemas (note/tab/link/dotfile register from canvas-server;
  ship a `examples/` registration or keep them in a `src/schemas/contrib/` loaded
  explicitly by tests until canvas-server lands its side).
- Delete the `'BaseDocument'` alias (see below). The `data/abstraction/*` ids **stay**.

Row shape changes (`src/schemas/BaseDocument.js`):

- **Remove `indexOptions` from rows** (lines ~78, 156–184). It becomes a property of
  the schema registration; resolution order: registration → core defaults. Ingest
  reads it from the registry, never from the row.
- **Add top-level `kind` and `mime`** (optional strings), stamped at ingest;
  mirrored to `data/kind/<v>` and `data/mime/<type>/<subtype>` bitmaps (prefixes
  already exist? verify in `keys.js`; add if missing).
- Feature auto-injection at BaseDocument.js:198–206 keeps mirroring the schema id
  (unchanged strings — one fewer thing to touch under D1(c)).
- `data.relations` (optional array of `{p, to}`) accepted by the base zod schema;
  excluded from `checksumFields` and embedding fields defaults.
- **Move `metadata.features` → root `features[]`** (D2). Model on `comment`, line for line:
  root zod entry, its own `update()` branch **outside** the `dataUpdated` path, excluded from
  `checksumFields` (a tag edit must never fork dedup or trigger re-embed).
  - `documentFeatureKeys()` (index.js:112) changes `doc?.metadata?.features` → `doc?.features`
    and gains a **derived-prefix exclusion**. It currently ticks derived keys out of an
    asserted-only array — harmless today only because `schema` is the sole derived key in there.
  - **Drop the schema unshift** at BaseDocument.js:198-206 (it unconditionally injects
    `this.schema` into `metadata.features` on every construct; triple-redundant, since the client
    sends it too and `#putOne` re-adds it). Derived keys stay computed: `data/abstraction/*`,
    `data/mime/*`, `data/backend/*`, `data/source/*`, `data/kind/*`, `feature/*`, `device/*`
    are NEVER written into `features[]`. Asserted-only: `tag/*`, `custom/*`, `client/*`.
  - **Preserve `data/dataset/*` across feature-only updates** — ingest provenance must survive a
    client resending the array without the stamp (same preserved bucket as the derived exclusion).
  - Feature-only updates must not untick the embed seen-ledger (else bulk-tagging a gallery
    re-CLIPs it); decide `updatedAt` semantics (bump for sync detection vs. seen-ledger
    interaction); batch path rewrites N docs in ONE txn so a 10k-doc tag is one tx.
  - ⚠️ **PITFALL, cost a cycle on 2026-07-15 and will bite here identically:** in `putMany`,
    `existing.update(doc)` **mutates in place and returns the same instance**. The `prevFeatureKeys`
    snapshot MUST be taken BEFORE that call, alongside the existing
    `prevChecksums`/`prevLocations`/`prevComment`/`prevTimelineState`/`prevFacetKeys`. Compute it
    after and the stale set is silently always empty — the untick never fires and every
    positive-case test still passes.
- **`data/source/*` becomes derivable** (handed over from TODO.md): carry the provider in
  `locations[].metadata.provider` and derive it like `data/backend/*`, instead of stamping it from
  the backend descriptor in `WorkspaceStoredIndex.js:1076`. Without this, `data/source/*` is the
  one bitmap class that cannot be rebuilt from rows — which contradicts the rebuild invariant in
  the architecture recap.
- **Scope checksum dedup by schema** (decided 2026-08-02). Today the checksum carries no schema
  prefix and `getByChecksumString` (index.js:3621) does no schema filtering, while the checksum
  index is global per workspace DB — so any two schemas whose `checksumFields` serialize to the
  same string collide, and the incoming document **silently overwrites the other's id**. Live
  exposure: `Dotfile['data.repoPath']`, `Link['data.uri']`, `Tab['data.url']`,
  `Device['data.deviceId']`. Fix on the **lookup**, not the stored value:

  ```js
  // src/index.js:909-930, the no-id dedup path
  const existing = await this.getByChecksumString(
      parsed.getPrimaryChecksum(),
      { schema: parsed.schema },   // NEW
  );
  ```

  Deliberately NOT prefixing the checksum input with the schema id: that changes every
  document's identity, forcing a full re-dedup — strictly riskier than the sha1→sha256 switch
  TODO.md analysed, and that one was only safe because every algorithm was already indexed.
  Scoping the lookup leaves all stored checksums untouched: no migration, no identity fork.
  ⚠️ Verify the *other* `getByChecksumString` callers first (`Workspace.hasByChecksumString`
  and the stored reconciliation path) — cross-schema matching may be load-bearing for
  blob dedup, where the SAME bytes legitimately arrive under different schemas. If so, make the
  filter opt-in on the dedup path only, not a default on the method.
- **Settle the `indexOptions` merge order** while moving resolution to the registry:
  Bucket/Link/Contact/Application spread caller options LAST (caller wins);
  Document/Note/Email/Tab/Todo/File/Dotfile/Device spread them FIRST then hard-override the field
  lists (**caller's `ftsSearchFields`/`checksumFields` silently discarded**). Two opposite
  conventions for one knob; registry resolution makes the ambiguity unshippable.

Two pre-existing registry bugs this phase inherits and should close in the same commit:

- `Message.js` declares `data/abstraction/message` but is **not registered**
  (SchemaRegistry.js:34-60) — `getSchema()` on it throws today, while the parent's
  `core/workspace/services/chat/index.js:211,294` refers to it. Only 2 external occurrences, so
  registering it is cheap and fixes a live bug independent of any fold.
- `document` is registered at two versions: `BaseDocument.js:19` says `2.2`, `abstractions/
  Document.js:7` says `2.0` and is what the registry returns — docs are stamped 2.0 while
  validating against the 2.2 zod shape. Setting all core schemas to `'3.0'` fixes it by
  construction; note it so the fix is deliberate rather than accidental.
- `'BaseDocument'` alias exists at SchemaRegistry.js:38, commented "used in tests and older code" —
  confirm which tests before deleting.

**Tests:** registry resolves every core id (still `data/abstraction/*`); registerSchema round-trip
incl. indexOptions resolution; kind/mime stamped and bitmap-mirrored; `data/kind/<v>` queries
return the same set as the equivalent `data/abstraction/<x>` feature query (this is the property
that lets consumers migrate incrementally); checksum stability when only `data.relations` changes;
`contact` and `bucket` ids are gone.

**Tests (dotfile identity + checksum scoping):** the four un-normalized `repoPath` spellings all
resolve to ONE document via the URI transform; `..` traversal is rejected; a workspace-local and
an external-repo dotfile with the same path fragment are DISTINCT documents; a folder dotfile
round-trips (no content checksum required); a partial `POST` does not delete another device's
`links` entry; two schemas whose checksumFields serialize identically no longer collide (assert
the pre-fix behaviour is gone — a Dotfile and a Link with the same string keep separate ids).

**Tests (D2 / `features[]`):** checksum and embedding stability when ONLY `features[]` changes (the
`comment` precedent test is the template); a construct no longer injects the schema id into
`features[]`; derived keys supplied by a client in `features[]` are ignored, not ticked;
`data/dataset/*` survives a client re-put that omits it; a feature-only update does not untick the
embed seen-ledger; `putMany` unticks stale feature keys (the prev-snapshot-ordering regression —
assert the NEGATIVE case, a positive-only test passes even when the untick never fires).

✅ **Test-port cost under D1(c): near zero.** The 24-of-29 suites referencing `data/abstraction/*`
ids keep working untouched — that entire cost was the rename's, and it is deferred with it. New
tests are additive (kind, registry, relations).

### The `data/*` facet family — consolidate while `kind` is being added (raised 2026-08-03)

Phase 3 introduces `data/kind/*` into a namespace that already has several derived facets. Take
one pass over the whole family rather than bolting a new prefix beside the old ones:

```
data/abstraction/<schema>     schema id            (kept under D1(c); the kind axis supersedes it for queries)
data/kind/<v>                 NEW in Phase 3
data/mime/<type>[/<subtype>]  metadata.contentType (parent + child both ticked — deliberate roll-up)
data/backend/<name>           locations[]
data/source/<provider>        backend descriptor   (Phase 3 moves it to locations[].metadata.provider)
data/status/<status>          data.status          (gated to todo only)
data/dataset/<name>           ingest provenance    (SELECTION semantics, not constraint — see TODO.md)
data/no-location              zero locations       (orphan marker; keep in data/ for delete protection)
```

- **A `data/type/*` prefix is probably NOT needed — `kind` already is that axis.** Several schemas
  carry a `data.type` discriminator that is exactly a subtype-of-entity: application
  (`appimage|flatpak|snap|portable|system|local`), identity (`person|organization|service|bot`),
  the new event (`calendar|alert|activity`), dotfile (`file|folder`). Rather than a second
  prefix, let `registerSchema` name the field — `kindField: 'data.type'` — so
  `data/kind/flatpak` falls out of the existing derivation. "All flatpaks on device A" then
  becomes `{allOf:['data/kind/flatpak','device/id/A']}` with no new machinery.
  **DECIDED 2026-08-03: `data/kind/*` values are HIERARCHICAL** — `data/kind/browser/tab`,
  `data/kind/dotfile/folder`, `data/kind/dotfile/file`. Note this is hierarchy in the *value*, not
  schema-scoping (`browser` is not a schema — a tab's entity is `document`). Follows
  `data/mime/*` precedent exactly, and for the same reason: the taxonomy really is hierarchical,
  so the parent segment is a meaningful query on its own.

  Implementation is the existing `mimeBitmapKeys` shape — **tick parent AND child**
  (`data/kind/browser` *and* `data/kind/browser/tab`), which buys roll-up queries for free:
  "everything browser-ish" is one key, no enumeration of children. Single-segment kinds
  (`note`, `link`) are fine; they simply never have children. Cheap: one extra tick per level.

  ⚠️ One caveat inherited from mime, worth knowing rather than avoiding: `listBitmaps(prefix)`
  range-scans `prefix + '/' .. prefix + '/￿'`, so a bare `data/kind/browser` key is **invisible to
  a prefix listing of its own namespace** — list `data/kind/` instead. This is safe here precisely
  because the parent is ALWAYS ticked (deliberate roll-up), unlike the genuinely broken
  namespace-is-also-a-key case documented at index.js:147-159. Key-based queries (AND/OR/ANDNOT)
  are unaffected; only prefix *enumeration* is.

  Values stay append-only — they are persisted in bitmap keys.
- **`data/source/*` COLLAPSED into `data/backend/*` — DECIDED AND SHIPPED 2026-08-03.**
  `tests/backend-features.test.js` (9); 6 fail without the derivation.

  Both were ASSERTED by the parent from the backend descriptor, so neither was rebuildable from
  rows — the plan flagged that for `source` and missed that `backend` had the identical problem.
  Both are now DERIVED by synapsd from `locations[]`, and `data/source/*` is deleted: once both
  derive from the same field they are two projections of one fact, and the provider is a property
  of the backend, not of the document.

  **The boundary is the point** (user, 2026-08-03): storage logic in synapsd leaks one module's
  responsibility into another. synapsd knows nothing about `stored`, S3 or IMAP — it parses a URL
  into scheme + authority exactly as it already does for `file://<deviceId>`, via the existing
  `parseLocationUrl()`. `stored://` is just another URL scheme.

  Key shape: **hierarchical `data/backend/<scheme>` + `data/backend/<scheme>/<authority>`**, tick
  parent AND child (the `data/mime/*` / `data/kind/*` contract). "Everything from IMAP" is one key;
  `data/backend/imap/<account>` is preserved exactly as it was. Same prefix-listing caveat as the
  other hierarchical axes — list `data/backend/`, not `data/backend/imap`.

  - `file://` and `device://` derive NO backend key: `device/*` already answers "where do these
    bytes live" for device-local copies, and a second answer would be redundant. Easy to add later
    if a case appears.
  - **Device-anchored mounts are still attributed**, via `location.metadata.backend` (which
    `WorkspaceStoredIndex` already writes at `:1515`). Their bytes are addressed as
    `file://<deviceId>/…` so the URL cannot carry the backend — this is the "supplied by the
    client" escape hatch for anything a URL cannot express, and it stays generic (a
    location-metadata key, not a `stored` concept).
  - **Stale-diff generalized**: `#removeStaleDeviceMembership` → `#removeStaleLocationMembership`,
    driven by `#locationDerivedFeatures()` (device + backend in ONE place) so the diff can never
    cover one axis and silently miss another. Moving a document between backends now unticks the
    old key — it had no stale-diff at all while it was asserted.
  - Parent stops asserting entirely: `WorkspaceStoredIndex#buildFeatures` is DELETED along with the
    `data/backend/home` / `data/backend/data` short aliases (zero consumers), and the imap service
    no longer pushes `data/backend/imap/<account>` — its messages already carry an
    `imap://<account>/<folder>;UID=<n>` provenance location, so the derived key is identical.
  - ⚠️ Key change for existing rows: `data/backend/workspace:home` → `data/backend/stored/workspace:home`.
    Needs a reindex; pre-prod only.
- **`data/status/*` may only ever serve todo.** Application status stopped being a bitmap in
  Phase 2b (truthful presence replaced it), so `STATUS_FACET_SCHEMAS` has exactly one member. If
  no second customer appears, fold it into the generalized `indexOptions.facetFields` rather than
  keeping a bespoke status axis.

## Multi-position timeline indexing — WANTED, not yet supported (raised 2026-08-03)

**The requirement (user, 2026-08-03):** a document must be indexable at N positions on one
timeline. A note may reference N other events and we want it indexed at each of them on a
`wikipedia` / `content` timeline. The one-position limit "should not be a blocker" — it is
acceptable for `crud:*` (a document is created once) but wrong for content axes.

**What the index does today.** One document occupies ONE position per timeline: the tier is a BSI
keyed `id -> a single value` (plus a parallel `end` BSI), so a second `insert(name, id, …)`
overwrites the first.

**Why this was urgent rather than merely missing — it failed SILENTLY, and invisibly.** Probed
2026-08-03 with a note declaring three Roman eras on a `wikipedia` timeline: the row stored all
three entries and `db.get()` re-rendered all three, so a read looked perfectly correct — while the
index held only the last. The Republic query returned nothing; the other two matched only because
they overlapped the surviving interval. This is the same "reads re-derive and look correct while
stored state is stale" trap documented in the Phase 3 START HERE notes, and it would have
corrupted the wikipedia import with no visible symptom.

**Landed now (guard, not capability):** `#normalizeDocumentTimelineEntries` THROWS on duplicate
timeline names in one document, naming the timeline and pointing at the workarounds. Deletion is
deliberately exempt — `#removeDocumentTimelines` now collects names directly instead of going
through the normalizer, so a row written before the guard (or by a future multi-position writer)
can still be cleaned up. `tests/timeline-multi-position.test.js` (5).

Supported today: **one document per position**, or **a distinct timeline name per axis** (a note
can be on `wikipedia` AND `content` simultaneously — both covered by tests).

### DECIDED 2026-08-03 — timeline coverings (S2-shaped), deferred to its own rev

**Not a blocker for the v3 refactor; revisit fresh after Phase 3.** Design settled now so the
decision does not get re-derived.

**The BSI cannot be ticked twice, and extending it is not the small change it appears to be.** A
bit-sliced index encodes exactly one number per id: the slice bitmaps *are* the binary digits of
the value, so "the same id in two places" is unrepresentable by construction, not by policy.

**Chosen shape: reuse the `GeoIndex` covering pattern for time.** The engine already ships this
exact structure in one dimension over — S2 region coverings, where a region becomes a set of
hierarchical cells, a document ticks every cell it covers, and the query is a union over covering
cells, under the shipped contract that *"coverings are inclusive (may slightly overshoot the
region) — precise containment is the renderer's job"* (GeoIndex.js). `SCALES`
(`Gyr, Myr, Kyr, year, month, day, second, ms, ns`) is already the hierarchy time needs.

Rationale beyond convenience (user, 2026-08-03): spatial and temporal representation sharing one
underlying structure is the point, not a shortcut — it mirrors the place/grid-cell literature on
projecting data into low-dimensional structures, where recall is generative at its core. One
covering primitive serving both axes is the design goal.

- **Declarative side needs NO new field.** `timelines[]` already accepts N entries — the guard
  above simply throws today. Ancient Egypt is three `{timeline:'wikipedia', start, end}` entries on
  one article; the guard's throw becomes support. JSON declarative, bitmaps derived, rebuild
  invariant intact.
- **Derived side:** `internal/ts/<timeline>/cover/<scale>/<bucket>` roaring bitmaps. Each range
  ticks the coarsest buckets containing it plus finer boundary buckets — the S2 covering algorithm
  in 1-D. Query = union of buckets overlapping the range, refined against the row's actual ranges
  when exactness is needed.
- **Why it stays cheap:** bucket-key count is bounded by *timespan ÷ granularity*, NOT by document
  count. All of human history at year scale is ~5k keys total, shared across every article; deep
  time rides the Kyr/Myr/Gyr tiers. Ancient Egypt ticks a few Kyr buckets plus boundary years, not
  3,000 year buckets.
- **The BSI stays** for what coverings cannot do: exact `getSortKeys` values, `histogram`, and
  every existing point/`crud:*` timeline. Coverings become the membership structure; the BSI
  remains the value structure.
- Sizing: a new derived index (~`EdgeIndex` scale) plus a reindexer. L3 by construction —
  droppable, rebuildable from `timelines[]` — so it slots into `rebuild --plane l3`. Does not touch
  Phase 3's row-shape surface.

**⚠️ OPEN, decide before building:** boundary precision. If an article says "Old Kingdom,
2686–2181 BC", must a query for exactly 2181 BC match, or is year-level overshoot acceptable? This
decides whether coverings need finer boundary refinement or can stop at the containing bucket —
far cheaper to settle up front than to retrofit.

Rejected alternatives: occurrence sub-ids (synthetic id per position + `occurrenceId <-> docId`
mapping — least invasive but adds an id space, a translation step on every timeline query, and
occurrence cleanup on delete) and a time-bucketed dupsort index in the `EdgeIndex` shape (natural
multi-position, but re-implements range querying that coverings get from plain bitmap unions).

Also confirmed already-supported for the wikipedia case, do not rebuild: the wipeable dataset
(`deleteDataset(name, {dropDocuments})`, `index.js:1946`, plus `data/dataset/*` provenance) and
layered zeitgeist queries (`RANGE_MODES` includes `layers`/`grouped`; `#queryIntervalLayers`
returns `{name: {scale: [ids]}}` per timeline, so `wikipedia,personal` against a birthdate works
today).

This does **not** reopen the Event recurrence decision: the envelope model was chosen because it
matches how CalDAV clients already consume VEVENT+RRULE, which stands regardless of how many
positions the index can hold.

## Consumer-registered abstractions — the generic-engine goal (raised 2026-08-03)

**Requirement (user):** consumers register their own data abstractions by extending BaseDocument or
a core schema, with their own fts/vector fields declared **per abstraction schema, never per
write**, and the base schema's mandatory fields always enforced. Example: a
`data/abstraction/phone` extending `Device` with `ftsSearchFields: ['data.maker',
'data.hwRelease']`.

⚠️ **Do not confuse this with the superseded "Decision 2".** What v3 killed is *bitmap
ancestor-chain ticking* — a tab ticking `data/abstraction/link` so "all links finds tabs"; `kind`
replaced that. CLASS extension for validation and index-option inheritance is a different thing and
is very much wanted.

**Already works today, verified 2026-08-03** (`tests/schema-registry.test.js`, 4 tests):

- A subclass declaring `static indexOptions` gets its own fts/vector/checksum fields — JS static
  inheritance resolves through the prototype chain, and BaseDocument reads it via
  `this.constructor`, so there is no registry import and therefore no import cycle.
- A subclass declaring none inherits its parent's.
- Base mandatory fields stay enforced (a `Phone` without `data.deviceId` throws) — a consumer
  cannot opt out of its parent's contract by registering.
- `registerSchema()` accepts it; `instanceof BaseDocument` is the guard.

**Gaps, in the order they matter:**

1. **No parent-aware data-schema helper.** `Phone.dataSchema` inherits `Device.dataSchema`
   unchanged, so a consumer's OWN fields are accepted (passthrough) but never *validated*.
   `BaseDocument.extendDataSchema()` builds a fresh wrapper rather than extending the PARENT's data
   shape, so there is no one-liner for "Device's payload plus these fields". Fixing it needs care:
   `Document.dataSchema.shape.data` is a `z.record`, not a `z.object`, so a naive `.merge()` breaks
   for every schema currently calling `Document.extendDataSchema`. Add a separate explicit helper
   rather than changing that one.
2. **No registration ROUTE.** Registration is in-process JS only. A real consumer-facing API means
   an HTTP surface in the parent, which raises questions this plan has not answered: how is a
   *class* transmitted (it cannot be — so a declarative descriptor compiled server-side into a
   zod schema + index options), persistence of registrations across restarts, per-user vs
   per-workspace scoping, and what happens to stored documents when a consumer re-registers a
   schema with different `checksumFields` (identity churn).
3. **`kindField`/`kindPrefix` are already exposed** on `registerSchema`, so a consumer abstraction
   gets the `data/kind/*` axis for free.

Sequencing: (1) is small and can ride any later Phase 3 commit. (2) is its own rev — it is an API
design problem more than an engine one, and the descriptor-vs-class question should be settled
before any code.

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

✅ **SHIPPED 2026-08-03.** `tests/relations-derivation.test.js` (12); 8 fail without it.

- `#syncDocumentRelations(docId, prev, next)` runs inside the caller's transaction beside the
  bitmap/timeline writes, in all three write paths. Delete already called `edges.deleteNode(id)`
  (landed in Phase 2).
- **Provenance is what keeps the two planes from fighting.** Asserted edges are OWNED by the row —
  dropping an entry drops the edge — but a DERIVED edge between the same pair is not the client's
  to delete. `edge().meta.src === 'doc'` (the synthesized value when no meta row exists) is the
  discriminator; both directions are tested, including a derived edge on the SAME predicate.
- ⚠️ `prevRelations` is snapshotted BEFORE `existing.update(doc)` in `putMany` and before
  `storedDocument.update()` in `#updateOne` — the same in-place-mutation trap as
  `prevFeatureKeys`/`prevFacetKeys`. Taken after, the diff is always empty and the stale edge is
  never removed, while every positive assertion still passes. There is a test asserting the
  negative case through the batch path specifically.
- Dangling targets are allowed and logged at debug (forbidding them would make ingest ORDER
  significant); `#documentExistsSync` is used for the probe — `documents.get()` is SYNCHRONOUS.

### Recipients — deferred, not rejected (user steer 2026-08-03)

Email is the richest identity source in the corpus, and `authored-by` only covers `From`. `To`/`Cc`
→ identity is wanted **eventually**; it is deferred because the *role* is distinct from authorship
and has nowhere clean to live yet: it cannot go in edge meta without colliding with the
asserted-edge convention (asserted ⇒ no meta row), so it needs either its own predicate ids or a
role field that survives that convention. Deferring costs nothing — ids are append-only and
`data.to`/`data.cc` stay ordinary fields until the reverse query ("everything sent to Alice") is
actually built. Unlike `depicts`/`authored-by`, there is no conflation risk in waiting: nothing is
being written under a wrong predicate in the meantime.

**Also parked, and the more interesting half:** *"each selected identity might become a bitmap
eventually."* That is a real alternative to the Phase 5 rel-bucket, not a restatement of it. Phase 5
materializes an adjacency scan into an **ephemeral** bitmap per query; a **persistent**
`identity/id/<x>` bitmap — derived exactly like `device/id/*` — would instead put frequently-queried
identities directly into the `paths ∩ features ∩ filters` pipeline with no scan at all. The tradeoff
is unbounded key cardinality (one bitmap per identity vs. a handful of devices), which is why
"selected" is the load-bearing word: promote only pinned/starred identities, keep the long tail on
edges. Decide when there is a real corpus to measure — do NOT build it speculatively in v3.

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

**QuerySession interaction — do not skip.** `src/session/QuerySession.js` (432 lines, not
previously mentioned in this plan) caches each cue's operand from `db.resolveCandidates()` and
invalidates it by watching the bitmap keys that cue touched (`membership.changed`). A `rel`
operand has **no stable bitmap key** — it is an ephemeral bitmap built from a dupsort scan, so a
`link()`/`unlink()` fires no membership event and the cached operand goes stale silently. Mark rel
operands **coarse** (re-resolve on read), exactly as TODO.md's invalidation section already
specifies for temporal / glob / regexp operands. Cheapest correct version: have
`resolveCandidates` report rel-derived operands as unkeyed so the existing coarse path picks them
up — no new machinery.

✅ **SHIPPED 2026-08-03.** `tests/rel-queries.test.js` (10); 8 fail without it.

- `parseRel()` in `spec.js` normalizes `{p, of, dir?, op?}` (or an array) into the same sigil trio
  as features; `#combineRelFilters` lifts each adjacency scan into an ephemeral bitmap and reuses
  the EXISTING `#combineSigilFilters` algebra, so rel composes with paths/features/filters with no
  new pipeline.
- **Marked `coarse`**, exactly as the plan required: a rel operand is built from a dupsort scan and
  has no stable bitmap key, so `link()`/`unlink()` fire no membership event a QuerySession could
  intersect. Tested directly (`resolveCandidates().coarse === true`) and behaviourally (a cached
  cue re-resolves after a pure `edges.link()` with no bitmap tick anywhere).
- ⚠️ **Predicates are validated at PARSE time, not scan time.** `#combineSigilFilters` catches
  operand errors and yields an empty bitmap, so an unknown or inverse-style predicate
  (`mentioned-by`) would have SILENTLY widened the result set instead of failing. Caught by the
  malformed-spec test — `parseRel` now calls `predicateId()` up front.
- One hop only; multi-hop traversal stays parked.

## Phase 6 — migration + rebuild command

✅ **SHIPPED 2026-08-03.** `scripts/migrate-v3.js` + `db.rebuildL3()`; `tests/migrate-v3.test.js`
(10) — all 10 fail without it. Verified end-to-end against a real seeded database, not only in
tests: dry-run → apply → re-run, then the migrated rows inspected directly.

- **Version gate reuses the existing one** as planned: `SCHEMA_VERSION` 1 → 2, hung off the same
  `internal/schemaVersion` branch in `start()`. `#migrateEmbedBitmapKeys()` is folded into the
  versioned scheme but keeps its POSITION — VectorIndex latches its presence bitmap key at
  construction, so it cannot move down into the migration block.
- **A stale DB REFUSES to open** without `{migrate:true}` (or the script). A full-table rewrite is
  an operator action, not something a server restart does implicitly. ⚠️ Exception: an EMPTY
  database is stamped and opened normally — otherwise a fresh install, or the demo instance that
  resets hourly, would deadlock on a migration with nothing to migrate.
- Row pass: drops `indexOptions`, moves `metadata.features` → root `features[]` (stripping derived,
  keeping tag/custom/client/dataset), stamps `kind`, migrates dotfile `repoPath` → normalized
  `url`. **Reverse scan** recovers asserted tags that existed ONLY in bitmaps (pre-2026-07-15
  rows), read once before the row pass and folded in as it goes.
- Drops + re-derives `rel/*`, `data/source/*`, `data/backend/*` (flat → `<scheme>/<authority>`) and
  `data/kind/*`. Under D1(c) NO document changes its schema id, so the ~2600 tabs are never
  re-keyed — the risk that decision bought out.
- **Idempotent by construction**: every step makes the row match what current code would produce.
  Re-running is a no-op (asserted, plus the second open reports `lastMigrationStats === null`).
- `rebuildL3({edges, bitmaps, timelines, search, embeddings, src})` **composes the existing
  reindexers** rather than paralleling them, and shares `#replayDerivedPlane()` with the migration
  — so the rebuild invariant is exercised by the same code that migrates. Two tests assert it
  literally: drop the derived plane, rebuild from rows, get the same sets back; and `edges.clear()`
  followed by a rebuild restores every asserted edge.

**Still owed by whoever runs this on real data** (both are content changes, not structure, so the
migration deliberately does not force them):
- `reindexSearchIndex({rebuild:true})` — the FTS `[object Object]` fix changes indexed content for
  `data/abstraction/document`, Identity `identifiers`/`channels`/`links`, and Email `from`/`to`.
- `reindexEmbeddings()` only if the Identity `data.tags` embedding-field drop matters (0 documents).



`scripts/migrate-v3.js` (or extend existing scripts/):

1. Env version gate — **reuse the existing one, do not invent `internal/version`.** There already
   is a versioned migration hook: `SCHEMA_VERSION = 1` / `SCHEMA_VERSION_KEY =
   'internal/schemaVersion'` (src/index.js:63-64), read in `start()` at :562-568, which dispatches
   `#migrateBitmapKeys()` (:4139) when the stored value is stale and then writes the current
   version back. Bump `SCHEMA_VERSION` to 2 and hang the v3 migration off that same branch; refuse
   the open without `--migrate` there. (The marker lives in the `internal` dataset, :314 — this
   plan's earlier citation of src/index.js:235–247 was wrong, that range is private field
   declarations. Note also the separate *unversioned* `#migrateEmbedBitmapKeys()` at :1197,
   invoked at :532 — fold it into the versioned scheme while you are here.)
2. Single pass over `documents`. **Under D1(c) this is no longer a schema rewrite** — `doc.schema`
   is untouched for every id except `contact`→`identity` (0 docs) and `bucket` (0 docs), so in
   practice **no document changes its schema id at all**. What the pass actually does: stamp
   `kind`/`mime` (registry-driven detection), move any schema-specific edge-ish fields into
   `data.relations` (email attachments if modeled, tab→offline-file derivations — audit per
   schema), drop `indexOptions`, and **move `metadata.features` → root `features[]`** (D2),
   stripping derived keys on the way (the schema id, and any `data/mime|backend|source/*` that
   leaked in) while preserving `tag/*`, `custom/*`, `client/*` and `data/dataset/*`. The array
   needs no schema-id *remapping* — the ids didn't move — only removal of the injected copy.
   Note this pass is what makes the whole rev worth a migration at all: `indexOptions` alone is
   ~3.2 GB of byte-identical config at 7M rows.
2b. **Reverse scan for asserted features** (D2, per TODO.md's migration note): for each `tag/*` and
   `custom/*` bitmap, walk its ids and append the key to each doc's `features[]`. Required because
   docs written *before* the 2026-07-15 interim fix have tags that exist ONLY in bitmaps with no
   doc-side record — they are the last state with no rebuild source, which is the entire point of
   the move. Run it in the same pass as step 2 (read the bitmap → doc id map once). After this,
   feature bitmaps are derived state forever: rebuildable and droppable.
3. Drop all `rel/` bitmap keys. (No feature bitmaps to drop — the schema ids are unchanged, which
   is precisely the risk D1(c) bought out: the ~2600 tabs, the one document class with no rebuild
   source outside the DB per TODO.md, are never rewritten.)
4. Replay ingest derivation: edges from `data.relations`; kind/mime bitmaps;
   (checksums/timeline/embeddings untouched — ids stable).
5. `synapsd rebuild --plane l3 [--src <s>]` subcommand: `removeEdges({src})`/drop derived
   structures + re-run ingest derivation. Even a minimal version (edges + kind/mime
   only) locks in the rebuild invariant mechanically. **Compose the existing reindexers, do not
   parallel them** — `reindexCrudTimelines` (:4707), `reindexMimeBitmaps` (:4759),
   `reindexSearchIndex` (:4814), `reindexEmbeddings` (:4854) already exist as methods, and
   `scripts/reindex-crud.js` is the CLI precedent to copy. `rebuild --plane l3` should be the
   umbrella that calls them plus the two new derivations, not a fifth mechanism.

**Tests:** migrate a fixture v2 env (build one in tests/fixtures via the old code
path pinned as JSON rows) → assert schema ids **unchanged**, kind stamped, edges derived, absent
`rel/` keys, absent `indexOptions`; idempotency (running migrate twice = no-op).

## Phase 7 — docs & sweep

- Update README/TODO architecture sections; move the L0–L3 spec into `docs/`.
- Grep sweep: `indexOptions`, `rel/`, `Bucket`, `'BaseDocument'`, `Contact`, `repoPath`,
  `conflictsWith` must return zero hits in `src/` (tests may reference fixtures).
- ⚠️ **`data/abstraction` is NOT part of the sweep** — under D1(c) those strings are load-bearing
  and must stay. The sweep target for the deferred rename rev is instead: every `data/abstraction/*`
  read in the five sibling submodules has moved to a `data/kind/*` query. Track that as the
  rename rev's entry criterion.

## Sequencing & risk notes

- Phases 1–2 are independent of 3–4 and land first (edge primitive is
  self-contained; bitmap-relations deletion is low-blast-radius — predicate surface
  is tiny today).
- Phase 2b (device presence) is independent of everything else and needs no migration beyond a
  reindex — its first two items are a live correctness bug and an unexposed capability, so it can
  jump the queue whenever devices matter. It touches `#deviceFeaturesFromLocations` and the two
  schemas' `#buildLocations`, none of which Phases 1–6 go near.
- Phase 3 is still the largest commit, and 4 and 5 depend on it — but **D1(c) took the "big bang"
  out of it**. It is now additive to BaseDocument + a registry rewrite, with no id migration, no
  cross-repo coordination and no test-suite port. Keep 3+4 in one PR so the repo never has
  `data.relations` rows without edge derivation.
- Watch: `src/index.js` is 4.9k lines, but the surface is concentrated — all four write paths
  funnel through `#applyMembership` (:4407) and all reads through `#resolveParsed` (:2547-2681).
  `putMany` :836-1137, `#putOne` :2098-2201, `#updateOne` :3207-3318, `#deleteOne` :3421-3528.
  Everything else is additive files. (The Phase 1 backend change is zero lines — already verified.)
- **D1 and D2 are both resolved (2026-08-02) — no open decisions remain.** Phase 3 is executable
  as written. D2 grew Phase 3 (the `features[]` move, `data/source/*` derivation, indexOptions
  merge order) but did **not** grow Phase 6: its full-table pass was already required to drop
  `indexOptions`, so `features[]` rides along in the same scan. The one genuinely new migration
  work is the reverse scan (step 2b) for pre-2026-07-15 tags that exist only in bitmaps.

## Deferred to its own rev — the `data/entity/*` rename

Not cancelled; sequenced behind consumer migration. Entry criterion: the five sibling submodules
read `data/kind/*` rather than `data/abstraction/*`. Carries with it: `todo`→`task` (Task.js
rename), `email`→`message kind:email` (fold Email.js), `note`/`tab`/`link`→`document` + kind,
the `/data/abstraction/:abstraction` route path, the embedd router + shipped config, and the
24-of-29 test-suite port. **`dotfile` does NOT fold into `file`** — it stays its own entity
(`data/entity/dotfile`) for the identity and file-vs-folder reasons in Phase 3.

## Non-goals (explicitly out)

Version chains / same-path-new-checksum successor migration (reconciliation design
owns it); `rel/has/*` coarse bitmaps; multi-hop traversal; MDB_DUPFIXED packing;
token-string sugar for the rel bucket; any back-compat shims **inside the DB** (D1(c) keeps ids
stable so no shim is needed — that is not the same as adding one).
