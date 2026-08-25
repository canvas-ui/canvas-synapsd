<p align="center">
  <img src="https://raw.githubusercontent.com/canvas-ai/.github/main/banners/canvas-banner_1200x480.jpg" alt="Canvas" width="100%" />
</p>

# SynapsD

A small KV database built on top of `LMDB`, with `roaring-bitmap` and `LanceDB` indexes in-the-mix, purpose-built to index the inflow of unstructured data in an almost ordinary Universe. Synapsd exports virtual bitmap-powered FS-like trees on top of your data - store a JSON document once, then place it in as many views as you need: a project tree, a tag, a timeline, a map, a dataset. Each appearance costs bitmap bits, not copies. Every filter below narrows the same candidate set, so they combine freely in one query.

SynapsD indexes metadata and structure. It does not store blob bytes, and it does not run an embedding model. Point `locations[]` at wherever the bytes live. Push vectors in from your own embedder, or skip that stack and everything falls back to full-text.

## Highlights

- **[Context trees](#trees)** - virtual, filesystem-like trees over your data. A path is a logical AND of the layers along it: `ctx:/work/customer-foo/project-bar/task-baz` is "everything linked to all four", and shortening the path *widens* the result. One document can live in many trees; placement is cheap and reversible.
- **[Bitmap-powered search](#the-query-spec)** - membership, tags, facets, mime types, device presence and schema identity are roaring bitmaps, so "files in `/work/customer-foo`, tagged `finance`, not in staging" is a set intersection. Counts, existence checks and live standing views come off the bitmaps without loading a single document.
- **[Multi-timeline support](#timelines-and-intervals)** - any number of named time axes per document, from nanoseconds to gigayears on one grammar: "updated today", "due this week", "Roman Empire, 27 BCE–476 CE", open-ended "still alive" intervals, and [zeitgeist queries](#the-zeitgeist-of-a-birthday) (`grouped` by source, `layers` by scale) that answer "what does this date mean across wikipedia AND my life" in one call.
- **[Vector search](#semantic-search-vectors)** - BM25 full-text and dense-vector kNN fused with RRF, running only on documents that already survived the structural filter. SynapsD stores and namespaces vectors but owns no model: a three-call contract fills the spaces, and without an embedder everything degrades to FTS.
- **[Datasets](#datasets)** - named ingest partitions (`data/dataset/wikipedia`, `data/dataset/personal`) you toggle in and out of *every* query like lenses, and drop wholesale without touching your own documents.
- **[Typed edges](#relations-and-edges)** - a directed document graph (`mentions`, `replies-to`, `authored-by`, …) that composes into the same pipeline: "everything mentioning Alice, in this context, tagged important" is a one-hop scan ANDed into the candidate bitmap.
- **[Spatial index](#spatial-index-s2)** - "photos in this map viewport", "everything within 500 m of me" as a single range query over S2 cells.
- **[Schemas that publish themselves](#schemas)** - hierarchical ids (`data/schema/message/email` *is a* `data/schema/message`), zod validation, and derived JSON Schema consumers can fetch instead of hand-copying enums.

> **v3.x** - schema version **3**, hierarchical `data/schema/*` ids. A database below that version refuses to open. There is no migration code in the engine; run `scripts/migrate-schema-v3.js`. See **[Schema version and rebuild](#schema-version-and-rebuild)**.

## Quick start

```js
import SynapsD from '@canvas/synapsd';

const db = new SynapsD({ path: '/path/to/db' });
await db.start();

const id = await db.put(
    {
        schema: 'data/schema/note',
        data: { title: 'Hello', content: 'First draft' },
        features: ['tag/inbox'],
    },
    { paths: ['ctx:/work/project-a'] },
);

const inbox = await db.list({ paths: ['ctx:/work/project-a'], features: ['tag/inbox'] });
const hits = await db.query('draft', { paths: ['ctx:/work/project-a'] });

await db.shutdown();   // `stop()` is an alias
```

Constructor options: `path` (required, alias `rootPath`), `backupOnOpen`, `backupOnClose`, `backupRetentionDays` (age-based backup retention keyed off the dated backup folders, default **7**; the newest backup always survives), `maxBackupRetention` (optional folder-count cap on top of the age rule, off by default), `compression`, `eventEmitterOptions`, `semantic` (see **Semantic search**). `backend` accepts only `'lmdb'`.

All examples below assume a started `db`.

---

## What you can actually do

Same query object everywhere: `list`, `query`, `search`, sessions, writes.

### Everything related to a task

A context path ANDs the layers along it. One document, linked to the customer, the project, and the task, answers all three questions. Shorten the path to zoom out.

```js
await db.put(
    {
        schema: 'data/schema/note',
        data: { title: 'Kickoff notes', content: 'Scope signed, waiting on legal.' },
        features: ['tag/important'],
    },
    { paths: ['ctx:/work/customer-foo/project-bar/task-baz'] },
);

await db.put(
    {
        schema: 'data/schema/message/email',
        data: { subject: 'Re: task-baz', from: 'legal@customer-foo.example' },
    },
    { paths: ['ctx:/work/customer-foo/project-bar/task-baz'] },
);

// Everything linked to this task: notes, mail, files, tabs.
const related = await db.list({
    paths: ['ctx:/work/customer-foo/project-bar/task-baz'],
    limit: 0,
});

// Zoom out: the whole project, minus staging.
const project = await db.list({
    paths: ['ctx:/work/customer-foo/project-bar', '!ctx:/staging'],
});

// Same path, ranked.
const invoices = await db.query('invoice', {
    paths: ['ctx:/work/customer-foo/project-bar/task-baz'],
    features: ['+tag/finance', '!tag/deleted'],
    limit: 20,
});

// Zero-fetch probe: any pending tasks under this customer?
const pending = await db.list({
    paths: ['ctx:/work/customer-foo'],
    features: ['+data/schema/task', '+data/status/pending'],
});
```

`related.totalCount` is the size of the set. `has(id, { paths: ['ctx:/work/customer-foo/project-bar/task-baz'] })` answers membership from the bitmaps, no document loaded.

### The zeitgeist of a birthday

Grandma was born 12 April 1938. What else was happening: two historians, Wikipedia, and your own life, in one call. Two retrieval modes on the same query: `grouped` is per-source, `layers` keeps the scale (year vs day vs Myr) so a UI can stack them.

```js
await db.timeline.createTimeline('wikipedia');
await db.timeline.createTimeline('britannica');
await db.timeline.createTimeline('personal');

await db.put({
    schema: 'data/schema/document',
    data: { title: '1938', text: 'The year 1938.' },
    timelines: [{ name: 'wikipedia', start: '1938', end: '1938' }],
    features: ['data/dataset/wikipedia'],
});

await db.put({
    schema: 'data/schema/document',
    data: { title: 'Anschluss of Austria', text: 'March 1938.' },
    timelines: [{ name: 'wikipedia', start: '1938-03-12', end: '1938-03-13' }],
    features: ['data/dataset/wikipedia'],
});

await db.put({
    schema: 'data/schema/document',
    data: { title: 'Munich Agreement', text: 'September 1938.' },
    timelines: [{ name: 'britannica', start: '1938-09-30' }],
    features: ['data/dataset/britannica'],
});

await db.put({
    schema: 'data/schema/note',
    data: { title: 'Grandma born', content: 'Košice, 12 April 1938.' },
    timelines: [{ name: 'personal', start: '1938-04-12' }],
}, { paths: ['ctx:/family/grandma'] });

const grouped = await db.timeline.queryInterval(
    ['wikipedia', 'britannica', 'personal'],
    { start: '1938-04-12', end: '1938-04-12' },
    { mode: 'grouped' },
);
// {
//   wikipedia:  [year1938Id],          // year-scale 1938 covers the day
//   britannica: [],                    // Munich is September; still present as []
//   personal:   [grandmaNoteId],
// }

const layers = await db.timeline.queryInterval(
    ['wikipedia', 'britannica', 'personal'],
    { start: '1938-04-12', end: '1938-04-12' },
    { mode: 'layers' },
);
// {
//   wikipedia:  { year: [year1938Id] },
//   britannica: {},
//   personal:   { day: [grandmaNoteId] },
// }

// Widen the window to the year. Grouped for a source list; layers if the UI
// wants year-scale encyclopaedia next to day-scale family notes.
const thatYear = await db.timeline.queryInterval(
    ['wikipedia', 'britannica', 'personal'],
    { start: '1938-01-01', end: '1938-12-31' },
    { mode: 'grouped' },
);

const hydrate = (ids) => Promise.all(ids.map((id) => db.get(id)));
const pages = {
    wikipedia:  await hydrate(thatYear.wikipedia),
    britannica: await hydrate(thatYear.britannica),
    personal:   await hydrate(thatYear.personal),
};

// Same date, through the document query: mix Wikipedia into your own files.
const mixed = await db.list({
    filters: ['t:wikipedia:1938', 't:personal:1938-04-12'],
    features: { anyOf: ['data/dataset/wikipedia'] },   // adds the corpus; default (your docs) stays selected
});
```

`grouped` returns every requested timeline, empty as `[]`. `layers` is `{ name: { scale: [ids] } }`: only scales that hit are present (plus `multi` for non-primary positions). A year-scale Wikipedia article and a day-precise personal note both match `1938-04-12` when their intervals cover it. Open-ended lives (`end: Infinity`) match any later query automatically. Default `mode` is `union`: one flat id array.

### Agentic search that refines as it thinks

An agent (or a human, or both) opens a session, then adds, patches, and drops cues while the candidate set stays live. Cheap to probe (`count()` / `ids()` load no documents). Cheap to refine (each cue is resolved once and cached). Hand the session to another channel, or serialize it across a restart.

```js
import QuerySession from '@canvas/synapsd/src/session/QuerySession.js';

const hunt = await db.openSession([], { mode: 'frozen', emit: 'delta' });

// Channel 1: the customer workspace
await hunt.add({ paths: ['ctx:/work/customer-foo'] }, 'workspace');

// Channel 2: mail + notes + files (OR within the bucket)
await hunt.add({
    features: ['data/schema/message/email', 'data/schema/note', 'data/schema/file'],
}, 'channels');

await hunt.count();   // survivors, no document load

// Rank what is in scope so far
let page = await hunt.materialize('overdue invoice', { limit: 20, mode: 'hybrid' });

// Agent reads a hit, pulls the author in
await hunt.add({ rel: { p: 'mentions', of: aliceId, dir: 'in' } }, 'alice');

// Too broad: require finance, drop staging
await hunt.patch('workspace', { features: ['+tag/finance'] });
await hunt.add({ paths: ['!ctx:/staging'] }, 'not-staging');

page = await hunt.materialize('overdue invoice', { limit: 20 });

// Persist, hand off, resume
const snapshot = hunt.serialize();   // specs + labels, no bitmaps
hunt.close();
const resumed = await QuerySession.rehydrate(db, snapshot);
```

`frozen` (default) pins relative timeframes at `add()` time: a stable working-memory snapshot. `live` re-resolves temporal cues so windows slide, and pushes `change` events. A write only dirties cues whose bitmap keys it touched.

Several consumers on the same hunt, each a channel:

```js
const live = await db.openSession(
    { paths: ['ctx:/work/customer-foo/project-bar'] },
    { mode: 'live', emit: 'delta' },
);

const offUi    = live.on('change', ({ added, removed, count }) => renderCanvas(added, removed, count));
const offAgent = live.on('change', ({ added }) => void agent.ingest(added));
const offChat  = live.on('change', ({ count }) => post(`project-bar now has ${count} docs`));

await live.add({ features: ['+tag/urgent'] }, 'urgent');
await live.remove('urgent');          // widen
await live.set('focus', { features: ['data/schema/task'], filters: ['t:tasks:thisWeek'] });

offUi(); offAgent(); offChat();
live.close();
```

No session object needed? Fold a stack of text queries. Each one AND-narrows the previous result (FTS and the image-vector space, so photos refine too); the last one ranks:

```js
const drill = await db.searchRefined(
    ['invoice', 'Q3', 'overdue'],
    { paths: ['ctx:/work/customer-foo'], features: ['data/schema/message/email'] },
    { limit: 20 },
);
```

Zero or one query degrades to a plain list or single search. `searchCompound(lines, options)` is the sibling that fuses per-line rankings instead of chaining them.

### Photos on a map

GPS on the document is enough. The spatial index is derived from `metadata.geo`; the `content` timeline is the capture date. A map viewport is one bbox. Sorting happens on the id set *before* pagination, so page 1 is already chronological.

```js
await db.put({
    schema: 'data/schema/file',
    checksumArray: ['sha256/ab12…'],
    metadata: {
        contentType: 'image/jpeg',
        filename: 'site-survey.jpg',
        geo: { lat: 48.1486, lon: 17.1077 },
    },
    timelines: [{ name: 'content', start: '2023-07-04T16:12:00Z' }],
}, { paths: ['ctx:/house-build'] });

const inView = await db.list({
    paths: ['ctx:/house-build'],
    features: ['+data/schema/file', '+data/mime/image'],
    filters: ['geo:bbox:47.5,15.5,48.8,17.8', 't:content:2023-01-01..2023-12-31'],
    sortBy: 'content',
    order: 'asc',
    limit: 50,
});

// Pan the map: same query, new bbox. Precise pins come from metadata.geo;
// the bbox is a candidate set and may slightly overshoot the rectangle.
```

`data/mime/image` is derived from `contentType`, so you never tag "this is a photo" by hand. Drop the mime gate and the same viewport returns notes, events, and files that carry coordinates.

### Around me, and what the camera sees

You are standing somewhere. Two questions, same geo filter: what did I already file here, and what in my archive looks like this camera frame.

The first is GPS. The second is already live: Inferd embeds each frame into the same joint image space the archive uses (`embedImageQuery`; the vector is ephemeral, never indexed). SynapsD never sees the bytes. It ranks documents that already survived the structural filter.

```js
const { lat, lon } = gps.here();

// Everything I have filed within 500 m: photos, notes, events, files.
const aroundMe = await db.list({
    filters: [`geo:near:${lat},${lon},500m`],
    limit: 50,
});

const photosHere = await db.list({
    features: ['+data/mime/image'],
    filters: [`+geo:near:${lat},${lon},200m`],
    sortBy: 'content',
    order: 'desc',
});

// Walk: a live session whose geo cue tracks you. Count/ids stay cheap.
const walk = await db.openSession([], { mode: 'live', emit: 'delta' });
await walk.add({ filters: [`geo:near:${lat},${lon},300m`] }, 'here');
walk.on('change', ({ count }) => showNearby(count));

async function onGps({ lat, lon }) {
    await walk.set('here', { filters: [`geo:near:${lat},${lon},300m`] });
}

// Each camera frame. Inferd embeds it; synapsd does kNN in the image space,
// still scoped to "here".
async function onFrame(frameBytes) {
    const imageVec = await inferd.embedImageQuery(wsId, frameBytes, 'image/jpeg');

    const byLook = await db.searchByVector(imageVec, {
        filters: [`geo:near:${lat},${lon},300m`],
        features: ['data/mime/image', 'data/schema/note', 'data/schema/file'],
    }, { space: 'image', limit: 12 });

    // Optional: caption the frame and rank text (notes, mail, metadata.summary).
    const caption = await inferd.describeImage(wsId, frameBytes);
    const byCaption = await walk.materialize(caption, { limit: 12, mode: 'hybrid' });

    return { byLook, byCaption };
}
```

`byLook` is the live-video path: cross-modal image kNN against stored photos (and any other doc with an image-space vector). Drop the geo filter if the match should be global; add a path or mime gate to tighten it. `describeImage` is optional (`summarize.image.enabled`) and feeds the lexical/hybrid leg: notes and files whose body or `metadata.summary` mention what the camera described.

---

## High-level design overview

- **Documents are the source of truth; indexes are derived cache.** Timelines, mime facets, backend and device presence, geo cells, asserted edges: all re-derived from document state on every write, so they cannot drift. `rebuildL3()` reconstructs them from rows alone.
- **Membership is cheap and plural.** A document is stored once; appearing in ten trees, five tags, and three timelines costs bitmap bits, not copies.
- **The dense stack is optional.** No embedder (or `semantic.enabled: false`) means vector/hybrid queries degrade to FTS; nothing else changes.
- **Crash-resumable embedding.** The work-ledger is a persistent bitmap diff (`getUnembeddedDocIds`), so an external embedder resumes after a restart without rescanning a single document.

| Layer | What it is | Rebuildable from |
|-------|------------|------------------|
| **L0** | Physical bytes addressed by `locations[]` URLs, identified by `checksumArray`. | - |
| **L1** | Document rows: the JSON payload, `checksumArray`, timestamps. The source of truth. | nothing (this *is* the truth) |
| **L2** | View membership: context/directory tree bitmaps. Human-authored placement. | nothing (also truth) |
| **L3** | Everything derived: feature/facet bitmaps, mime, backend/device presence, timelines, geo cells, asserted edges, FTS/vector rows. | L1 + extractors: `rebuildL3()` |

Drop L3, recompute it from L1, and the index must come back identical. If it does not, something is storing state with no source. L0 is out of band: synapsd keeps the pointers and checksums, not the bytes.

Every read is two pure stages, and both are public:

```
resolveCandidates(spec) -> { bitmap, keys, collectionKeys, coarse }
rank(bitmap, match, { mode, limit, offset })   // match=null => slice; else fts/vector/hybrid

query(match, spec) = rank(resolveCandidates(spec).bitmap, match, spec)
list(spec)         = query(null, spec)
```

`list`, `query`, `search`, `searchRefined`, `searchCompound`, and `QuerySession` are all entry points onto that same seam, which is why any filter documented below works in all of them.

`collectionKeys` are the actual bitmap keys consulted, so a live session can intersect them against `membership.changed` for precise invalidation. `coarse` marks a dependency with no stable key (temporal, spatial, or `rel`), which consumers must re-resolve rather than key-intersect.

## Core concepts

### Documents

A document is a JSON object with a `schema`, a `data` payload, and engine-managed fields. `put()` returns a numeric document id, which is the identity used everywhere else. Checksums are first-class lookup keys, so content-addressed reads work without knowing the id.

The stored row shape (v3):

```js
{
    id: 42,
    schema: 'data/schema/note',
    schemaVersion: '3.0',

    data: { /* schema-specific payload */ },
    comment: 'sofa from the cozmo bar',

    features: ['tag/inbox', 'custom/client/acme'],
    locations: [{ url: 'file:///data/ab12…', metadata: {} }],
    timelines: [{ name: 'content', start: '2023-07-04' }],

    metadata: { contentType, contentEncoding, geo: { lat, lon }, … },
    checksumArray: ['sha1/…', 'sha256/…'],
    createdAt, updatedAt,
    orphanedAt: null,
}
```

Three things worth knowing before you write anything:

- **`features[]` is top-level and asserted-only.** `metadata` holds *extracted facts written by derivers*; `features[]` holds *membership a human or client asserted*. Derived prefixes (`data/schema/`, `data/mime/`, `data/backend/`, `feature/`, `device/`, plus each schema's own facet namespaces) are **stripped on the way in**. `data/dataset/*` is *preserved* across an update that omits it, so a client re-putting its own tag array cannot drop ingest provenance.
- **`indexOptions` is schema-level** (`static indexOptions` on the schema class). There is no per-document index override. Legacy rows carrying it are ignored on read.

Reading a document back gives you a schema instance (`parse: false` for the raw stored object).

### Subtypes (the schema-id hierarchy)

The schema id is hierarchical. Every segment below `data/schema/` is ticked on write, parent and child alike, so querying the parent is a roll-up.

A child segment is a registered id. Some children have their own class; closed-enum leaves share the parent class:

- `data/schema/message/email` is an Email, and also a Message. It has its own class; `doc.schema` is the full id.
- `data/schema/application/flatpak` is an Application. The leaf *is* the schema id; querying `data/schema/application` rolls the children up. Same pattern for Event, Identity, Dotfile.

Both keys work the same in `features`. `listSchemas()` lists schemas; `resolveSchemaId(key)` walks a bitmap key up to the schema that owns it.

### Trees

Trees are views on top of your documents. They organise membership and structure, not data. A single document can live in many trees at once. Every database supports multiple named trees of two types.

**Context trees** are unique-by-name layers linked to bitmaps. Querying a path does a logical AND across every layer along it:

- `ctx:/work/customer-foo/project-bar/task-baz` resolves to all data linked to that task.
- `ctx:/work/customer-foo/project-bar` resolves to all data linked to that project (every task, plus project-level docs).
- `ctx:/task-baz` is an ad-hoc path: the same layer name, any customer, any project.

Because layers are unique by name and intersect, the tree gives you a natural zoom: shorten the path to widen the result. Paired with a session, it becomes a way to fine-tune retrieval dynamically.

Beyond FS-like tree methods, layers support `merge layer` (merge a layer's bitmap into 1-N others) and `subtract layer`.

**Directory trees** are the more familiar UX: unique folder nodes with filesystem-like semantics. A virtual directory is a self-contained movable/copyable container. Each directory owns its bitmap; recursive queries OR them.

### Features

Features are flat bitmap keys ticked on a document. They carry a `who says so?` convention in the prefix. Allowed prefixes are validated in `src/indexes/bitmaps/lib/keys.js`.

**User-managed** — a client or the application asserted these. They live on the row in `features[]`.

| Prefix | Who says so | Notes |
|--------|-------------|-------|
| `tag/*` | The user: free-form flat labels | |
| `client/*` | The writing client | |
| `custom/<axis>/<value>` | The user: structured | |
| `data/dataset/*` | Ingest provenance (see **Datasets**) | preserved across updates that omit it |

**System** — the engine ticks these from document state or tree membership. They are not stored on the row. Asserting a copy is stripped on write.

| Prefix | Source |
|--------|--------|
| `data/schema/*` | `schema` (every id-path segment) |
| `data/mime/*` | `metadata.contentType` (type + full type) |
| `data/backend/*` | `locations[]` (scheme + scheme/authority, no scheme exempt), or `metadata.backend` |
| `data/<facet>/*` | a schema's `static facetFields` (e.g. `data/status/*` from Task's `data.status`, `data/platform/*` from Application's `data.platform`); array-valued fields emit one key per entry |
| `device/id/*` | `locations[]` (`file://` and `device://` authorities) |
| `device/os\|arch\|type/*` | the device's own Device document, joined on `device/id` |
| `feature/*` | the engine observed it (`feature/has-comment`, `feature/orphaned`) |
| `context/*`, `vfs/*` | tree membership: bitmap-only, not on the row |
| `internal/*` | engine-managed, hidden from default listings |

Derived facet bitmaps are re-ticked and stale-unticked on every write from document state, so they cannot drift. Completing a task moves it from `data/status/pending` to `data/status/completed` atomically with the document write, so an agent's "any pending tasks here?" is a zero-fetch bitmap probe.

Key charset: lowercased, `a-z 0-9 _ - . / @ : +`. `@` and `:` keep backend addresses readable (`data/backend/imap/user@domain.tld`); `+` keeps MIME subtypes intact (`data/mime/image/svg+xml`) and is only a query sigil in *leading* position.

#### Hierarchical keys

Three axes are paths, not flat labels, and **every prefix is ticked**, so the general and the specific question are both one key with no enumeration:

| Axis | Ticked keys for one document |
|------|------------------------------|
| `data/backend/*` from `stored://homenas/k1` | `data/backend/stored`, `data/backend/stored/homenas` |
| `device/os/*` for a box on Ubuntu 24.04 | `device/os/linux`, `device/os/linux/ubuntu`, `device/os/linux/ubuntu/24.04` |
| `data/mime/*` from `image/png` | `data/mime/image`, `data/mime/image/png` |

The OS chain is family, distro, version. An empty tier is skipped rather than reserved, so a mac gets `device/os/mac` + `device/os/mac/15.2`. Values come from the Device document (`platform`, `osDistro`, `osVersion`); clients read them from `/etc/os-release` on Linux.

`device/arch/*` uses **`os.machine()` spelling** (`x86_64`, `aarch64`), not `os.arch()` (`x64`, `arm64`), matching what flatpak, snap and appimage publish against.

`data/platform/*` is the **capability** axis (`<os>/<arch>`, e.g. `data/platform/linux/x86_64`), declared per document as an array in `Application.data.platform`. `device/*` says where a document *is*; `data/platform/*` says where it *could* run.

#### What the axes buy you

```js
// Loose local files with no managed copy: a backup sweep's worklist.
await db.list({ features: { allOf: ['data/backend/file'], noneOf: ['data/backend/stored'] } });

// The fleet still on the old LTS, ahead of a rollout.
await db.list({ features: { allOf: ['data/schema/device', 'device/os/linux/ubuntu/22.04'] } });

// Everything on this machine, whatever schema, wherever it came from.
await db.list({ features: [`device/id/${deviceId}`] });

// Of the apps in this workspace: which can run here, and which already do.
const applicable = ['data/schema/application', 'data/platform/linux/x86_64'];
await db.list({ features: { allOf: applicable } });
await db.list({ features: { allOf: [...applicable, `device/id/${deviceId}`] } });   // installed
await db.list({ features: { allOf: applicable, noneOf: [`device/id/${deviceId}`] } }); // installable

// Documents that had a copy and lost it — the retention GC's candidate set.
await db.list({ features: ['feature/orphaned'] });
```

`feature/orphaned` means `orphanedAt` is set *and* `locations[]` is empty, so re-binding a copy unticks it while `orphanedAt` stays as the retention clock.

Two rules for clients:

- **Never assert a derived key.** `device/*`, `data/backend/*`, `data/schema/*`, `data/mime/*` and `feature/*` are engine-owned and stripped on write. Use `client/*` or `custom/*` for your own provenance.
- **Indexing applications is opt-in, per workspace.** Let the user choose which local apps to index, and ask again for each workspace. A workspace is its own database, so an over-eager sweep has no repair beyond deleting documents the user never wanted.

Design rationale, rejected alternatives and the rules for adding an axis: [`docs/FEATURE_AXES.md`](docs/FEATURE_AXES.md).

## The query spec

One object shape drives every read. The buckets intersect (`paths AND features AND filters AND rel`), and items within a bucket combine via the sigil algebra below.

### Full reference example

Every field, in one spec. Nothing here is required; an empty spec `{}` lists everything.

```js
const page = await db.query('quarterly invoice', {
    // ---- WHERE: tree membership -------------------------------------------
    // String grammar targets the DEFAULT trees.
    // Positive entries OR together; only `!` (exclude) is honoured here.
    paths: [
        'ctx:/work/customer-foo',    // in this context...
        'dir:/docs/contracts',       // ...OR in this directory
        '!ctx:/staging',             // excluded from the union
    ],
    // Object form, equivalent:
    // paths: { in: ['ctx:/work/customer-foo', 'dir:/docs/contracts'], not: ['ctx:/staging'] },

    // Tree-qualified selectors: use when you need a NON-default tree.
    // `path` accepts a string or an array. NOTE: these join the SAME OR-union as
    // `paths` above, they do not intersect with it. Use one style per spec.
    context: { tree: 'projects', path: ['/work/project-a', '/work/shared'] },
    directory: { tree: 'filesystem', path: '/docs', recursive: true },

    // ---- WHAT: features ---------------------------------------------------
    features: [
        'data/schema/file',     // anyOf (OR within the bucket)
        '+tag/finance',         // allOf (required)
        '!tag/deleted',         // noneOf (excluded)
    ],
    // Object form, equivalent:
    // features: { allOf: ['tag/finance'], anyOf: ['data/schema/file'], noneOf: ['tag/deleted'] },

    // ---- WHEN / WHERE-ON-EARTH: filters -----------------------------------
    filters: [
        't:crud:updated:thisWeek',              // temporal, named timeframe
        '+t:content:2023-01-01..2023-12-31',    // temporal, explicit range
        'geo:near:48.1486,17.1077,5km',         // spatial, radius
        '!t:crud:created:today',                // excluded
        'custom/client/acme',                   // raw bitmap key (ANDed)
    ],

    // ---- WHO WITH: graph adjacency, one hop -------------------------------
    rel: [
        { p: 'mentions', of: 1234, dir: 'in' },              // docs mentioning 1234
        { op: 'noneOf', p: 'derived-from', of: 1234 },       // minus its derivatives
    ],

    // ---- HOW: ranking (ranked queries only) -------------------------------
    mode: 'hybrid',        // 'hybrid' (default) | 'fts' | 'vector'
    minDistance: 0,        // cosine floor for the dense leg (0 = identical)
    maxDistance: 0.9,      // cosine ceiling (2 = opposite); omit for no ceiling
    debug: false,          // attach result.debug.imageDistances for calibration

    // ---- PAGING / SHAPE ---------------------------------------------------
    limit: 50,             // list: 100, query: 50; 0 = all matches
    offset: 0,             // or `page: 1` (1-based, computed from limit)
    order: 'asc',          // 'asc' (default) | 'desc'
    sortBy: 'content',     // timeline name; LIST ONLY, ranked stays relevance-ordered
    parse: true,           // false => raw stored data, no document instances
});
```

Any of the read options (`mode`, `limit`, `offset`, `page`, `order`, `sortBy`, `parse`, `groupBy`, `minDistance`, `maxDistance`, `debug`, and `rel`) may also be nested under an `options: { ... }` key. Top-level wins when both are present.

### Sigil algebra

| Sigil | Bucket | Meaning |
|-------|--------|---------|
| *(none)* | `anyOf` | OR within the bucket (default) |
| `+` | `allOf` | Required gate |
| `!` | `noneOf` | Exclude |

The buckets intersect with each other, and within `features`, `filters` and `rel` the algebra above applies in full. (`rel` spells its sigil as an `op` field rather than a prefix, since its entries are objects.)

**`paths` is the exception**: its positive entries always OR together, and `+` is accepted but has no effect. Only `!` is meaningful there. Intersection is what a *path* already expresses (a context path ANDs the layers along it), so ANDing two separate paths is not a thing you ask for. To require membership in two independent places, use a feature gate or nest the path.

In the object form of `features`, a `!`-prefixed entry inside `allOf`/`anyOf` is sugar for `noneOf`.

### Field reference

| Field | Description |
|-------|-------------|
| `paths` | `['ctx:/a/b', 'dir:/x', '!ctx:/staging']` or `{ in, not }`. The `ctx:`/`dir:` grammar targets default trees; a bare path defaults to context. Positive entries OR; only `!` is honoured |
| `context` / `directory` | Tree-qualified selector `{ tree, path, recursive }`, for non-default trees. `path` takes a string or array. `recursive` (directory trees only) widens node-exact scoping to the whole subtree. Joins the same OR-union as `paths` |
| `features` | `['+tag/red', 'tag/blue', '!tag/spam']` or `{ allOf, anyOf, noneOf }` |
| `filters` | `['t:crud:updated:thisWeek', '+geo:bbox:...', '!t:crud:created:today']` (see filter grammar) |
| `rel` | `{ p, of, dir?, op? }` or an array of them. See **Relations and edges** |
| `mode` | `hybrid` (default), `fts`, or `vector`. Ranked queries only |
| `minDistance` / `maxDistance` | Cosine-distance window for the dense leg of `vector`/`hybrid`. Drops kNN neighbours outside `[min, max]` before fusion (`0` = identical, `2` = opposite) |
| `limit` | Max documents (`list`: 100, `query`: 50; `0` = all matches) |
| `offset` / `page` | Pagination. `page` is 1-based and derived from `limit` |
| `order` | `asc` (default) or `desc`. Without `sortBy`, orders by id (insertion order); with `sortBy`, applies to the timeline value |
| `sortBy` | Timeline name to sort a listing by (`'content'`, `'crud:created'`; a `t:` prefix is tolerated). List only |
| `parse` | Set `false` to return raw stored data instead of document instances |
| `debug` | Attaches `result.debug.imageDistances` (unfloored image-kNN cosine distances, best-first) so you can calibrate the `imageMaxDistance` relevance floor from real numbers |

### Filter grammar

Filters share the sigil algebra and dispatch on a type prefix:

- **`t:<name>:<spec>`**, temporal. The reserved lifecycle form is `t:crud:<action>:<timeframe|range>` (`t:crud:updated:thisWeek`, `t:crud:created:2026-01-01..2026-05-10`). Content timelines use `t:<name>:<point|range>` (`t:wikipedia:1996`, `t:wikipedia:1996..1999`). Named timeframes (`today`, `thisWeek`, ...) resolve on *any* timeline, so `t:tasks:today` means "due today". Deep-time axes simply never match them.
- **`geo:<kind>:<args>`**, spatial (S2 index): `geo:bbox:minLat,minLon,maxLat,maxLon`, `geo:near:lat,lon,radius[m|km]`, `geo:cell:s2CellId[,...]`.
- **`g:<glob>`** and **`re:<regexp>`** are recognised but not yet implemented, and throw at parse time.

Anything without a recognised prefix is treated as a raw bitmap key and ANDed in. Token *shape* is validated at spec-parse time (not resolve time), so a malformed token throws instead of quietly looking like "no results".

### Result shape

Reads return an array of documents with metadata attached to it:

- `result.count`: number of documents in this page.
- `result.totalCount`: total matching documents, before pagination.
- `result.error`: error message string, or `null`.

`list()` returns its error on the result rather than throwing; `query()` throws.

## CRUD API

The public read surface is `list()` and `query()`. Writes take `(document, spec)`, where the spec is the same object shape as above, restricted to its write-relevant fields.

### The write spec

```js
const noteSpec = {
    paths: ['ctx:/work/project-a'],              // ctx:/dir: grammar, default trees
    features: ['tag/inbox'],                     // ticked in addition to document.features
    emitEvent: true,                             // default; false suppresses events
    provenance: { origin: 'rule', causedBy: 'evt-parent', depth: 1 },
};

// Tree-qualified equivalent, for a non-default tree:
const projectTreeSpec = {
    context: { tree: 'projects', path: '/work/project-a' },
};
```

Write methods tick every feature you pass, **unioned with the document's own `features[]`**. Dropping a feature from `features[]` on a re-put unticks its bitmap. Sigils are stripped on writes: the `paths` grammar is authoritative and derives both the context and directory selectors, so a directory-only write does not also touch `ctx:/`.

`provenance` rides on the emitted event so automation can detect and bound its own cascades. Only `origin`, `causedBy`, and `depth` pass through; anything else is dropped. It defaults to `origin: 'user'`, `depth: 0`.

### Create

`put()` creates a new row when the document has no existing `id`, and returns the numeric document id. Writes deduplicate by primary checksum: a write whose content hashes to an existing document of the same schema updates that row instead of forking it.

```js
const id = await db.put(
    {
        schema: 'data/schema/note',
        data: { title: 'Hello', content: 'First draft' },
        features: ['tag/inbox'],
    },
    noteSpec,
);

const ids = await db.putMany(
    [
        { schema: 'data/schema/note', data: { title: 'A', content: 'Alpha' } },
        { schema: 'data/schema/note', data: { title: 'B', content: 'Beta' } },
    ],
    { context: { tree: 'projects', path: ['/work/project-a', '/work/shared'] } },
);
```

A schema may declare `static mergeOnDedupe = ['data.links']` for record fields that must merge rather than be replaced when a write resolves to an existing document by checksum.

### Read

`get()` and `getByChecksumString()` return a parsed document instance by default. Pass `{ parse: false }` for raw stored data. Tree-aware membership checks use `has()` and `hasByChecksumString()`, which answer from bitmaps without loading the document.

```js
const doc = await db.get(id);
const rawDoc = await db.get(id, { parse: false });
const docByChecksum = await db.getByChecksumString('sha256/…');
const noteByChecksum = await db.getByChecksumString('sha256/…', { schema: 'data/schema/note' });

const existsAnywhere = await db.has(id);
const existsInProjectsTree = await db.has(id, { context: { tree: 'projects', path: '/work/project-a' } });
const existsWithInboxFeature = await db.has(id, { paths: ['ctx:/work/project-a'], features: ['tag/inbox'] });

await db.listDocumentTreePaths(id, 'projects');
await db.listDocumentTreeMemberships(id, 'projects');
await db.hasDocumentTreeMembership(id, 'projects');
await db.getBitmapsForDocument(id);
```

### Update

`put()` updates when `document.id` already exists.

`put({ id, data })` **replaces** `data`; it does not deep-merge fields. To change a single field, read the document first and send the full updated `data` object. Fields with their own branch (`comment`, `features`, `locations`, `timelines`) are updated independently of `data` and deliberately do **not** regenerate checksums: editing a tag or a comment must never fork dedup identity or trigger a re-embed.

```js
const current = await db.get(id);
await db.put({ id, schema: current.schema, data: { ...current.data, title: 'Updated title' } }, noteSpec);

// Change only tags: no checksum churn, no re-embed
await db.put({ id, features: ['tag/important', 'tag/reviewed'] });
```

To change only *view* membership (trees), use `link()` / `unlink()`, which never touch the row.

### Link and unlink

`link()` adds tree/feature membership. `unlink()` removes it. Neither touches the document body, and `unlink()` never deletes the document.

```js
await db.link(id, {
    context: { tree: 'projects', path: '/work/project-a' },
    features: ['tag/reviewed'],
});

await db.unlink(id, {
    context: { tree: 'projects', path: '/work/project-a/deep' },
    features: ['tag/inbox'],
});

await db.unlink(id, { context: { tree: 'projects', path: '/work/project-a/deep' }, recursive: true });

const linkResult = await db.linkMany([id1, id2], { context: { tree: 'projects', path: '/work/project-a' } });
const unlinkResult = await db.unlinkMany([id1, id2], { features: ['tag/inbox'] });
```

> Feature keys ticked through `link()` are *bitmap-only*: they are not written back to `features[]`. For tags you want to survive an L3 rebuild and be visible to offline clients, put them on the document.

Context-tree root `/` is a selector meaning "anything in this tree", not a real removable membership. Directory-tree root `/` is just the literal root folder.

### Delete

`delete()` removes the document row, checksum index entries, timeline index entries, edges, and synapse memberships. It returns `true` when a document was deleted, `false` when the id was not found.

```js
const deleted = await db.delete(id);
await db.delete(id, { emitEvent: false });
const deleteResult = await db.deleteMany([id1, id2]);
```

`unlinkMany()` and `deleteMany()` return `{ successful, failed, count }`. Batch delete and unlink ids must be numbers: numeric strings are accepted by `get()` and `put()` but rejected by the batch helpers.

## Relations and edges

A typed, directed, N:N edge plane between documents (`src/indexes/edges/`). Stored as three LMDB DBIs on the shared root env:

```
edges_fwd   dupSort   key [fromId, predId]         value toId
edges_inv   dupSort   key [toId,   predId]         value fromId
edge_meta   plain     key [fromId, predId, toId]   value { src, ts, conf? }
```

dupSort gives sorted, deduped value sets: writing the same edge twice is a no-op, and degree is a B-tree count rather than a scan.

### Predicates

A closed, append-only registry (`src/indexes/edges/predicates.js`). Ids are persisted inside LMDB keys, so they are never renumbered and never reused.

| Predicate | Id | Meaning |
|-----------|----|---------|
| `includes` | 1 | composition: email → attachments, tab → offline file |
| `references` | 2 | soft link |
| `derived-from` | 3 | provenance: thumbnail → image, offline file → tab |
| `mentions` | 4 | entity mention: message → identity |
| `replies-to` | 5 | threading: message → message |
| `depicts` | 6 | media subject: image → identity (face tags) |
| `authored-by` | 7 | authorship: message/document → identity |
| `member-of` | 8 | affiliation: identity → identity (person → organization) |

Every predicate takes the **document** as subject, never the entity it points at ("message authored-by identity", not "identity authors message").

**Direction is an axis, not a name.** There are no inverse predicate names. You express direction by which method you call (`outgoing` / `incoming`) or by a `dir` parameter. Inverse-style spellings (`mentioned-by`, `derives`, `authors`, …) are rejected with a pointer to the axis.

### Asserted edges: `data.relations`

A document declares its own edges in `data.relations`, an array of `{ p, to }`. They are derived into the edge index on every write, as a diff against the previous row: an update that drops an entry drops the edge.

```js
const alice = await db.put({ schema: 'data/schema/identity', data: { displayName: 'Alice' } });

const msg = await db.put({
    schema: 'data/schema/note',
    data: {
        title: 'standup',
        content: 'Alice is taking the migration',
        relations: [{ p: 'mentions', to: alice }],
    },
});
```

- Relations are validated at ingest: an unknown predicate, an inverse-style name, or a non-integer `to` throws.
- Dangling `to` ids are **allowed** (logged at debug). Edges to documents that do not exist yet are filtered by candidate-set intersection at query time, and forbidding them would make ingest order significant.
- Deleting a document drops every edge touching it (both directions) and retracts incoming asserted claims from surviving subjects, so a rebuild cannot resurrect them. Outgoing claims die with the row.
- `data.relations` is **structural, not content**: `Document.contentData()` strips it from every whole-`data` projection (checksum, FTS, embedding). Asserting an edge therefore does not fork the document's identity, pollute its search text, or trigger a re-embed.

### Provenance: asserted vs derived

**Asserted edges write no meta row.** The absence of a meta record *is* the convention meaning "owned by a document's `data.relations`"; `edge()` synthesizes `{ src: 'doc' }` so callers never see the trick. Extractor and agent edges must pass `{ src: 'extractor:<name>' }` or `{ src: 'agent:<hookId>' }`.

That split is what makes `removeEdges({ src })` + re-running the extractor a complete rebuild path for derived edges that can never touch asserted ones.

```js
await db.relate(fromId, 'derived-from', toId, { meta: { src: 'extractor:thumbnailer' } });
await db.relate(fromId, 'includes', toId, { inheritMemberships: true });
await db.unrelate(fromId, 'derived-from', toId);

db.edges.exists(from, 'mentions', to);
db.edges.edge(from, 'mentions', to);          // -> { from, p, to, meta }
db.edges.degree(id, 'mentions', 'in');
db.edges.edgesOf(id);                          // { outgoing: [{p,to}], incoming: [{p,from}] }
[...db.edges.outgoing(id, 'mentions', { limit: 100 })];
[...db.edges.incoming(id, 'mentions')];
db.edges.removeEdges({ src: 'extractor:ner', p: 'mentions' });
```

`EdgeIndex` is document-unaware by design: it speaks uint32 node ids and predicates, nothing else. Anything document-shaped (deriving from `data.relations`, membership inheritance) lives on the `SynapsD` facade above it.

> Iterator caveat: a live LMDB iterator pins a read transaction, and dupSort stores cannot disable the snapshot. Drain `outgoing()`/`incoming()` promptly and never hold one across an `await`.

### The `rel` query bucket

Adjacency composes into the same candidate pipeline as paths and features: one hop, expressed as set algebra rather than a traversal API. Multi-hop traversal is deliberately out of scope.

```js
await db.list({
    context: { path: '/work' },
    rel: { p: 'mentions', of: aliceId, dir: 'in' },
    features: ['tag/important'],
});

await db.list({ rel: { p: 'mentions', of: msgId } });   // outgoing is the default

await db.list({
    rel: [
        { p: 'replies-to', of: threadRoot, dir: 'in' },
        { op: 'noneOf', p: 'derived-from', of: threadRoot },
    ],
});
```

`of` must be a positive integer document id (numeric strings are coerced); `dir` is `'out'` (default) or `'in'`; `op` is `anyOf` (default), `allOf`, or `noneOf`. All of this is validated at spec-parse time: an unknown or inverse-style predicate would otherwise be caught by the sigil combiner and silently *widen* the result set instead of failing.

A `rel` operand has no stable bitmap key (it is a dupsort scan), so it marks the candidate set `coarse`: a `QuerySession` re-resolves it rather than key-invalidating.

## Schemas

A schema is a `Document` subclass plus a registration record. The registry (`src/schemas/SchemaRegistry.js`) is a singleton with three tiers:

| Tier | Folder | What | Ids |
|------|--------|------|-----|
| `core` | `schemas/core/` | synapsd's own primitives. Sealed: cannot be re-registered or removed. | `document`, `file`, `message`, `email`, `event`, `task`, `identity`, `device`, `application` |
| `app` | `schemas/app/` | Consumer abstractions, registered through the same code path a third party would use. | `note`, `tab`, `link`, `dotfile` |
| `internal` | `schemas/internal/` | Tree layer abstractions. | `internal/layers/{canvas,context,label,system,universe,workspace,project}` |

`data/schema/document` has no file of its own: it registers `schemas/Document.js`, the base class itself.

Ids are hierarchical `data/schema/*`. The old flat `data/abstraction/*` namespace is retired; `SCHEMA_ID_RENAMES` (exported from the registry) records the old→new mapping the migration script executes.

### Registering your own

```js
import schemaRegistry from '@canvas/synapsd/src/schemas/SchemaRegistry.js';
import Document from '@canvas/synapsd/src/schemas/Document.js';

class Widget extends Document {
    static indexOptions = {
        ftsSearchFields: ['data.title', 'data.body'],
        vectorEmbeddingFields: ['data.title'],
        checksumFields: ['data.title', 'data.serial'],
    };
    static facetFields = ['data.condition'];   // -> data/condition/<value> bitmaps

    constructor(options = {}) {
        options.schema = options.schema || 'data/schema/widget';
        super(options);
    }

    static get dataSchema() { /* zod */ }
}

schemaRegistry.registerSchema('data/schema/widget', Widget);
```

A subclass of a core schema keeps its parent's validation with `mergeDataSchema()`:

```js
class Phone extends Device {
    static get dataSchema() {
        return Document.mergeDataSchema(super.dataSchema, { imei: z.string() });
    }
}
```

Pass **`super.dataSchema`** on purpose: the helper takes no `this` and does no prototype walking. It **throws** when the parent is a `ZodEffects` (wrapped in `.refine()`): that refinement has no introspectable shape. Compose those by hand.

Rules the registry enforces:

- The class must be a `Document` subclass; core ids cannot be re-registered.
- Passing `options.indexOptions` **writes `SchemaClass.indexOptions`** rather than storing a parallel copy.

`indexOptions` fields: `checksumAlgorithms` (default `['sha1','sha256']`), `checksumFields`, `ftsSearchFields`, `vectorEmbeddingFields` (all default to `['data']`), and `embeddingOptions`. Field paths are dotted and resolved against the *document*; the literal `'data'` resolves to `contentData()`, i.e. `data` minus `relations`.

`static facetFields = ['data.status']` gives a schema the derived-facet machinery: the leaf field name becomes the namespace (`data/status/*`). Engine-owned namespaces (`abstraction`, `schema`, `kind`, `mime`, `backend`, `source`, `dataset`, `no-location`) are refused.

A facet field may hold **one value or an array**, in which case it emits one key per entry. That is what a capability axis needs — `data.platform = ['linux/x86_64', 'linux/aarch64']` ticks both — and it stays truthful for free, because every write path diffs the previous key *set* against the current one, so dropping a single entry unticks exactly that key. Name the field for the namespace you want, in the singular even when it holds an array: the leaf name *is* the key namespace, and `data/platform/linux/x86_64` reads as one fact about the document.

### Publishing a schema to consumers

`static get dataSchema()` (zod) is the only shape you write. **`jsonSchema` is derived from it**. `schemaRegistry.getJsonSchema(id)` stamps `$id`. A consumer fetches a schema instead of copying it.

Internal layer types are not documents and have no `dataSchema`; `getJsonSchema()` returns `null` for them rather than throwing, so iterating `listSchemas()` is safe.

Introspection: `db.listSchemas(prefix?)`, `db.getSchema(id)`, `db.hasSchema(id)`, `db.getDataSchema(id)`, `db.getJsonSchema(id)`. On the registry itself: `getSchemaEntry(id)`, `resolveSchemaId(key)`, `unregisterSchema(id)`.

## Querying

### `list(spec)`: structural listing

Equivalent to `query(null, spec)`. Returns documents matching the candidate set in insertion order, with no ranking. With no buckets, `list` returns every document. Default limit is 100; pass `limit: 0` to return all matches.

```js
const docs = await db.list({
    paths: ['ctx:/foo/bar'],
    features: { allOf: ['data/schema/file'], noneOf: ['tag/deleted'] },
    filters: ['t:crud:updated:today'],
    limit: 100,
});

const exactDirectoryMatches = await db.list({
    directory: { tree: 'filesystem', path: ['/docs/contracts', '/docs/invoices'] },
    features: ['data/schema/file'],
});

const pending = await db.list({
    features: ['data/schema/task'],
    filters: ['data/status/pending'],
});

const fromAccount = await db.list({ features: ['data/backend/imap/user@example.com'] });
```

### `query(match, spec)` and `search(spec)`: ranked retrieval

`match` is a string (or `{ text }`). The candidate set scopes a full-text/vector search, ranked by relevance. `search(spec)` is a thin wrapper that pulls `match` from `spec.query` (`spec.search` and `spec.q` are also accepted). Default limit is 50. `mode` selects `hybrid` (default), `fts`, or `vector`; vector and hybrid fall back to `fts` when the dense stack is down.

```js
const ranked = await db.query('invoice', {
    paths: ['ctx:/finance/2026'],
    features: ['data/schema/file', 'tag/finance'],
    limit: 20,
});

const same = await db.search({ query: 'invoice', paths: ['ctx:/finance/2026'], limit: 20 });
```

### Sorting by a timeline

`list()` can order its result by any timeline's values instead of insertion order: the difference between "photos in upload order" and "photos in the order they were taken".

```js
const page = await db.list({
    paths: ['ctx:/house-build'],
    features: ['data/schema/file'],
    sortBy: 'content',
    order: 'asc',
    limit: 50,
});
```

- `sortBy` accepts a timeline name (`'content'`, `'crud:created'`, `'wikipedia'`); a `t:` prefix is tolerated. `order` applies to the timeline value, and ties break by id.
- Interval timelines sort by their **start**; point timelines by the instant.
- Documents with **no value** on the timeline always trail the sorted ones (in id order).
- List only: ranked (`query` / `search`) results keep relevance order.

Sort keys come straight out of the timeline's bit-sliced index. Cost scales linearly with the candidate count, not with corpus size.

## Refining a query over time

See **[Agentic search that refines as it thinks](#agentic-search-that-refines-as-it-thinks)** for the working example. Contract notes:

- **Emit modes**: `delta` (default, `{ added, removed, count }`), `ids`, `page`.
- **Modes**: `frozen` (default) freezes relative timeframes at `add()` and never slides. `live` re-resolves temporal cues on each recompute and pushes `change` events.
- **Precise invalidation**: a write only re-evaluates cues whose `collectionKeys` it touched. Temporal, geo and `rel` cues are `coarse`, so they re-resolve on any relevant write.
- **Lifecycle**: `serialize()` produces tiny JSON (specs and labels, no bitmaps); `QuerySession.rehydrate(db, json)` rebuilds it, re-resolving on first read.
- **`set(label, spec)`** replaces a cue wholesale (upsert). `patch()` merges buckets; a streaming producer re-emitting a full cue every tick must use `set()`, or the merged arrays accumulate forever.

## Semantic search (vectors)

`query()` defaults to `mode: 'hybrid'`: dense-vector kNN fused with BM25 via RRF. The candidate bitmap still scopes retrieval first, and ranking runs only on survivors. `vector` and `hybrid` degrade to `fts` when the dense stack is unavailable, and `list()` (`match = null`) never embeds.

### SynapsD stores vectors, it does not produce them

The whole vector surface: you push chunk vectors in, synapsd namespaces them by *space* (one LanceDB table per model/dim), keeps a durable work-ledger of what still needs embedding, and injects your callback to embed a query string at search time. No model is loaded, downloaded or executed in this process.

- **Document vectors arrive from outside** via `storeDocumentEmbeddings(docId, schema, updatedAt, chunks, { space })`.
- **Query embedding is an injected callback**: `semantic.embedQuery(text, space)`. When absent, `vector` and `hybrid` queries degrade to FTS.
- **The durable work-ledger stays in synapsd**: a per-space "seen" bitmap plus `getUnembeddedDocIds(space, schemas)`: a pure bitmap diff that survives restarts.

### Vector spaces

Vectors live in one LanceDB table per embedding model/dim (a *space*), at chunk granularity (one row per `(docId, chunkId)`):

| Space | Table | Dim | Baseline model | ANN |
|-------|-------|-----|----------------|-----|
| `text` | `vec_text` | 384 | `bge-small-en-v1.5` | yes |
| `image` | `vec_image` | 768 | `Xenova/siglip-base-patch16-224` | **no** |

Ledger bitmaps are **always model-keyed, with the model slug as the leaf**:

```
internal/embed/vectors/<space>/<model-slug>   presence ("this doc has vectors")
internal/embed/seen/<space>/<model-slug>      processed (including deliberate skips)
```

A namespace must never also be a key: `listBitmaps()` range-scans `prefix + '/'`, so a bare `internal/embed/vectors/text` sitting above `internal/embed/vectors/text/<slug>` would be invisible to a prefix query of its own namespace.

The `image` space is **cross-modal**: photos are embedded from bytes, and at query time the *text* query is embedded by the same encoder family into the same joint space. Two consequences baked into the defaults:

- **Exact kNN, no ANN index.** Lance's quantized ANN indexes train on the stored (image) distribution; a text query vector lands outside it and comes back with wildly inflated distances that the relevance floor then rejects wholesale: silent zero results.
- **A cosine-distance floor** (`imageMaxDistance`, default `0.945`, calibrated against SigLIP base fp32) keeps unrelated photos out of every search, since image kNN returns its top-K for *any* query.

### Config and introspection

```js
const db = new SynapsD({
    path: '…',
    semantic: {
        enabled: true,
        dim: 384,
        embedQuery: (text, space) => embedder.embedQuery(text, space),
        embeddableSchemas: ['data/schema/note'],
    },
});
```

| Option (`semantic.*`) | Default | Role |
|-----------------------|---------|------|
| `enabled` | `true` | Open the dense stack; `false` is FTS-only |
| `dim` | `384` | Text-space vector dimension |
| `embedQuery` | `null` | Injected query embedder `(text, space) => vector`; absent → FTS fallback |
| `embeddableSchemas` | `['data/schema/note']` | Default candidate schemas for the unembedded-gap ledger |
| `spaces` | text + image (above) | Per-space `{ table, model, dim, bitmapKey, seenKey, annIndex }` |
| `imageMaxDistance` | `0.945` | Cosine floor for the image kNN leg. Calibrated against **SigLIP base fp32**: the figure is model-specific and must be re-measured for a different image encoder (use `debug: true`). `CANVAS_IMAGE_MAX_DISTANCE` env override; `null`/`0` = no floor |
| `searchWeights` | `{ fts: 2, dense: 1, image: 2 }` | Hybrid RRF fusion weights. FTS outweighs dense because text kNN has no relevance floor; image ties FTS because it *is* floored |

`setSearchTuning({ imageMaxDistance, searchWeights })` adjusts these at runtime. `await db.getStats()` returns a `.semantic` block for diagnostics UIs. Per-space helpers: `setVectorSpaces()`, `listVectorTables()`, `dropVectorTable()`, `clearSpace()`, `optimizeVectors()`.

To bypass the embedding service entirely (media it doesn't cover, precomputed vectors):

```js
await db.storeDocumentEmbeddings(docId, schema, updatedAt, [
    { chunkId: 0, text: 'caption or transcript', vector: [/* dim floats */] },
], { space: 'text' });
```

Query-side vectors use the same candidate resolver and never pass bytes or models into SynapsD:

```js
const hits = await db.searchByVector(queryVector, {
    paths: ['ctx:/work/project-a'],
    features: ['data/schema/file'],
}, {
    space: 'image',
    limit: 50,
    idsOnly: true,
});

const vector = await db.getDocumentVector(documentId, 'image');
```

`searchByVector()` supports structural scope, `excludeIds`, distance bounds, `withDistances`, and `idsOnly`. `getDocumentVector()` enables "more like this" without moving a stored vector through an HTTP API.

## Timelines and intervals

SynapsD supports source/domain timelines (`wikipedia`, `britannica`, `crud:updated`, `content`, `tasks`, `events`) backed by internal scale tiers. The developer-facing name stays simple; internally each timeline owns lazy per-scale tiers for `Gyr`, `Myr`, `Kyr`, `year`, `month`, `day`, `second`, `ms`, and `ns`.

Each stored interval is normalized to `{ scale, start, end }`. If you omit `scale`, SynapsD infers it from the input and errors when it cannot do that safely. No fake precision. Dinosaurs did not have millisecond timestamps, despite what software would like to believe.

### Multi-position timelines

A document can declare **several positions or ranges on one timeline**: a note referencing N eras on `wikipedia`, a recurring event's occurrences on `events`.

```js
timelines: [
  { timeline: 'wikipedia', start: '1769-08-15', ref: 'd1' },
  { timeline: 'wikipedia', start: '1799-11-09', end: '1804-05-18', ref: 'consulate' },
]
```

Two planes back this:

- **Primary interval, dual-BSI.** The first entry (or the one flagged `primary: true`) is the document's canonical sortable value: `sortBy` uses it, and only it. Open-ended intervals are unrestricted.
- **Every other entry, tiled membership plane.** At ingest the interval is decomposed into its minimal hierarchical covering at the entry's own floor. Range queries decompose the same way and union the matching cells. Cell bitmaps hold doc ids, so timeline positions AND natively with context/feature/geo filters.

**Adaptive floor.** The finest cell scale of each covering comes from the entry's own notation: `'1769'` tiles at year cells, `'1769-08-15'` at day cells, `'541 MYA'` at Myr cells, with an explicit `scale` as override. There is **no per-timeline granularity config**: one timeline carries geological eras, lifespans and single events at once, each at its own precision. Precision follows the notation on both sides; you get out the precision you put in.

`ref` is an **opaque anchor** into the document's content. The engine stores and returns it verbatim and never parses it. Distillation (markup → entries) is the app's responsibility. The document stays the source of truth; every timeline plane is L3-derived from `timelines[]`.

App boundary: engine multi-position covers *positions of this document* (distilled dates in a note). Entity-worthy occurrences (a cited study, a referenced event) should be promoted to their own documents with edges to the source. Fan-out beyond a dozen-ish entries is a modeling smell, not an engine limit.

### Storage modes: interval vs point-event

- **Interval (dual-BSI)**: two bit-sliced indexes per tier (`start` and `end`). For ranges that genuinely span time. Overlap query: `start <= range.end AND end >= range.start`.
- **Point-event (single-BSI)**: one bit-sliced index per tier (`ts`). For **instants**. Halves the slice bitmaps *and* the per-insert slice writes.

A timeline is point-mode when its name starts with `crud:` (by convention) or is registered explicitly. The db registers `tasks` (due dates) as a point timeline; `events` is deliberately *not* point-mode, because calendar entries have duration.

```js
const timeline = new TimelineIndex(bitmapIndex, { pointTimelines: ['visited', 'opened'] });
```

The mode is deterministic from the name, so it is stable across restarts without persisting a flag. Queries are identical regardless of mode.

### Open (unbounded) intervals

```js
await db.timeline.insert('life', personId, { start: '1912-12-12', end: Infinity });
await db.timeline.insert('until', id, { start: -Infinity, end: '2000' });
```

Accepted open markers: `Infinity` / `-Infinity`, or the strings `'inf'`, `'+inf'`, `'infinity'`, `'ongoing'`, `'present'` (upper) and `'-inf'`, `'-infinity'` (lower). The scale comes from the bounded endpoint. "Alive in 2026" matches every still-open life automatically.

> For **inserts**, use the object form (`{ start, end }`) for open intervals. Open markers are not supported in the positional `insert(name, id, start, end)` form, where an omitted end means "instant".

On `queryInterval`, a `null` or omitted bound means open on that side:

```js
await db.timeline.queryInterval('life', '1990');         // [1990, +inf)
await db.timeline.queryInterval('life', null, '2000');   // (-inf, 2000]
await db.timeline.queryInterval('life', '2008', '2008'); // bounded point
```

### Multi-timeline retrieval: `grouped` and `layers` (zeitgeist)

`queryInterval` takes one or more timeline names and a query `mode`. See **[The zeitgeist of a birthday](#the-zeitgeist-of-a-birthday)** for the working example.

| `mode` | Shape | Use when |
|--------|-------|----------|
| `union` (default) | `[id, …]` | One flat set |
| `grouped` | `{ name: [ids] }` | Per-source zeitgeist. Scales pre-unioned; every requested timeline is present, empty as `[]` |
| `layers` | `{ name: { scale: [ids] } }` | Same query, keep precision. Only scales that hit are present; non-primary positions land under `multi` |

```js
await db.timeline.queryInterval(
    ['wikipedia', 'britannica', 'personal'],
    { start: '1938-04-12', end: '1938-04-12' },
    { mode: 'grouped' },
);

await db.timeline.queryInterval(
    ['wikipedia', 'britannica', 'personal'],
    { start: '1938-04-12', end: '1938-04-12' },
    { mode: 'layers' },
);
```

Because queries span all scale tiers, a single instant matches a king's reign stored at `year` *and* the geological era stored at `Myr` in the same call.

Canonical calendar and time semantics:

- Proleptic Gregorian calendar internally; astronomical year numbering (`0` = 1 BCE).
- Modern instants are treated as UTC-ish civil time. Leap seconds are ignored: this is a personal/workspace event database, not a spacecraft.
- Deep-time values should use scaled coordinates (`Gyr`, `Myr`, `Kyr`) instead of calendar dates.

### System CRUD timelines

Document lifecycle events are automatically indexed into `crud:created`, `crud:updated`, and `crud:deleted`: **point-event** timelines pinned to **second** resolution.

Formats: `t:crud:ACTION:TIMEFRAME` and `t:crud:ACTION:START..END`.

Supported timeframe tokens: `now` (current hour), `today`, `yesterday`, `tomorrow`, `lastWeek`, `thisWeek`, `nextWeek`, `lastMonth`, `thisMonth`, `nextMonth`, `lastYear`, `thisYear`, `nextYear`, `lastDecade`, `thisDecade`, `nextDecade`, `lastCentury`, `thisCentury`, `nextCentury`, `lastMillennium`, `thisMillennium`, `nextMillennium`.

```js
const recentDocs = await db.list({
    paths: ['ctx:/projects'],
    filters: ['+t:crud:created:thisWeek', '+t:crud:updated:today'],
});
```

### Reserved content timelines

- **`content`**: when the content itself came into existence (EXIF capture date for photos).
- **`tasks`**: due dates (point-mode, derived from `data.dueDate` by the Task schema). `t:tasks:today` means "due today"; `sortBy: 'tasks'` orders by due date.
- **`events`**: `Event` documents (`calendar` / `alert` / `activity`), derived from `data.start` / `data.end`. One timeline for all three leaves; the schema id discriminates (`data/schema/event/calendar`), because the founding query is "show me everything happening under /work/customer-foo".

#### Event recurrence: expansion, with the envelope as fallback

An `Event` carrying an RFC 5545 `data.recurrence` derives its `events` entries in one of two regimes, chosen deterministically from the document alone:

- **Series in the supported RRULE subset** (`FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY` for weekly) are **expanded into per-occurrence entries**. Unbounded and over-cap rules are hybrid: the first 512 occurrences expand exactly, and the un-expanded remainder becomes one never-miss tail entry.
- **Everything else** keeps the **envelope**: first occurrence to `UNTIL`, or open when the rule never ends. The envelope is a deliberate superset: it may over-match, it can never *miss* an occurrence.

Expansion is bounded by the rule (`COUNT`/`UNTIL`), never by wall-clock "now": time-dependent derivation would make rebuilds drift. Exact occurrence rendering stays the client's job either way.

### Custom timelines

```js
await db.timeline.createTimeline('wikipedia');
const timelines = await db.timeline.listTimelines();
const exists = db.timeline.hasTimeline('wikipedia');
await db.timeline.deleteTimeline('wikipedia');

await db.timeline.insert('wikipedia', id, { start: '1720', end: '1720' });              // year
await db.timeline.insert('wikipedia', id, { start: '1720-01', end: '1720-12' });        // month
await db.timeline.insert('wikipedia', id, { start: '1720-01-01', end: '1720-12-31' });  // day
await db.timeline.insert('wikipedia', id, { start: '1720-01-01T00:00:00Z' });           // second
await db.timeline.insert('wikipedia', id, { start: '541 MYA', end: '252 MYA' });        // Myr

await db.timeline.insert('wikipedia', paleozoicId, {
    start: { scale: 'Myr', value: -541n },
    end: { scale: 'Myr', value: -252n },
});
```

Documents can also carry app-extracted timeline entries at the root. SynapsD indexes these on write and refreshes them on update; the database does not extract dates from content.

```js
const articleId = await db.put({
    schema: 'data/schema/document',
    data: { title: 'Magna Carta', text: 'Agreed at Runnymede in 1215.' },
    timelines: [{ name: 'wikipedia', start: '1215', end: '1215' }],
});
```

`name` is the timeline; `timeline` is accepted as an alias. `scale` is optional and inferred when safe. An omitted `end` means "instant"; an explicit `end: null` means an **open** (ongoing) interval. On update, SynapsD removes the document from timelines declared on the old or new document, then indexes the new entries; manually-added entries not declared on the document are left alone.

## Spatial index (S2)

Documents with GPS coordinates (`metadata.geo.lat` / `metadata.geo.lon`) are indexed into a single bit-sliced index over their **S2 cell id** at level 21 (~5 m). Fully derived: coordinates appear and it is indexed; coordinates are removed or the document is deleted and it is dropped. Exact `(0, 0)` is rejected.

Working examples: **[Photos on a map](#photos-on-a-map)**, **[Around me, and what the camera sees](#around-me-and-what-the-camera-sees)**.

S2 ids are hierarchical, so every ancestor cell covers one **contiguous id range** of its descendants. "In cell X" at any zoom level is a single `BETWEEN` range query. A region query runs the S2 region coverer (up to 20 cells) and ORs the per-cell ranges.

```js
const inView = await db.list({
    features: ['data/schema/file'],
    filters: ['geo:bbox:47.5,15.5,48.8,17.8', 't:content:2023-01-01..2023-12-31'],
    sortBy: 'content',
});

const nearby = await db.list({ filters: ['+geo:near:48.1486,17.1077,5km', '!tag/private'] });

await db.geo.queryBBox(minLat, minLon, maxLat, maxLon);
await db.geo.queryRadius(lat, lon, radiusMeters);
await db.geo.queryCells([cellId, …]);
```

Candidate-set semantics are deliberately lossy: coverings may slightly overshoot the region boundary. Precise containment (and rendering) is the client's job via the raw `metadata.geo` coordinates.

## Bitmap index

Roaring bitmaps back every membership lookup. Allowed key prefixes are validated in `src/indexes/bitmaps/lib/keys.js`: `internal/`, `context/`, `vfs/`, `feature/`, `device/`, `client/`, `tag/`, `data/`, `custom/`. See **Features** for the prefix conventions.

> `rel/` is deliberately **absent** from that list. Typed edges live in dupsort adjacency, and keeping the prefix out makes any straggler bitmap write throw instead of silently creating a second, stale relation store.

Notable `internal/*` keys:

| Key | Role |
|-----|------|
| `internal/docs/all` | Live-document membership; makes the "all documents" base O(1) |
| `internal/gc/deleted` | Soft-deleted document set (id free pool) |
| `internal/ts/<timeline>/<scale>/{start,end,ts}` | Timeline BSI tiers (`ts` for point timelines) |
| `internal/geo/s2` | Spatial S2 cell-id BSI slices |
| `internal/lance/fts` | Lance FTS index coverage |
| `internal/embed/vectors/<space>/<model-slug>` | Vector presence per space+model |
| `internal/embed/seen/<space>/<model-slug>` | Embedding work-ledger ("processed") |
| `internal/schemaVersion` | Applied schema version (an internal-store KV, not a bitmap) |

### Introspection (`db.bitmapIndex`)

```js
const keys = await db.bitmapIndex.listBitmaps();
const allKeys = await db.bitmapIndex.listBitmaps('', { includeInternal: true });
const timelineKeys = await db.bitmapIndex.listBitmaps('internal/ts');
const treeLayers = await db.bitmapIndex.listBitmaps(`context/${treeId}`);
```

- **No prefix**: all keys except `internal/*`, unless `includeInternal: true`.
- **With prefix**: range scan under that prefix (`prefix + '/'`), with no extra `internal/*` filtering.

Load a bitmap with `getBitmap(key)`, which returns a `Bitmap` instance with `size`, `has(id)`, `toArray()`, and friends. Find which bitmaps contain a document via `getBitmapsForDocument(id, prefix?)` on the main `db` object.

## Trees

```js
const meta = await db.createTree('projects', 'context');
const fsMeta = await db.createTree('filesystem', 'directory');

const trees = await db.listTrees();
const contextTrees = await db.listTrees('context');

const tree = db.getTree('projects');
const defaultCtx = db.getDefaultContextTree();
const defaultDir = db.getDefaultDirectoryTree();

await db.renameTree('projects', 'workspaces');
await db.deleteTree('workspaces');

db.getTreePaths('filesystem');
db.getTreeJson('projects');
```

### Staging pattern (consumer convention)

SynapsD has no built-in concept of "incoming" or "staging". If your app needs one, create a dedicated tree and use `link` / `unlink` to promote documents:

```js
await db.createTree('incoming', 'directory');

const id = await db.put(
    { schema: 'data/schema/message/email', data: { subject: 'Invoice', from: 'billing@example.com' } },
    { directory: { tree: 'incoming', path: '/email/imap/account-a/inbox' } },
);

await db.link(id, { context: { tree: 'projects', path: '/finance/invoices' }, features: ['tag/triaged'] });
await db.unlink(id, { directory: { tree: 'incoming', path: '/email/imap/account-a/inbox' } });

const docs = await db.list({ paths: ['!ctx:/staging'] });
```

Tree metadata lives in the internal store; tree memberships map to typed bitmap namespaces.

## Datasets

Datasets are path-independent ingest provenance: a `data/dataset/<name>` key stamped at ingest via `spec.features` (and preserved on the row across updates that omit it).

They get their own algebra bucket in `resolveCandidates`. Every document implicitly belongs to a **virtual `default` dataset** (= stamped with none), and the candidate set is intersected with the union of *selected* datasets, with `default` selected to begin with:

- `anyOf data/dataset/X` - **adds** X to the mix.
- `allOf data/dataset/X` - shows only X (the ordinary feature AND constrains).
- `noneOf data/dataset/X` - deselects X.

`anyOf`/`noneOf` dataset keys are pulled out of the generic feature buckets, because a plain OR-union would let dataset documents bypass the caller's other feature filters.

```js
await db.listDatasets();                              // [{ name, key, documentCount }]
await db.deleteDataset('scan-2026-08', { dropDocuments: true });
```

## Schema version and rebuild

**There is no migration code in this engine.** One-time migrations were living on the startup path, gated behind a persisted version, running an `O(all-docs)` check on every open for work that happens once in a database's life. They are operator actions; write a one-off script against a backup instead.

What stayed is the **refusal**. `SCHEMA_VERSION` (currently **4**) is the row format this build writes; a *non-empty* database below it throws at `start()`:

```
synapsd: database is at schema v3, this build needs v4. Migration code was removed
from the engine; migrate the database with a one-off script against a backup, then
stamp internal/schemaVersion to 4.
```

A brand-new or empty database is stamped and skips the refusal. Bump `SCHEMA_VERSION` when a change makes rows written by this build unreadable by the previous one.

The one-off script for the current version is **`scripts/migrate-schema-v4.js`** (run **`scripts/migrate-schema-v3.js`** first if the database is still below v3):

```bash
node scripts/migrate-schema-v4.js -d <workspace>/db [--dry-run]
node scripts/migrate-schema-v4.js --users-root <server>/server/users   # every workspace at once
```

It folds `data.type` into the schema id for Event / Identity / Application / Dotfile, stamps the version **last**, then reopens and runs `rebuildL3()`.

### `rebuildL3()`

The rebuild invariant made executable. It composes the existing reindexers rather than paralleling them.

```js
await db.rebuildL3();                                   // edges + bitmaps (defaults)
await db.rebuildL3({ src: 'extractor:ner' });           // only that extractor's derived edges
await db.rebuildL3({ timelines: true, search: true });  // + crud timelines, + FTS
```

| Option | Default | Effect |
|--------|---------|--------|
| `edges` | `true` | Drop and re-derive edges. With `src`, only that source's derived edges; without it, the whole edge plane is cleared |
| `bitmaps` | `true` | Drop and re-derive every derived namespace (see below); also drops the retired `data/kind/*` and `data/abstraction/*` one-way |
| `timelines` | `false` | `reindexCrudTimelines()` |
| `search` | `false` | `reindexSearchIndex({ rebuild: true })` |
| `embeddings` | `false` | `reindexEmbeddings()` (expensive) |

The set it drops is the set `Document` strips on write — `data/schema/*`, `data/mime/*`, `data/backend/*`, `device/*`, `feature/*`, plus each schema's own `data/<facet>/*` — for one reason: a namespace the engine derives is a namespace no row can assert, so rows are its only source and the rebuild owns all of it. Miss one and the rebuild returns `stale ∪ derived(rows)` rather than `derived(rows)`, because the replay only ticks; the drift it was run to repair survives it. `tag/*`, `custom/*`, `client/*`, and `data/dataset/*` are left alone, since `link()` ticks those without the row saying so.

`derivedBitmapPrefixes()` is exported for that reason. `tests/rebuild-l3.test.js` seeds one document per derived namespace, ticks a nonexistent id into every resulting bitmap, rebuilds, and expects the plane back byte-identical.

Targeted reindexers remain available: `reindexCrudTimelines()`, `reindexMimeBitmaps()`, `reindexSearchIndex()`, `reindexEmbeddings()`.

## Events (`src/utils/events.js`)

Event names live in the frozen `EVENTS` map. Rename a constant there to rename the string everywhere consumers match on.

**Lifecycle**: `started`, `beforeShutdown`, `shutdown`

**Document CRUD**: `document.inserted`, `document.updated`, `document.removed`, `document.deleted`

**Batch variants** - one event per bulk op, so a 1000-doc insert does not fan out into 1000 socket emits: `document.inserted.batch` (`{ ids, count, context, directory }`), `document.updated.batch`, `document.removed.batch`, `document.deleted.batch`. Insert/update batches *also* emit the singular event once with `{ ids, batch: true }`. Batch-aware consumers should match on the `.batch` names.

### `reason`: what changed

Every `document.*` event carries a `reason` from a closed set (exported as `DOCUMENT_EVENT_REASONS`):

| `reason` | fires on | carries `document` |
|---|---|---|
| `created` | `document.inserted[.batch]` | yes (singular) |
| `content` | `document.updated[.batch]`: the document itself changed | yes (singular) |
| `membership` | `document.linked`/`unlinked`, and the deprecated membership forms | first-class events only |
| `deleted` | `document.deleted[.batch]` | no |

`document.updated` fires for **both** `content` and `membership`, and only the content form carries the document. `batch` is an orthogonal axis: it describes payload *shape* (`ids` vs a document), not what changed.

### Membership events

- `document.linked` / `document.unlinked` (+ `.batch`): the first-class membership events. The singular forms carry the **full document**; the batch forms carry `{ ids, count }`.
- Both sides carry the delta in **`changed`**, normalized to path arrays:

  ```js
  changed: { context: ['/inbox'], directory: [], features: ['tag/urgent'] }
  ```

  It is a **delta**: the placements this operation added or removed, never the document's full placement. "Is this filed under /x" is *state*: read the bitmaps, do not infer it from an event. A recursive unlink reports every prefix it dropped: `['/a', '/a/b', '/a/b/c']`.
- `membership.changed`: emitted post-commit with the exact collection bitmap keys ticked or unticked: `{ changes: [{ docId, op: 'tick'|'untick', keys }] }`. Drives precise live invalidation in `QuerySession`. Fires before the corresponding `document.*` event.

> **Deprecated**, removal scheduled for the next major: `link`/`unlink` also emit membership-only `document.updated` / `document.removed` for consumers predating `document.linked`/`unlinked`. Prefer `changed`.

**Tree management**: `tree.created`, `tree.deleted`, `tree.renamed`
**Tree path**: `tree.path.inserted|moved|copied|removed|locked|unlocked`
**Tree layer**: `tree.layer.merged|subtracted|converted|updated`
**Tree document**: `tree.document.inserted[.batch]`, `tree.document.removed[.batch]`, `tree.document.deleted[.batch]`
**Tree lifecycle**: `tree.recalculated`, `tree.saved`, `tree.loaded`, `tree.error`
**Datasets**: `dataset.deleted`

Payloads are wrapped with `SynapsDEvent` (helpers `createEvent` / `createTreeEvent`). The envelope always carries `event`, `eventId` (usable as an idempotency key), `source`, an ISO `timestamp`, the **provenance** triple (`origin`, `causedBy`, `depth`), and `treeId`/`treeName`/`treeType` on tree-scoped events. That triple is what lets automation bound its own cascades.

## Errors (`src/utils/errors.js`)

`SynapsDError` is the base class (correct `name`, captured stack). Specialized types:

| Class | Extra fields |
|-------|--------------|
| `ValidationError` | `details` |
| `NotFoundError` | `id` |
| `DuplicateError` | `id` |
| `DatabaseError` | `operation` |
| `ArgumentError` | `argument` |

## API reference

Legacy method names like `findDocuments`, `ftsQuery`, and `insertDocument` are no longer the intended API and should be treated as dead.

### Reads

| Method | Notes |
|--------|-------|
| `get(id, options?)` | `options = { parse }` |
| `query(match, spec?)` | `match: string \| { text }`; ranked when `match` is set |
| `list(spec?)` | Equals `query(null, spec)`; structural listing, no ranking |
| `search(spec)` | Wrapper: `query(spec.query ?? spec.search ?? spec.q, spec)` |
| `searchRefined(queries[], baseSpec?, opts?)` | Stateless multi-query refinement; `opts = { limit, offset, mode }` |
| `searchCompound(lines[], opts?)` | Fuses per-line rankings instead of chaining them |
| `searchByVector(vector, spec?, opts?)` | Rank a structurally scoped candidate set with a caller-supplied vector |
| `getDocumentVector(id, space?)` | Read one stored document vector for similarity queries |
| `openSession(specs?, opts?)` | Long-running refinable/live query session |
| `getByChecksumString(checksum, options?)` | `options = { parse, schema }` |
| `has(id, spec?)` / `hasByChecksumString(checksum, spec?)` | Membership probe, no document fetch |
| `resolveCandidates(spec)` | Candidate-set stage: `{ bitmap, keys, collectionKeys, coarse }` |
| `rank(bitmap, match, opts?)` | Materialize/score stage |
| `listTreeDocuments(treeNameOrId, options?)` | |

### Writes

| Method | Notes |
|--------|-------|
| `put(document, spec?)` | Creates or updates; returns the numeric id |
| `putMany(documents, spec?)` | |
| `putManyDirectoryPaths(items, treeName, features?, options?)` | Bulk directory-tree ingest |
| `link(idOrIds, spec?)` / `linkMany(ids, spec?)` | Membership only |
| `unlink(idOrIds, spec?)` / `unlinkMany(ids, spec?)` | Membership only; document stays |
| `delete(id, options?)` / `deleteMany(ids, options?)` | Removes the row and all index entries |
| `relate(from, p, to, opts?)` / `unrelate(from, p, to)` | Typed edges; `opts = { meta, inheritMemberships }` |

### Trees and schemas

`createTree(name, type?, options?)`, `listTrees(type?)`, `getTree(nameOrId)`, `deleteTree(nameOrId)`, `renameTree(nameOrId, newName)`, `getTreePaths(nameOrId)`, `getTreeJson(nameOrId)`, `getDefaultContextTree()`, `getDefaultDirectoryTree()`, `listDocumentTreePaths(id, tree)`, `listDocumentTreeMemberships(id, tree)`, `hasDocumentTreeMembership(id, tree)`, `migrateDocumentMemberships(fromId, toId, opts?)`

`listSchemas(prefix?)`, `getSchema(id)`, `hasSchema(id)`, `getDataSchema(id)`, `getJsonSchema(id)`. Registration itself goes through the `schemaRegistry` singleton (`registerSchema` / `unregisterSchema` / `getSchemaEntry` / `resolveSchemaId`).

### Maintenance and introspection

| Method | Notes |
|--------|-------|
| `getStats()` | Async stats including FTS and dense-vector internals |
| `setSearchTuning(tuning)` | `{ imageMaxDistance, searchWeights }` at runtime |
| `storeDocumentEmbeddings(docId, schema, updatedAt, chunks, opts?)` | Externally-computed vectors; `opts = { space }` |
| `getUnembeddedDocIds(space?, schemas?)` | Embedding work-ledger; pure bitmap read, restart-safe |
| `rebuildL3(opts?)` | Umbrella L3 rebuild (see **Schema version and rebuild**) |
| `reindexCrudTimelines(opts?)` | `{ scanned, created, updated }` |
| `reindexSearchIndex(opts?)` | Backfill or rebuild FTS, idempotent |
| `reindexEmbeddings(opts?)` | Reports the embedding gap for an external embedder |
| `reindexMimeBitmaps(opts?)` | Rebuild derived `data/mime/*` facets |
| `listDatasets()` / `deleteDataset(name, opts?)` | |
| `dumpDocuments(dstDir, …)` / `dumpBitmaps(dstDir, keys?)` | |

Sub-index handles: `db.timeline`, `db.geo`, `db.bitmapIndex`, `db.checksumIndex`, `db.synapses`, `db.edges`, `db.semantic`, `db.internalStore`.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/reindex-crud.js -d <db-dir>` | Rebuild the `crud:*` timelines |
| `scripts/scan.js` | Recursively scan a directory into a DB, or query it (see `scripts/scan.readme.md`) |
| `scripts/bench-putmany.js`, `scripts/bench-tick-bitmaps.js` | Write-path benchmarks |

## Known limits

- **`rel` is one hop.** Multi-hop traversal is deliberately out of scope.
- **`g:`/`re:` filters** are recognised but unimplemented, and throw at parse time.
- **Sigil consistency for raw bitmap keys**: raw keys in `filters` AND together, while `t:`/`geo:` tokens default to anyOf-OR. Known inconsistency, to be resolved in one sweep.
- **Recipient edges** (email To/Cc → identity) are deferred: the role is distinct from authorship and cannot live in edge meta without colliding with the asserted-edge convention. `data.to`/`data.cc` stay ordinary fields until the reverse query is actually wanted.
- **`link()` features are bitmap-only** and do not survive an L3 rebuild. Put durable tags on the document.

## References

- [LMDB Documentation](http://www.lmdb.tech/doc/)
- [Roaring Bitmaps](https://roaringbitmap.org/)
- [LanceDB](https://lancedb.com/)
- [S2 Geometry](https://s2geometry.io/)
- [RFC 5545 (iCalendar)](https://datatracker.ietf.org/doc/html/rfc5545)
- [Why-not-indices](https://stackoverflow.com/questions/1378781/proper-terminology-should-i-say-indexes-or-indices)

## Licence

Copyright (C) 2025-2026 Jozef Melich. Canvas SynapsD is dual-licensed:

- **[AGPL-3.0-or-later](LICENSE)**, free for everyone. Run it, modify it, build
  on it. If you distribute a modified version, or expose one to users over a
  network, they are entitled to your changes (AGPL section 13).
- **[Commercial licence](COMMERCIAL.md)**, the same code without the copyleft
  obligations, for hosted products and proprietary distribution. Issued by
  Augmentd s.r.o., lic@augmentd.eu.

Same software either way. There is no cut-down community edition. See
[NOTICE](NOTICE) for the full position, and [CONTRIBUTING.md](CONTRIBUTING.md)
before opening a pull request.

---
This project is funded by [Augmentd Labs](https://augmentd.eu/en/labs)
