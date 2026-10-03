# Retention and migration

| Resource                                 |  Default | Accounting                                             |
| ---------------------------------------- | -------: | ------------------------------------------------------ |
| One revision                             |  256 KiB | UTF-8 source, rejected not truncated                   |
| Named buffers                            |       64 | Branch-local active named buffers                      |
| Retained source/index cache              |   32 MiB | Accounted source/derived metadata, not RSS             |
| Aggregate scratch store                  |   64 MiB | Serialized logical bytes with replacement reservations |
| Recent successes                         |        4 | Per session                                            |
| Retained failures/drafts/running handles |       16 | Per session, active leases protected                   |
| Revisions per scratch                    |        8 | Independent immutable source snapshots                 |
| Unpinned lifetime                        | 24 hours | Also subject to count/byte pressure                    |
| New durable growth                       |   64 MiB | Custom-entry serialized bytes across the session tree  |

Scratch data live at `<Pi agent dir>/codebuffer-scratch-v1` unless `scratchDirectory` is configured. The shared flat store has a 1024-handle hard index cap, not an unbounded directory per session. Records contain only explicitly submitted source and source metadata. File modes are 0600, directory modes 0700, verified on POSIX. Logical byte accounting excludes filesystem block-allocation overhead; it is not a device-wide disk-usage guarantee.

Eviction prefers successful handles, then eligible old failed handles. Running sources cannot be evicted. Counts are session-local; bytes are aggregate. Expiry is checked on access and cleaned on later reservations. A successful handle is only briefly readable. `status` exposes branch-local retained references without source. `readScratch` uses optional immutable `base` to read a retained older revision. Eviction never silently changes a reference's revision.

`promote` copies a selected scratch revision into a new named durable buffer, subject to named and durable quotas. `release` removes eligible scratch payloads; it cannot retire named histories or rewrite transcript arguments. Pinning does not bypass quotas. `retire(name)` frees the active named slot and its current source cache, not historical entries. Retired names cannot be silently reused or patched; historical read/run remains explicit. New chains include verified source snapshots every 64 revisions.

Scratch scans retain at most 1,024 metadata entries (bounded session/anchor strings), never source payloads. File identity/mode/size/nanosecond timestamps are checked on each scan; changed records are parsed and hash-verified. Selected repair/read targets are always verified from canonical files. The index is rebuilt on restart; `indexBytes` is serialized logical metadata, not RSS. Unknown record fields are not retained in the index.

Old v1 sessions stay readable; their entries are not migrated or compacted. New named IR revisions coexist with v1 exact deltas in 0.2.0. Older v0.1.0 cannot read the new IR records: back up sessions before upgrading, and keep 0.2.0 available when reopening sessions written with new formats. Legacy exact-only histories remain backward-compatible.

Do not delete recovery evidence to satisfy a quota. When protected sources fill capacity, wait for in-flight work, explicitly release completed/failed references, or adjust bounded configuration deliberately. Durable quota failure leaves independent scratch work available.

Pi's conversation, source arguments, other plugins and abandoned branches are not owned by CodeBuffer. Those durable records can keep growing and need Pi/user-managed retention.
