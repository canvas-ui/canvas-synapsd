# Contributing to Canvas SynapsD

Contributions are welcome, and bug reports, fixes and tests especially. Canvas
is a work in progress, and the parts that get used are the parts that get good.

## Before you open a pull request

**You will be asked to sign the [CLA](CLA.md).** It is a one-time thing and
covers all your future contributions to the dual-licensed Canvas repositories.
Comment on your first pull request with:

```
I have read the CLA document and I hereby sign the CLA.
```

If you are contributing on behalf of an employer, make sure whoever can bind
them has agreed. See section 6 of the CLA.

## Why a CLA here, and not just a DCO

This repository is dual-licensed: AGPL-3.0-or-later for everyone, plus a
commercial licence for those who cannot accept copyleft (see
[COMMERCIAL.md](COMMERCIAL.md)). The second option exists only while the
copyright holder actually has the right to license the whole codebase under
terms other than the AGPL.

A Developer Certificate of Origin does not provide that right. A DCO certifies
where your code came from and that you may submit it. It grants nothing beyond
the project's existing licence. If contributions arrived under a DCO alone, each
one would become a permanent veto over commercial licensing, and the option would
quietly disappear as the project grew.

The CLA is the narrowest instrument that keeps that door open. **You keep
copyright in your contribution.** It is a licence grant rather than an
assignment, so you can relicense your own work elsewhere, reuse it, or publish
it independently.

Section 4 of the CLA is the commitment in the other direction: every
contribution stays available under the AGPL. Commercial licensing cannot be used
to take the open version away.

**The Canvas clients ask for no CLA.** The CLI, shell client, FUSE client,
desktop app and browser extensions are AGPL-only, so nothing there is ever
sublicensed and a DCO sign-off is enough. If the CLA is what stops you, those
repositories are open to you on lighter terms.

## Practical notes

- **Discuss large changes first.** Open an issue before a big refactor.
- **Match the surrounding code.** Comment density and naming vary by module, so
  follow the file you are in.
- **Open the pull request against this repository**, not against
  `canvas-server`. Canvas components are separate repositories under
  [github.com/canvas-ui](https://github.com/canvas-ui).
- **Leave the source notices alone.** The `X-Source-Code` header and the licence
  fields in `/rest/v2/ping` implement section 13 of the AGPL and need to stay.

## Reporting security issues

Please do not open a public issue for a vulnerability. Email **security@augmentd.eu**.

Questions about contributing: **contrib@augmentd.eu**
