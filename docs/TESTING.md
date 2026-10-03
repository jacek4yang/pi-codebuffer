# Testing

Baseline inspected: e46b4b33e592b7ff5bc8681399937646ce6d1cb3 (v0.1.0), Pi 1.0.0, Node 24.21.0. Stabilization began at bbf8b9f90f9ec13ad272401558f1d52af6012248. Release validation uses the pinned released Pi SDK, original QuickJS executor and local deterministic HTTP/SSE providers. No paid/real provider quota is consumed. TypeScript/ESLint are the configured gates; no TypeScript LSP server is configured in the development workspace.

```sh
npm ci --no-audit --no-fund
npm run check
npm run format:check
npm pack --json
npm run smoke:install
npm run benchmark -- /tmp/codebuffer-benchmark.json
npm exec -- tsx scripts/saturation.ts /tmp/codebuffer-saturation.json
```

The smoke script installs the tarball plus pinned Pi 1.0.0 and companion development fixtures in an isolated temporary directory. It loads the packaged root entry, links the installed source rather than copying it out of dependency scope, and runs the same real-SDK cases. `--installed /absolute/path` tests a separately installed runtime-only/Git checkout. No active Pi home/settings are changed.

Fixtures: native-compaction v0.3.1, SHA-256 `07f68ae5bdb2aa8d4e1aa8ed8046646a70524831c9fb9ece2e2d1d24d188c118`; generation-recovery v0.2.0, SHA-256 `4afe6cbb4fbf996f893d13521fe738ee8b0c7a5b6976e3050bc62264a14034b4`. They are not runtime dependencies. Set `PI_CODEBUFFER_COMPANION_TARBALL` / `PI_CODEBUFFER_GENERATION_TARBALL` to predownloaded verified artifacts.

Coverage includes v1 compatibility, original executor options, hidden declarations, nested permissions/images, syntax preflight, immutable/stale edits, restart/fork/tree/compaction, cancellation, killed source owners, protected quotas, symlinks/corruption/orphans, complete-batch validation and Unicode. Stress fixtures run 1000 private-store lineages, 200 real-SDK one-call snippets with a two-success limit, and 1200 incremental named revisions. Both companion load orders exercise a failed scratch, native checkpoint, restart and repair. Native writes followed by bad nested schema or unavailable diagnostics retain their effects and return failed execution; nonzero command results must be checked by source.

README examples run through the real schema. CI uses Linux for full/packaged behavior and a Windows boundary job for legacy SDK plus explicit no-write scratch refusal. Windows scratch and workspace transactions are not verified support.

No transaction rollback/kill-mid-file-commit tests are claimed: that backend is absent. See ACCEPTANCE.md for the stable scope and remaining limitations. Saturation covers 1,024 records; legacy-history regressions cover 50k events with sibling navigation and restart. Recovery inspection is tested with live, dead and incomplete locks and pending evidence.
