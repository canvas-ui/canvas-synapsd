# TODO: Multimodal search → live sensory sessions (search-by-image → sensord)

Supersedes the design half of `src/services/synapsd/TODO.hilbert.md` (keep that file as the
original conversation reference). Fine-tuned 2026-08-09 against the actual codebase state.

## Verified ground truth (what already exists)

The plan builds almost entirely on shipped machinery:

- **QuerySession** — `synapsd/src/session/QuerySession.js`, `db.openSession(specs, opts)`.
  `mode: 'live'`, `emit: 'delta'` → `{ added, removed, count }`, `patch(label, partialSpec)`,
  coarse-dependency re-resolution, debounced recompute off `membership.changed`. The
  "patch a cue per camera tick" loop needs zero core changes.
- **S2 GeoIndex** — `synapsd/src/indexes/inverted/GeoIndex.js`, level 21, `nodes2ts`, single
  64-bit BSI at `internal/geo/s2`, containment = BETWEEN over `[rangeMin, rangeMax]`. Filter
  tokens `geo:bbox:` / `geo:near:` / `geo:cell:` — **reserved for real GPS**; semantic anchors
  get their own `anchor:` namespace (decided).
- **Vector space namespacing + ledger** — `internal/embed/vectors|seen/<space>/<modelSlug>`,
  `getUnembeddedDocIds(space, schemas)`, `storeDocumentEmbeddings(...)`, skip-still-marks-seen.
  This is the template for anchor ledgers and zero-downtime model migration.
- **Module pattern to copy** — `TimelineIndex` / `GeoIndex`: constructor takes only
  `bitmapIndex`, owns lazily-created BSIs, fully L3-rebuildable (`rebuildL3()` invariant).
- **embedd** — `src/services/embedd/`, in-process, DI'd into synapsd via
  `Workspace.js #doStart()` → `new Db({ semantic: { embedQuery, spaces, ... } })`.
  Providers: onnx (text), **clip/siglip (joint text+image, local, forked worker)**, ollama,
  openai (supports images). `BASELINE_SPACES.image` = siglip@768, exact scan
  (`annIndex: false`), `imageMaxDistance` + `searchWeights` already plumbed to the UI.
- **Byte intake** — `POST /workspaces/:id/blobs` (raw octet-stream, streamed), multipart
  registered in transports.

What does NOT exist: any anchor code (no `anchor` identifier in synapsd src), any
sensord/streams/camera code, any image-query path (`Embedd.embedQueryForWorkspace` is
text-only; `POST /embedd/test` echoes `modality:'image'` but never exercises it).

## Settled design decisions

1. **synapsd never sees bytes or models.** The DI seam (`semantic.embedQuery`) already
   enforces this for text; image queries inject a sibling the same way. Inference (embedd
   today, sensord later) produces vectors / anchor IDs; synapsd stores, namespaces, intersects.
2. **v1 manifold source is the existing SigLIP joint space, not Gemma-4 hidden states.**
   SigLIP is contrastively trained (alignment is real, today, local); hidden-state extraction
   from a generative multimodal model is a research bet (see Research track). The per-model
   space prefix lets both live side by side later.
3. **`geo:` stays physical.** Semantic coordinates use `anchor:` (e.g. `anchor:cell:`,
   `anchor:path:`) whatever the storage representation turns out to be.
4. **Wire format decouples from storage.** sensord emits normalized 64-bit S2-shaped IDs (or
   anchor paths) over IPC; whether synapsd resolves them via a BSI range or an internal
   context-tree layer is an implementation detail behind the filter token.
5. **sensord ≈ the planned `streams` service** (`TODO.md:504`) — cameras are one feed type;
   journalctl / mail / slack feeds ride the same abstraction (windowed sampling, sliding
   retention, trigger/emit). Each consumer = one QuerySession. Camera is the showcase, not
   the architecture.
6. **Search-by-video = client-side frame extraction over search-by-image.** 1–2 FPS, each
   frame is a stateless image query; temporal smoothing (3–5 frame sliding window: vector
   averaging pre-query, or doc-ID majority vote post-query) lives in the client for v1.
   The client loop IS v0 of sensord; when sensord lands, the loop moves server-side and
   swaps `POST /search` for a session cue patch.

## Slice A — search-by-image (SHIPPED 2026-08-09)

- [x] `Embedd.embedImageQuery(wsId, bytes, contentType, space = 'image')` next to
      `embedQueryForWorkspace`, routed through `provider.embedImage([bytes], rule,
      { contentTypes: [ct] })` — clip and openai implement it; ollama throws (folded into
      the error envelope at the Workspace layer); onnx is text-only.
- [x] **Vector-in path won**: `db.searchByVector(queryVector, spec, opts)` — synapsd's
      contract stays "vectors in, never bytes". Scope (paths/features/filters/**ids**)
      resolves via resolveCandidates and pushes down into the Lance scan; results best-first
      in kNN order; `excludeIds` (self-match), `withDistances` (→ `.debug.distances`),
      `idsOnly`, non-positive maxDistance = no floor. Plus `db.getDocumentVector(docId,
      space)` (new `VectorIndex.getDocVector`) so "more like this" never moves a vector
      across the API.
- [x] `Workspace.searchByImage({ imageBytes | similarTo, spec, ... })` — embeds via embedd
      (ephemeral, never indexed) or reuses the stored vector; canvas-spec composition and
      normalization applied like the other search entry points.
- [x] Transport: **`POST /workspaces/:id/search/image`** (dedicated route, not folded into
      compound lines yet): `image` (base64 or data URI, 32 MB cap) or `similarTo`, full
      context/feature/filter scope (default `scope:'workspace'` — photos live in backend
      mirrors), `debug` lifts distances. Compound-line image terms deferred until needed.
- [x] `POST /embedd/test` now actually exercises `modality:'image'` (1×1 PNG probe;
      text-only providers fail the test instead of false-passing).
- [x] Tests: `synapsd/tests/search-by-vector.test.js` (5), `tests/services/embedd/
      image-query.test.js` (2). synapsd 383/383, canvas-server 473/473.
- [ ] Verify calibration with real query images (image→image distances run much tighter
      than text→image — the 0.945 text-calibrated floor is loose for frame queries; no
      implicit floor is applied on this path, clients pass maxDistance).

## Slice A′ — typed match + fused multimodal search (SHIPPED 2026-08-09)

Closes the "image hits photos, not notes" gap for queries that carry text, and generalizes
the search API per the keep-the-seam decision: synapsd ranks (never sees base64), embedd
makes vectors (never ranks), search surface takes {text?, image?} → embedd → vector legs →
synapsd.

- [x] **Typed match descriptor in synapsd**: `rank()`/`search()`/`query()` accept
      `{ text?, vectors?: [{space, vector, weight?, minDistance?, maxDistance?}] }`
      (string = classic path). Legs RRF-fuse with the built-in fts/dense/text→image legs
      in every mode (hybrid, vector, and fts — explicit legs are never discarded);
      legs-only match ranks pure-dense (single leg keeps exact kNN order); offline leg
      space degrades to empty contribution, dim mismatch throws.
- [x] **Fused mode end-to-end**: `Workspace.searchByImage({..., text })` builds the
      descriptor; `POST /workspaces/:id/search/image` gains optional `q`. Image+text query
      now returns notes AND photos in one RRF page. (Fused mode can't exclude the
      similarTo self-match — RRF has no excludeIds; known, documented.)
- [x] Tests: synapsd `search-by-vector.test.js` grew to 8 (legs-only, fusion, fts+legs,
      validation/degradation); full suite green in the STANDALONE repo
      (`~/Code/canvas/canvas-synapsd`, 381/381 after the workspace-translation test
      relocated to canvas-server).
- [ ] Remaining from the build order: live lens session (thin QuerySession wrapper over
      `ids` + `set()` — Slice E), audio (CLAP + new space), frame→text second leg.

### metadata.summary — reserved generated-content field (RAILS SHIPPED 2026-08-09)
The indexing rails for captioner output are in place; only the PRODUCER is missing:

- [x] `metadata.summary` reserved for generated content (`comment` stays human-only) —
      lives under metadata (deriver territory, like EXIF), so writing it never touches
      checksums: no dedup fork, no identity change. `doc.hasSummary` getter.
- [x] Auto-FTS: `generateFtsData()` folds it in like the comment; a summary-only
      metadata patch triggers the Lance FTS reindex (prevSummary in isContentChanged).
- [x] Auto-embed: `SUMMARY_CHUNK_ID = -2` reserved text-space chunk (beside comment's
      -1), batched in one embedText call (`#embedAuxChunks`); Workspace.resolveEmbeddingInput
      passes `summary` on every return shape. A captioned photo is dense- AND
      lexically-searchable by its description; the summary write → document.updated →
      re-embed cascade is automatic.
- [ ] Producer: the captioner loop. NEEDS DECISIONS — model/runtime (ollama vision chat?
      transformers pipeline? openai-compatible VLM endpoint?), and where it lives
      (embedd's queue/reconcile infra fits; ledger must key on PRIMARY CHECKSUM, not
      updatedAt, or caption→update→recaption loops). Provenance: stamp
      `metadata.summaryMeta = { model, generatedAt }` so re-captioning on model change
      is a query.

### Service topology — embedd → inferd, the general inference service
DECIDED + RENAME SHIPPED 2026-08-09: `canvas-inferd` (name `neurald` rejected — it
previously belonged to the agent service, now agentd; no npm package was ever published,
so the rename was pure in-repo mechanics). First vision model: **qwen-vl**.

Rename scope: `src/services/inferd/` (git mv, history intact), class `Inferd`, package
`canvas-inferd`, route files, tests dir, all in-repo identifiers. WIRE-COMPAT PRESERVED
deliberately until the webui migration lands: REST prefixes `/rest/v2/embedd` +
`/workspaces/:id/embedd`, env vars `CANVAS_EMBEDD_*`, `config/embedd.json`,
`workspace.json services.embedd`, ConfigStore name 'embedd', model-cache dir
`<home>/embedd/models`. Follow-up: alias-then-rename the wire surface post-webui-migration.

Rationale (kept for the record):
- One loaded VLM (gemma4 / qwen-vl) serves BOTH `describe` (captions → metadata.summary)
  and the experimental `extract` (hidden states → anchors). Two services = double load.
- embedd already owns the hard plumbing a captioner needs: ProviderPool, 4-layer config,
  SSRF endpoint guard, fork/worker isolation, queue + checksum-keyed reconcile ledger.
- sensord stays a pure STREAM ORCHESTRATOR (feeds, sampling, scene-change, sessions,
  hysteresis, deltas) — no weights, no native deps; calls the inference service. Boxes
  without GPU still run log/mail feeds; camera lights up when a vision provider exists.
- Capability model: providers declare embedText/embedImage (today) + describe (captioner)
  + extract (later). Routing rules widen from "mime → space" to "mime → capability chain"
  (image ⇒ embed@image + describe@summary; summary then auto-embeds via the -2 chunk —
  the frame→text leg becomes configuration).
- Queue needs a PRIORITY LANE before sensord becomes a caller (live frame > background
  caption sweep > reindex) — build into the rename, not after.
- Timing: rename BEFORE the packages/embedd filter-repo extraction (still unchecked in
  TODO.monorepo-migration) so the package extracts once under its final name.

### Frame→text leg — two candidate designs (build order #4, pick later)
- **Captioner** (original plan): a small VLM capability in embedd/sensord (ollama vision
  `/api/chat`, or a transformers pipeline) captions the frame → caption becomes a text leg.
  NOTE: CLIP/SigLIP canNOT do this — they embed, they don't describe; the openai provider's
  `messages` mode targets embedding servers, not chat. Captioning is NEW capability.
- **SigLIP text bridge** (cheaper, no VLM): at ingest, embed each note's title/snippet
  through SigLIP's TEXT encoder into the image space as a second presence (~64-token limit).
  Then an image query's kNN in image space hits notes directly. No captioning, no new
  runtime; costs one extra short-text vector per doc. Worth benchmarking FIRST.

## Slice B — search-by-video "Lens" (SHIPPED 2026-08-09, webui unblocked)

The webui landed in the monorepo (`~/Code/canvas/canvas/apps/web`); the camera app is in.

- [x] **Lens applet** (`src/components/toolbox/applets/LensApplet.tsx`, registered in the
      applet registry beside Notes/Todos → toolbox Apps tab + standalone `/apps/lens`,
      bindable to a workspace path via the host's binding bar — a bound path pre-scopes
      the search, `scope:'path'`): getUserMedia (`hooks/useWebcam`) → JPEG frame grab
      (≤640px, q0.72) at 0.5/1/2 FPS → `POST /documents/search/image` via `services/lens.ts`
      (ephemeral frames) → thumbnail/icon grid underneath. Optional text input = fused mode
      (notes surface next to photos); `maxDistance` input + per-hit `d=…` chips (debug
      distances) for live floor calibration.
- [x] Majority-vote smoothing over the last 3 responses (incl. sticky-out re-adoption) —
      no flicker on motion blur. Chained timeouts (frames never pile up), AbortController.
- [x] Server unblock: `Permissions-Policy` was `camera=()` — now `(self)` for
      camera/mic/geo (the SPA uses all three).
- [x] Webui naming change: embedd → inferd sweep (files git mv'd, identifiers, API paths
      now on the new canonical `/rest/v2/inferd` + `/:id/inferd`; server keeps `/embedd`
      aliases at both levels + admin `/embedd/{status,pause,resume}` aliases).
      `CANVAS_EMBEDD_*` env names preserved in user-facing strings.
- [x] Summary-generation controls: workspace settings → Embeddings → "Summaries" fold —
      per-modality (image live, audio/text declared but marked planned) enable +
      provider + model, persisted via the validated `summarize` config block
      (server: normalizeSummarize + key-wise layer merge; UI types updated).
- [ ] Optional server nicety: accept a small batch of frames in one search call (amortize
      HTTP + let the server average vectors).

## Slice B″ — Lens as a standard FILTER (SHIPPED 2026-08-10)

Lens joined Features / Timeline / Map as a fourth toolbox filter tab (webui
`panels/LensTab.tsx`; `ToolboxFilters.lens` state, deliberately EPHEMERAL — stripped from
isDirty/session/canvas persistence, a saved view must not replay yesterday's position or a
long-gone frame). Three refine sources:

- [x] **Refine with GPS**: `watchPosition` → 4dp-rounded fix + radius knob (25 m–10 km) →
      `geo:near:<lat>,<lon>,<r>m` token folded into tbScopeFilters. Jitter-safe (rounding
      + re-commit only on movement).
- [x] **Refine with camera** and **Refine with desktop recording**: same frame loop
      (`useWebcam` grew `startScreen()` via getDisplayMedia + onEnded teardown when the
      user stops sharing from browser UI) → search-by-image `idsOnly` at 1 FPS →
      majority-vote smoothing → smoothed survivors committed as `filters.lens.ids`.
- [x] Transport: `ids` exposed on GET /documents (repeatable param) + POST /search body →
      spec.ids (Slice B½ operand); web services (`getWorkspaceDocuments` / canvas / layer
      variants) gained `ids` option; workspace page folds lens into tbScopeFilters,
      tbFiltersKey, all three fetch paths incl. live canvas preview.
- [ ] Context pages: the contexts documents route has no `ids` param yet — GPS refine
      works there (filters), camera/desktop refine is workspace-pages-only for now.

### Inferd multi-feed direction (user note 2026-08-10, deep dive pending)
Lens-style refinement will want MULTIPLE feed types from inferd, not just vectors:
generated summaries (gemma4) fed into the database as QUERY ANCHORS — i.e. the summary
text itself becomes a query-side leg/anchor, not only an indexed field. Ties into the
anchor codebook (Slice C/D) and the describe capability; park until the captioner lands.

## Slice C — anchor layer in synapsd (representation intentionally open)

Two candidate representations, both fed by the same codebook output; benchmark before
committing (this is where the research bet lives, keep the seam clean):

- **BSI route** (TODO.hilbert.md): `internal/anchor/<space>/<modelSlug>` 64-bit BSI, cell
  neighborhoods = range queries. Pro: continuous widening, Hilbert-adjacent-ish. Con:
  high-D → 2-D locality is provably lossy (JL bound); adjacency at a fixed level is partly
  fake — what does the real work is the codebook, not the curve.
- **Internal context-tree route** (`synapsd/TODO.md` "Semantic dimension trees" — noted:
  never a committed plan, just an option): hierarchical codebook = engine-owned locked tree,
  anchors as layers, graded recall free via ancestor ticking, backoff = parent-path cue swap,
  atomic v1→v2 tree rebuild. Pro: synapsd-native, user-browsable semantic tree. Con: discrete
  taxonomy, no continuous neighborhoods.

Either way:
- [ ] `anchor:` filter-token family registered in `synapsd/src/utils/filters.js`.
- [ ] Anchor seen-ledger cloned from the embed ledger (`internal/anchor/seen/...`,
      `getUnanchoredDocIds`, skip-marks-seen), per `<space>/<modelSlug>` for side-by-side
      model migration with final prefix swap.
- [ ] L3 invariant holds: drop anchors, rebuild from L1 + codebook, identical index.

## Slice D — reverse alignment (codebook / map-maker)

- [ ] Background loop (Workspace-owned, same shape as embedd reconcile): walk the
      unanchored ledger → fetch existing SigLIP/text vectors from Lance (no re-inference
      needed for already-embedded docs!) → hierarchical k-means (or product quantization) →
      assign anchor IDs → `storeDocumentAnchors`.
- [ ] Codebook is a per-`<space>/<modelSlug>` artifact, versioned; retrain = new space,
      old space queryable throughout, prefix-swap at 100 %.
- [ ] Evaluate: does camera-frame → anchor → bitmap-intersect return the same docs as
      camera-frame → kNN? (Slice A gives us the kNN baseline to measure against.)

## Slice E — sensord / streams service skeleton

- [ ] Separate service (shape per `TODO.md:504`): feed abstraction — `camera`, `journalctl`,
      `mail`, ... — windowed sampling, sliding retention, per-feed cadence.
- [ ] Inference worker off-main-thread (reuse embedd's clip fork pattern); projection to
      anchor IDs happens **inside the worker** — only uint64 arrays cross the boundary.
- [ ] Per-feed live QuerySession: `session.patch('live-viewport', { filters: ['anchor:...'] })`,
      delta fan-out over the existing websocket channels (note: WS is currently event-only,
      no search RPC — session delta push is new but natural surface).
- [ ] Agent consumers: ephemeral sessions with their own baseSpec = context perimeter.

## Slice B½ — id-set operand in QuerySession (SHIPPED 2026-08-09)

The general mechanism for external producers (kNN results, sensord emissions, agent-curated
working sets) to participate in the session bitmap algebra. Lets video go server-side live
BEFORE anchors exist: frame → embedImageQuery → kNN ids → cue set → delta over WS. Anchors
(Slice C) then optimize the producer, they are not a prerequisite for the demo.

- [x] Spec bucket `ids: number[]` in `parseSpec` (`src/utils/spec.js`): uint32 array;
      `[]` = deliberately-empty constraint; absent = unconstrained. Works in db.list() too.
- [x] `#resolveParsed` (`src/index.js`): `bitmap.andInPlace(new RoaringBitmap32(ids))`,
      `constrained = true`, **no collectionKeys, NOT coarse** — a literal set has zero index
      dependency, so live mode never re-resolves it on writes (cheaper than geo/timeline cues).
- [x] `QuerySession.set(label, spec)` — replace-mode upsert sibling of `patch()` (which
      concats arrays by design, for refinement; a streaming producer patching `ids`/`filters`
      per tick would accumulate forever — latent bug in the original Gemini blueprint too).
- [x] Serialization: free (ids ride the spec JSON). Frozen mode: nothing to freeze.
- [x] Tests in `tests/query-session.test.js` (4 new; suite 378/378 green).
- [ ] Decide: session-wide `andNot(internal/gc/deleted)` in `#combine()` — an id-set cue has
      no keys so deletes never dirty it; excluding tombstones session-wide fixes it generally.
      (Deferred: with any other cue present, deletes fall out via that cue's untick; a session
      whose ONLY cue is an id-set can briefly reference a tombstone — materialize skips it.)
- [ ] Ranking note: bitmap = membership only; ranked display comes from the producer's kNN
      order or `materialize(match)` over the combined set (gate first, rank survivors once).

## Research track (parallel, non-blocking)

- Gemma-4 (E2B/E4B) hidden-state extraction as an alternative manifold provider — runtime
  candidates: llama.cpp (mmproj vision) via node-llama-cpp, onnxruntime-node. Open questions:
  pooling strategy, layer choice, whether per-workspace codebook alignment rescues
  non-contrastive states.
- Low-dimensional attractor / toroidal target manifolds (grid-cell style) instead of the S2
  sphere; thousand-brains framing: many concurrent sessions as voting columns. The multi-thread
  reasoning work (spawnable recall/summarisation/evaluation threads) plugs in here.
- Corrections to the reference convo: `roaring-4w` doesn't exist (we use `roaring` via
  synapsd), `s2-geometry` → we use `nodes2ts`.

## Open questions

- Vector-in vs embedImageQuery-DI at the synapsd boundary (Slice A; lean vector-in).
- Batch-frame endpoint worth it, or is 1 req/frame at 2 FPS fine? (Measure first.)
- sensord naming: `sensord` vs `streams` — one service, pick at Slice E.
