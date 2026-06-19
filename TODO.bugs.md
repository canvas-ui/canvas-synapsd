Here's the cleanup list, ranked so you can stop at whatever line your patience runs out. File refs included.

**Fix before either MVP ingest run**
- [x] `untick` (single) in `indexes/bitmaps/index.js`: add the size-change guard `untickMany` already has — currently re-serializes+writes a full slice bitmap even when nothing changed.
- [x] `BitSlicedIndex.setValue`: stop clearing zero-bits on first insert (only untick on overwrite); ideally batch the 64 slice writes. Together with the line above this is the timeline write-amplification killer for the wikipedia pass. *(first-insert untick skip done; 64-write batching still TODO)*
- [x] In-batch content dedup in `putMany` and `putManyDirectoryPaths` (`index.js`): add a `Map<primaryChecksum, preparedEntry>` across the prepare loop; on a hit, merge path/location into the existing entry instead of minting a new id. Today two identical files in one batch fork into two docs and the checksum index keeps only the last → corrupts the one-blob-one-doc model on NAS.

**Scaling / cost cliffs**
- [x] Cap `list()` default `limit` (it's `0` = unlimited → parses every row); document "all docs" as an explicit opt-in, not the default. *(default now DEFAULT_LIST_LIMIT=100; explicit `limit:0` = all. UI defaults 200, browser ext configurable — OK.)*
- [x] Gate `#migrateRootBitmaps()` / `#migrateBitmapKeys()` behind a stored schema-version flag — they run an O(N) all-docs transaction on *every* startup. *(`#migrateBitmapKeys` gated behind SCHEMA_VERSION. `#migrateRootBitmaps` + `#buildContextRootSourceBitmap` REMOVED — obsolete; both pre-prod setups already migrated. 2 repair tests dropped.)*
- [ ] Audit the `#buildAllDocumentsBitmap()` callers (`noneOf`-only features, `excludeTree`, `excludeContext`, root-source) — each is a full scan; at least short-circuit when the positive set is already bounded. *(deferred: needs design.)*
- [ ] Lift `indexOptions` (esp. `embeddingOptions`) out of per-document `toJSON()` to schema level — it's GBs of identical config across 7M rows. *(deferred: aim for per-abstraction indexOption config, not per-doc storage; needs design + back-compat sign-off.)*
- [x] Replace `getBitmapsForDocument`'s scan-all-bitmaps with the synapse reverse index (`listSynapses`).

