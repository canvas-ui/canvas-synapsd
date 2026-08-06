# Commercial licensing: Canvas SynapsD

Canvas SynapsD is dual-licensed, on the same terms as the rest of the Canvas server
runtime.

**Option 1, AGPL-3.0-or-later.** Free, no agreement needed, nobody to ask. Use
it, modify it, deploy it, sell services around it. The condition is reciprocity:
if you distribute a modified version, or let users interact with one over a
network, those users get the corresponding source of your modifications. See
[LICENSE](LICENSE) and [NOTICE](NOTICE).

**Option 2, a commercial licence.** The same code, without the AGPL's
reciprocity obligations, for cases where option 1 does not fit.

Both options cover the same software. There is no cut-down community edition and
no feature held back for paying customers. The AGPL version is the whole product.

## Scope

A commercial licence covers the dual-licensed Canvas components: the server
runtime (`canvas-server`, including the embedding, messaging, voice and agent
services), `canvas-synapsd`, `canvas-stored`, `canvas-neurald` and
`canvas-web`.

It does not cover the standalone Canvas clients: the CLI, the shell client, the
FUSE client, the desktop app and the browser extensions. Those are AGPL-only for
everyone, commercial licensees included.

## When you need option 2

You probably need a commercial licence if you are:

- **Building a hosted or SaaS product on Canvas** and not publishing your
  modifications. This is the common case. Section 13 of the AGPL applies as soon
  as users reach your modified version over a network. Internal-only deployments
  are fine; customer-facing ones are not.
- **Embedding Canvas in a proprietary product** that you distribute.
- **Unable to accept copyleft** for policy, procurement or investor-diligence
  reasons, and needing a licence you can show your counsel rather than an
  argument about where the boundary of a derivative work falls.

You do not need one to run Canvas internally, self-host it for your own team,
evaluate it, contribute to it, or build on it while publishing your changes
under the AGPL.

## Not sure whether you comply?

Ask. An email costs nothing, and it is a much smaller problem to solve now than
after the fact. If you are already running a modified Canvas in production and
have not published the changes, say so. The usual outcome is a licence, not a
dispute.

## Getting one

Email **lic@augmentd.eu** with roughly:

- what you are building, and how Canvas fits into it
- whether you are distributing it, hosting it, or both
- which components you use (server, SynapsD, StoreD, NeuralD, the web UI)
- rough scale, in seats, instances or end customers

Terms are negotiated per case and there is no public price list yet. Licences
are issued by:

    Augmentd s.r.o.
    DUETT Business Center
    Námestie Osloboditeľov 3/A
    040 01 Košice, Slovakia
    Company ID: 45331936
    VAT ID: SK2022968717
    https://augmentd.eu

Copyright in this codebase is held by Jozef Melich. Augmentd s.r.o. holds an
exclusive licence to it, including the right to grant sublicences, and is the
entity authorised to issue commercial licences for Canvas.

Because copyright in the Canvas codebase sits with one author and is not spread
across many contributors, this offer can be made at all. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how that is kept true.

> This document sets out the licensing options and invites you to discuss terms.
> It is not itself a licence grant, an offer capable of acceptance, or legal
> advice. Only a signed agreement grants commercial rights.
