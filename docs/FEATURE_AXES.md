# Derived feature axes: design notes

Why the derived bitmap axes are shaped the way they are. The README documents
what they *do*; this is the reasoning, the rejected alternatives, and the traps.
Read it before adding an axis or changing an existing one.

## `data/backend/*` — the addressing mode

Derived from `locations[]`. SynapsD parses each URL into scheme + authority and
knows nothing about specific backends.

**No scheme is exempt**, including `file://` and `device://`. They were skipped
until 2026-08-25 on the grounds that `device/id/*` already answered "where do
these bytes live", which conflated two questions: `data/backend/*` is the
*addressing mode* (how the bytes are reached) and `device/*` is the *machine*
(which box, and what it is). Keeping them separate makes "loose local files with
no managed copy" a plain intersection, `data/backend/file AND NOT
data/backend/stored`, which is what a backup sweep wants. Under the old rule that
set was not expressible.

`metadata.backend` overrides the URL for the case where the URL lies: a NAS
mounted at `/mnt/nas` is addressed `file://<deviceId>/mnt/nas/…` but the bytes
are not on that device. The declared name is flat, so it lands where schemes
otherwise sit, which is harmless while the two vocabularies do not collide.

## `device/*` — the machine

Anchored on `device/id/<deviceId>`, the union of a device's `file://` and
`device://` locations. That union is why the id survives the rule above rather
than being made redundant by it: `data/backend/file/<id>` and
`data/backend/device/<id>` are two keys for one machine, and `device/id/<id>` is
the one that means "present on that box" regardless of how it is addressed.

Everything past the id is optional enrichment, present only if the app registered
a Device document. An unregistered device contributes its id and nothing else;
the facets appear once the Device row lands and the reconcile runs.

### The OS chain is not enforced

Requiring `linux/<distro>/<version>` needs a registry of which families have
which tiers. That registry is wrong the first time someone turns up with a
buildroot image, and useless for that case anyway: a custom distro reports an ID
in `/etc/os-release` like any other and already lands correctly as
`device/os/linux/iolinux/1.2`. The generic rule covers the exotic case; the
registry would only exist to police the degenerate one.

The degenerate case is a client reporting a version with no distro, which yields
`device/os/linux/24.04`. That key is inert, because nobody queries a key they
cannot construct, and it means the client is broken. Surfacing a broken client
beats rejecting its write or silently discarding the version it did report.

What *is* enforced is **arity**: a tier cannot contain `/`, so `osDistro:
'ubuntu/core'` folds to `ubuntu_core` instead of quietly becoming two tiers and
shifting the version into a fourth. That rule needs no registry, which is exactly
why it is the one worth having.

An empty tier is skipped rather than reserved, so families with no distro get a
shorter chain (`device/os/mac/15.2`). The alternative, truncating everything below
a gap, would deny Windows a version tier — and "which boxes are still on Windows
10" is the same operational question as "still on 22.04".

`device/arch/*` uses `os.machine()` vocabulary (`x86_64`, `aarch64`) rather than
`os.arch()` (`x64`, `arm64`) because the former is what flatpak, snap and appimage
publish against. A device facet and a package's capability then compare directly
with no translation table.

### Device documents tag themselves

A Device row carries its own `device/id|os|arch|type` keys via
`Device.getFeatureBitmapArray`, which is what makes `data/schema/device AND
device/os/linux/ubuntu/24.04` a fleet query rather than a scan.

These are *derived*, not asserted by the caller, and the specific reason matters:
`rebuildL3` drops the whole `device/` namespace and replays it from `locations[]`,
which a Device row has none of pointing at itself. Asserted self-tags were
bitmap-only, so a rebuild deleted them with nothing to put them back. Routing them
through the facet plane buys the replay and the stale-untick together. This was a
live bug (`canvas-server` `core/device/Registry.js` asserted them) fixed
2026-08-25; the regression test is in `tests/device-presence.test.js`.

### Reconciling a changed device

The accepted cost of deriving facets into stored bitmaps, rather than expanding
them at query time, is drift: reinstall a laptop and every document on it carries
a stale tag. `#syncDeviceFacets` closes that at the only moment it can open, and
the `device/id/<x>` bitmap names the affected set exactly, so the repair is
proportional to that one device rather than the corpus.

It is a set difference over the device's previous and current key list, so it
needs no per-facet knowledge: an in-place distro upgrade retires
`device/os/linux/ubuntu/22.04` and keeps the two tiers above it. Recomputation is
per document rather than a blanket key swap, because a document may sit on several
devices and another of them may still legitimately imply the old facet.

## `data/platform/*` — capability

The counterpart to presence: `installs` says which boxes have an app,
`data.platform` says which boxes could run it.

`<os>/<arch>` matches the device vocabulary deliberately, so the two axes compare
without a translation table. There is **no distro tier**: glibc, not the distro
name, is usually what actually decides, and `linux/ubuntu/24.04/x86_64` explodes
combinatorially for a discrimination almost nothing needs. If that proves wrong in
practice, the fix is a second independent facet (`data/runtime/glibc/2.35`) rather
than a longer platform string — the constraints are orthogonal and intersect for
free. Either change costs one `rebuildL3`.

An app declaring no platform lands in no capability bitmap. Absence is *unknown*,
not *everywhere*: an undeclared app fails a filter it was never checked against
rather than passing one silently.

### Indexing applications is opt-in, per workspace

A client enumerating local applications MUST let the user choose which to index,
and MUST ask per workspace. The same machine's work and personal apps belong in
different workspaces, and a user who indexed Steam into `personal` has not asked
for it in `work`.

Nothing in the engine enforces this and nothing can: a workspace is its own
database, so "not indexed here" and "does not exist" are the same observation from
inside. The selection has to be correct at the point of capture, and the only
repair for an over-eager sweep is deleting documents the user never wanted.

Consequence: the same app in two workspaces is two documents with two ids and two
independent `installs` maps. Dedup is per-database, so they will not merge, and
"is Slack installed on this laptop" is answered per workspace rather than globally.
That is the intended behaviour — the split exists to stop personal context
surfacing during customer work — but it is a real constraint on cross-workspace
questions.

## `feature/orphaned` — the lifecycle stamp

`orphanedAt` set and `locations[]` empty. It answers "this document had a
resolvable copy and lost it" (stored resync, connector prune, destroy-keep), which
is what the UI filter and the retention GC both want. The empty-locations half
unticks the key on re-bind; `orphanedAt` stays the retention clock, and the bitmap
is exactly the GC candidate set.

Three things it deliberately is not:

- **Not schema-derived.** A per-schema "owns locations" flag cannot answer this
  for Task: one typed into Canvas is complete without a copy, one mirrored from a
  deleted GitHub issue is not. Same schema, opposite answers, because the
  discriminator is per-row provenance.
- **Not "has no locations".** That set is most of the database (every note, every
  local task) and nothing materializes it. Bitmaps earn their keep on selective
  predicates.
- **Not "has no backend".** Every located document ticks something under
  `data/backend/*`, so that set is just "has no locations" again. The orphan key
  stays out of the `data/backend/` namespace because it is not an addressing fact
  at all: it is a lifecycle stamp that happens to be readable as one.

A File with no bytes and no orphan stamp is a broken row rather than an orphan.
Different alert, and it would want its own key: `data/schema/file` intersected
with an empty-locations bitmap, minus this one.

## Adding an axis

`rebuildL3` drops every derived namespace and replays it from rows. The two halves
must stay symmetric:

- Anything **dropped** must be reproducible by `#replayDerivedPlane`, or a rebuild
  destroys it.
- Anything **derived** must be in the drop list, or a rebuild computes `stale ∪
  derived(rows)` and silently preserves the drift it was run to repair.

Both lists are computed from `DERIVED_FEATURE_PREFIXES` and the schema registry
rather than hardcoded, so a new axis inherits the symmetry. The sweep in
`tests/rebuild-l3.test.js` asserts every derived namespace has at least one key in
its fixture before testing, so adding an axis without seeding it fails loudly
rather than passing over nothing.
