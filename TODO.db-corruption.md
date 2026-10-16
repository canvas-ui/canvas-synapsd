# TODO: investigate LMDB corruption

2026-10-16 — **Open; root cause unknown.** The dependency update and backup
changes are recovery measures, not a demonstrated corruption fix.

## Incident and evidence

- Universe failed during normal ingestion: approximately 200 broken `File NNNNNN`
  documents were deleted through the web UI (1–2 minutes), then
  `canvas-fuse sync push ~/Canvas/Workspaces/Universe` restored local files to
  `workspace:home` while FUSE ran in `--mirror --protected` mode. After roughly
  20 minutes, requests returned 502 and the workspace could no longer start.
- Augmentd also had ongoing ingestion from three IMAP mailboxes. Neither a
  forced restart nor the ZFS rollback is established as the cause.
- The supplied Augmentd database contains active page references beyond EOF;
  compact-copy probes crash with SIGBUS. LMDB 3.5.7 and `safeRestore` do not
  repair it. All seven supplied October 15 backups were incomplete (84 KiB).
  The latest validated backup is `20261014.2` (4,244 documents).
- The supplied Universe copy passes local traversal, compaction and SynapsD
  startup (11,486 documents). Its production failure remains unreproduced;
  do not assume it shares Augmentd's failure mode.
- FUSE recovery sends sequential HTTP uploads; it does not write server LMDB
  directly. No explicit database-file truncation was found in document deletion.

## Changes awaiting operational testing

- SynapsD 3.24.0 uses LMDB 3.5.7.
- Checkpoints wait for complete writes, copy and verify in child processes,
  publish only after success, and retain 24 hourly / 14 startup backups.
  Manual backup/restore is available in workspace settings; backups cover LMDB,
  including contextual bitmaps and relations, not storage files or settings.
- WhatsApp unchanged-message rewrites were fixed. Excessive email version churn
  remains a separate investigation; neither is proven to cause physical damage.

## Follow-up

- [ ] Record results with the updated version, including exact versions and the
  first failing request/time if the problem recurs.
- [ ] Reproduce delete/reinsert churn followed by sustained recovery uploads on
  disposable databases, with and without concurrent IMAP ingestion.
- [ ] Capture server/native crash output, host kernel/ZFS errors, available space,
  database file size and transaction metadata around the first failure.
- [ ] Audit write/close/backup concurrency, file growth and writeback failures;
  check whether any other process or storage path can replace/truncate LMDB files.
- [ ] Verify document IDs, checksums, relations and membership bitmaps after churn,
  and exercise checkpoint restore before relying on it operationally.
- [ ] Investigate email no-op updates separately from physical corruption.

Preserve originals; use disposable copies for probes. Existing evidence is in
`../_restore_/diagnostic-20261016-074619/` and
`../_restore_/backup-audit-20261016-075805/`, including key exports and hashes.
