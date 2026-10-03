# 0.2.0 acceptance record

Scope: Linux CodeMode **source** lifecycle, immutable editing, fused execution/repair, bounded private scratch retention and pure editing exports. This is not a workspace-transaction product.

## Verification

Stabilization started from `bbf8b9f90f9ec13ad272401558f1d52af6012248` (0.2.0-alpha.1); previous stable is `e46b4b33e592b7ff5bc8681399937646ce6d1cb3` (v0.1.0). Pi 1.0.0 and Node 24.21.0 were rechecked locally. Release commit/checksums and CI links belong to the GitHub release, avoiding a self-referential commit hash here.

- TypeScript, ESLint, formatting and 34 local tests passed; isolated packaged installation passed 37 tests including both companion load orders. No tests were removed or disabled.
- Real SDK tests preserve the original bound CodeMode executor/options, permission denials, streaming/images, cancellation and accounting. Syntax rejection does not execute; stale or malformed edits do not create revisions.
- Isolated tarball and Git-style installs run the registered extension against the original SDK, not only pure-kernel calls. Both pinned companion load orders cover checkpoint, restart and scratch repair without owning provider/retry state.
- Stress includes 200 native SDK snippets, 1,000 independent store lineages, 1,024 simultaneous records across 32 sessions, protected quota pressure, repeated repair, expiry, corruption and restart.
- 10k/50k legacy histories measure first/cached reconstruction, navigation and restart; regressions prevent quadratic duplicate checking and canonical-source double-accounting.
- Windows CI verifies the explicit legacy/refusal boundary, not scratch execution.
- Protocol replay and saturation measurements are reported separately from real-agent observations in BENCHMARK.md and DOGFOOD.md.

## Remaining limitations (not hidden acceptance waivers)

1. Workspace mutations, transactional rollback and general engineering orchestration are non-goals. The Pi 1.0.0 public API was rechecked: no equivalent authorization-only/mutation queue API is available. Pure multi-text planning performs no host writes.
2. Private scratch persistence is Linux-supported. Windows fails closed; mode bits do not establish private ACLs. No network filesystem or cross-host store support.
3. Cache counters bound retained logical data, not peak reconstruction memory or Pi transcript/RSS. A very large old branch still requires linear verification; history exceeding the retained index budget can rebuild on later access. History is never rewritten.
4. Dead execution owners never resume automatically. Ambiguous lock/staging evidence blocks operations. `/codebuffer recover` is read-only: stop owners, preserve a private backup and investigate before manual cleanup. It does not prove a PID belongs to the original process.
5. Per-record atomic rename is not cross-platform power-loss durability. Logical quota accounting is not allocated filesystem blocks.
6. Local deterministic bytes/call counts are not tokens, billing savings, or measured improvements in model intelligence.

Publication is gated by the exact release commit passing protected CI and isolated installation; a local green suite alone does not constitute publication.
