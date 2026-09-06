# TODO

Only open engine work belongs here. The current API and landed design live in
`README.md`.

Support mixed virtual trees - moving the mount feature to the top of the list

Use-case: 
- Mirror a backend directory 1:1 to a context tree
- Mount foreign workspace paths into Universe
  - Fan-out queries across multiple workspaces

## Trees and membership

- [ ] Design context/directory subtree mountpoints:
  - same tree type only;
  - origin-path resolution;
  - lock lifecycle;
  - cycle rejection;
  - bounded nested mounts;
  - writes through a mount target the origin.
- [ ] Enforce locks for move, remove, delete, and rename.
- [ ] Define root-layer behavior instead of adding another decorative layer
      class.
- [ ] Finish label-layer semantics or remove the unused type.
- [ ] Extract shared document-target membership operations once mount work makes
      the duplication concrete.

## Full git repo schema support

Design decided 2026-09-06, implementation deferred until real-world use kicks
in. The question was whether GitHub repos and branches should be "mere links";
the answer is: index the WORKFLOW SPINE (repo, branch, PR, ticket) as thin
documents, and leave commits, trees and blobs to git.

Motivating case: `ctx:/ops/infra/jira-1234` holds files, notes, tabs, mail and
chat for one ticket; the actual work lives on two branches
(`jira-1234/user-int-fix-…` → PR against `int`, `jira-1234/user-main-fix-…` →
cherry-picked PR against `main`). An agent bound to that context must see the
ticket, both branches and both PRs through plain membership, with no repo-wide
noise, and must NOT need git history in the index to do its job.

### Tier 1 — repo: one document, remote and local together

- `data/schema/git/repo`. Identity = sha256 of the canonical remote URL (same
  upsert convention as the connectors). Filed in the backends tree next to the
  repo's issues (`/github/<address>/<owner>/<repo>`).
- Local clones are extra `locations[]` entries (`file://<deviceId>/path`) on
  the SAME row. `device/id/*` and `data/backend/file` then already answer
  "which box has a checkout" (see docs/FEATURE_AXES.md).
- Forks and mirrors group via a derived feature `git/root/<root-commit-sha>`
  (`git rev-list --max-parents=0`), never by sharing identity — a fork is a
  different repo that happens to share history.
- A local-only repo with no remote uses its root commit as provenance until a
  remote appears; the row is then re-keyed once (cheap: it is one document).

### Tier 2 — branches and PRs: first-class but thin

They are the objects an agent actually picks up; they have lifetimes, owners
and a parent ticket, none of which a `data/schema/link` row can express.

- `data/schema/git/branch`: `name`, `base`, `headSha`, `state`
  (`active|merged|deleted`), `lastCommitAt`, `cloneUrl`. Identity = the ref
  URL; `headSha` is mutable data (connector `remoteUpdatedAt` pattern).
- PR as `data/schema/task/pull-request` (a Task SUBTYPE, decided): "anything
  pending under ops/infra" then includes open PRs for free and `data/status/*`
  applies. Cost: plain task queries include PRs. Accepted; revisit only if it
  bites. The github driver already has PR objects in hand
  (`issue.pull_request`) and throws them away — extend it rather than adding a
  second driver.
- Both carry an open interval on a `git` timeline (created → merged/deleted,
  else `ongoing`), so "what was in flight on ops/infra in March" is a zeitgeist
  query over the existing open-interval sidecar.
- Filed in the backends tree under the repo
  (`…/<owner>/<repo>/branches/<name>`, `…/pulls/<n>`); repo membership is tree
  placement, NOT an edge.

### Tier 3 — commits, trees, blobs: NOT indexed

They churn on every push, git already is a content-addressed index, and the
context never asks about them. Reference by sha in plain fields
(`data.commits`, `headSha`); agent tools run `git log` / `git show` against the
checkout on demand. If code SEARCH is wanted, mount the working tree as a
directory backend via the existing folder rules — that indexes files, not
history.

### Edges

- branch / PR `implements` → Task (jira-1234 or the GH issue). NEW predicate
  (id 9), deliberately not `references`: "the ticket this branch is the work
  for" and "a casual mention of the ticket" are answers to different questions,
  same reasoning as `member-of` vs `references` in predicates.js.
- main-PR `derived-from` → int-PR expresses the cherry-pick; that predicate
  already carries exactly this meaning (provenance).
- `authored-by` → Identity on both, reusing the identity plane.
- Base branch stays a plain field (`data.base`); if "all open branches against
  int" becomes a real query, add a derived feature `git/base/<name>`, not an
  edge.

### Context placement (the control-plane part)

A storage rule, same machinery as the folder rules: when a branch or PR whose
name/body carries a ticket key lands, link it to every context path that
already holds the Task with that key. Everything else is membership. To do
work an agent reads the branch row, finds the local clone in the repo's
`locations[]`, and adds a worktree.

### What stays a plain Link

A repo with no connector configured, or a random GitHub URL in a tab. Promotion
to a repo document happens when someone attaches a connector or a local clone.

- [ ] `implements` predicate (id 9) in `src/indexes/edges/predicates.js`
- [ ] `data/schema/git/repo`, `data/schema/git/branch`,
      `data/schema/task/pull-request` schemas + `git/root/*` derived axis
- [ ] `git` timeline registration (open intervals)
- [ ] canvas-server: extend github driver with branches + PRs; ticket-key
      placement rule; local-clone registration (client side)

## Replication/sync

- Currently tracked in canvas-server/canvas-edge

## Event payload contract

Landed (see README, "Events"): the `reason` discriminator on every document
event, the `changed` membership delta, `document.linked.batch` /
`document.unlinked.batch`, and the dev-mode envelope assertion. Pinned in
`tests/event-payload-contract.test.js`.

- [ ] **Drop the membership-only `document.updated` / `document.removed`
      aliases and their payload keys** (`memberships`, `contextArray`,
      `directoryArray`, `featureArray`) in the next MAJOR. Everything that
      blocked this is done: the first-class family now covers bulk ops, and the
      known consumers were migrated 2026-08-18 (canvas-server hook fan-out +
      embed queue, apps/web workspace and context pages, browser-extension
      socket client and document cache). Re-run the consumer survey before
      cutting — anything binding `document.updated` for a *content* change must
      keep working; only the membership emission goes.

## Semantic anchors

Inferd produces model output and codebook assignments. SynapsD only stores and
combines model/version-namespaced anchor membership. Settled: the wire format
decouples from storage — producers emit normalized 64-bit S2-shaped IDs (or
anchor paths) and whether SynapsD resolves them via a BSI range or an internal
context-tree layer stays an implementation detail behind the filter token.

- [ ] Benchmark the producer before choosing storage.
- [ ] Decide the cardinality contract first. A point BSI stores one value per
      document, while useful inputs will probably emit several anchors. Reusing
      `GeoIndex` without solving that mismatch would quietly recreate the
      multi-position timeline problem.
- [ ] Compare:
  - model-keyed anchor bitmaps or quantizer bands;
  - occurrence indirection plus a sortable 64-bit code (continuous widening via
    range queries, but high-D → 2-D locality is provably lossy (JL bound) —
    adjacency at a fixed level is partly fake; the codebook does the real work,
    not the curve);
  - engine-owned semantic dimension trees with ancestor widening (graded recall
    via ancestor ticking, backoff = parent-path cue swap, atomic v1→v2 tree
    rebuild; discrete taxonomy, no continuous neighborhoods).
- [ ] Treat S2/Hilbert as a storage encoding candidate, not evidence that a
      high-dimensional semantic manifold became two-dimensional without loss.
- [ ] Add an `anchor:` filter family. `geo:` remains physical GPS. Cell IDs are
      64-bit unsigned — parse as BigInt/hex in filter tokens, no float precision
      loss.
- [ ] Add model-keyed presence/seen ledgers and APIs to store, clear, inspect,
      and query anchors.
- [ ] Preserve the L3 invariant: anchor indexes are disposable and reproducible
      from documents plus a versioned external codebook.
- [ ] Support side-by-side model spaces and atomic active-space switching.

## QuerySession

- [ ] Exclude `internal/gc/deleted` in the session-wide combination so a
      literal ID-only cue cannot retain tombstones.
- [ ] Mark requested but nonexistent tree paths coarse. A path created later
      must invalidate and populate an already-open live session.
- [ ] Add a pure bitmap soft-overlap combinator if inferd/agentd measurements
      justify it. Keep clocks and decay outside the engine.
- [ ] Do not add weighted semantic scores here until their normalization across
      spaces is specified.

## Timelines

Design and current behaviour live in README ("Timelines and intervals"): the
tiled `{c,a}` membership plane, the per-entry adaptive floor, the open-interval
sidecar, and Event recurrence expansion all landed (3.7.0–3.9.0, 2026-08-16 to
2026-08-18).

Rationale worth keeping, because it guards decisions that could be re-litigated:

- **Rejected — occurrence-ID indirection.** Packed `occId = (docId << k) |
  ordinal` is neat arithmetic but throws on legitimate fan-out (a meta-analysis
  citing 50 studies) and spends doc-id bits, the scarce currency; the
  BSI-translation-table variant resurrects allocation/GC bookkeeping. The
  per-occurrence chronological listing it uniquely enabled has no product
  surface — if one appears it can be added alongside tiling, derived from the
  same `timelines[]`.
- **Rejected — bitmasking several values into one BSI word:** destroys the
  slice-comparison algebra that makes range queries work.
- **Rejected — literal ±∞ tiles.** Tiles match by key identity; overlap with
  `[s, +∞)` is the one-sided test `s <= query.end`, which no identity match can
  encode. Hence the BSI sidecar.
- **Rejected — any per-timeline granularity config.** One timeline carries
  geological eras, lifespans and single events at once, so a floor set by
  anyone is wrong for two of the three; and a constructor option made rebuild
  output config-dependent, breaking L3 purity.
- **App boundary:** engine multi-position covers *positions of this document*.
  Entity-worthy occurrences get promoted by the app to their own documents with
  edges to the source.

- [ ] Batch timeline rebuilds before Wikipedia-scale ingestion (see also "Scale
      and operations"). Coverings written under the retired fixed-quantum era
      re-derive at entry precision through a rebuild, so the migration is
      folded into this item — do it before the 7M-doc wiki run.
- [ ] Optional later: an `exact` opt-in flag (row refinement below the entry
      floor) — possible without a format change; and hour/minute tiers to
      legalize sub-day floors for dense calendar corpora (today they clamp to
      `day`).

## Schemas

- [ ] Point web consumers at the published JSON Schema endpoint and delete
      copied schema enums. Consumer work lives in Canvas.
- [ ] Design remote schema registration only when a real consumer needs it.
      Resolve persistence, scope, and checksum-identity changes first.
- [ ] Reduce app-specific bundled schemas as consumers take ownership.

## Query and write semantics

- [ ] Implement or remove recognized `g:` and `re:` filter syntax.
- [ ] Settle raw bitmap filter sigil consistency.
- [ ] Decide whether `list()` should stop returning runtime errors as an empty
      array with `.error`.
- [ ] Revisit replace-versus-patch writes as a dedicated API change.
- [ ] Add explicit result shaping for IDs, metadata, and full documents.
- [ ] Split `src/index.js`; start with maintenance/rebuild code and pure
      derivation helpers. Preserve the write and candidate-resolution choke
      points.

## Scale and operations

- [ ] Batch `rebuildL3()` bitmap replay. The current per-document loop is not
      viable at million-row scale.
- [ ] Add dump/import or snapshot/restore using LMDB's consistent copy.
- [ ] Add threshold-gated LMDB compaction based on reclaimable bytes.
- [ ] Audit batch methods for actual backend batch operations.
- [ ] Bound the BitmapIndex cache before Wikipedia-scale ingestion.

## Relations

- [ ] Add email recipient roles when reverse recipient queries are needed.
- [ ] Measure before adding per-identity bitmaps.
- [ ] Add coarse relation-presence bitmaps only with a measured query need.
- [ ] Keep traversal one-hop until a concrete multi-hop workload exists.
