# Engine refactor validation

The refactor preserves the public facade while moving ownership into services.
Coverage is measured against executable code; passing the entire test suite is
separate evidence from reaching a particular line/branch percentage. Native
storage crash recovery and every possible external-I/O failure are not simulated
by these tests.

## Regression matrix

| Contract | Main tests |
| --- | --- |
| Single/batch/directory insert derivations, dedup and deferred search | `write-pipeline`, `write-adapters`, `email-dedup`, `update-id-preservation` |
| Failed insert/update/delete, cached trees/bitmaps, queued writes and events | `tick-rollback`, `query-and-membership`, `write-pipeline` |
| Stable ID allocation, safe reuse, external cleanup failures | `document-id-gc`, `write-adapters` |
| Detached before state, stale checksums, location/backend changes | `document-snapshot`, `backend-features`, `update-id-preservation` |
| Asserted versus derived edges, incoming retractions, row/edge rollback | `relations`, `write-pipeline`, `tick-rollback` |
| Tree selectors, links/unlinks, default selection and metadata persistence | `write-adapters`, `tree-registry`, `tree-settings-and-linked-query`, `canvas-tree-semantics` |
| Rebuild equivalence, queued maintenance, retry and batch bounds | `rebuild-l3`, `maintenance-coordination` |
| Device/location/facet derivations and restore outside default dataset | `device-presence`, `backend-features`, `maintenance-coordination` |
| Serialized lifecycle transitions, draining writes, restart, failure recovery | `engine-lifecycle` |
| Session invalidation and shutdown cleanup | `query-session`, `engine-lifecycle` |
| Vector model swaps, ledger/table isolation, restart and search | `vector-spaces`, `vector-provenance`, `embedding-ledger`, `search-by-vector`, `search-refined` |
| Early refusal of incompatible on-disk schema | `schema-version-gate` |

Public method/getter signatures are also compared structurally against commit
`fe1ebe4`: all 97 signatures, defaults, and async flags are retained.

## Reproduce

From `canvas-synapsd`:

```sh
npm test -- --runInBand --coverage \
  --collectCoverageFrom='src/index.js' \
  --collectCoverageFrom='src/write/*.js' \
  --collectCoverageFrom='src/maintenance/*.js' \
  --collectCoverageFrom='src/lifecycle/*.js' \
  --collectCoverageFrom='src/session/QuerySession.js'
```

The default test suite also exercises the query, tree, vector, schema, and native
index implementations. The collection filters above focus coverage measurement
on the final write/maintenance/lifecycle refactor; they do not filter the tests.

## Boundaries that remain explicit

- LMDB transaction rollback does not roll back external Lance storage. Search
  cleanup must succeed before deleted IDs become reusable.
- Collection bitmap flushes remain best-effort after native commit. A failed flush
  is repairable; it is not reported as a rollback of already committed rows.
- Repair jobs exclude queued writers, but span multiple batches and storage
  systems. An interrupted job may need to be rerun.
- Low-level exposed handles and synchronous administrative operations bypass the
  queue. The suite does not establish read isolation from in-flight cache changes.
- Existing single/batch search and event-order differences remain deliberate
  compatibility adapters for the upcoming API review.

## Measured coverage

The full run passed **67 suites / 532 tests**. Coverage scope and percentages:

| Scope | Lines | Functions | Branches |
| --- | ---: | ---: | ---: |
| Lifecycle coordinator | 100% | 100% | 100% |
| Write services | 93.84% | 97.43% | 77.66% |
| Maintenance | 91.44% | 80% | 61.66% |
| QuerySession | 85.44% | 75% | 61.34% |
| Remaining facade | 72.67% | 82.79% | 51.3% |
| All measured files | 86.97% | 87.46% | 67.14% |

The larger facade gap includes schema-validation wrappers, dump/admin helpers,
low-level clear methods, and some tree-membership convenience queries. Write
service gaps include malformed legacy inputs and uncommon failure branches.
These percentages do **not** represent 100% coverage of the whole engine. The
regression matrix records the behavior covered by the refactor's tests.
