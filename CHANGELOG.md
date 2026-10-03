# Changelog

## 0.3.0

- Add `{code}` shorthand for native CodeMode execution with compact successful `{ref,base}` receipts; retain full repair metadata on failure.
- Teach awaited top-level return instead of redundant text-await wrappers; preserve explicit incremental output, legacy actions and side-effect acknowledgment.
- Verify shorthand and repair through real SDK and packaged-install fixtures. Default raw-CodeMode hiding remains unchanged.

## 0.2.0

- Add one-call exec/repair, explicit rerun acknowledgement, private bounded scratch retention and promotion/release.
- Add shared versioned splice IR, exact batches, revision-bound ranges and strict Codex-style buffer patches; export pure multi-text planning.
- Preserve v1 reading; add branch-prefix caching, bounded source cache, periodic verified source snapshots, named retirement and durable growth quotas.
- Test stress, cancellation, crash-owner retention, partial external effects, isolated packages and both companion load orders. Add byte-envelope protocol benchmark.
- Stabilize 1,024-record scratch lookup with a bounded, verified metadata index; eliminate quadratic legacy revision-ID checks and redundant canonical-history accounting. Add 50k-event regression and saturation measurements.
- Add read-only `/codebuffer recover`, compact scratch result metadata and contextual repair errors.
- Scope is source-level editing/execution, not workspace transactions. Linux private scratch is supported; Windows scratch ACLs fail closed. See docs/ACCEPTANCE.md.

## 0.1.0

- Add one CodeBuffer tool for create, read, exact patch, run and metadata status.
- Persist immutable UUID/parent/SHA-256 revisions and patch deltas on Pi's active
  session branch, with optimistic concurrency and fail-closed reconstruction.
- Precheck async-body syntax without executing; invalid revisions remain repairable.
- Delegate to the original Pi CodeMode executor through a public exposure adapter;
  hide its raw declaration by default and preserve nested tool permissions.
- Add byte-estimate metrics, compact commands and strict minimal configuration.
- Test real Pi 1.0.0 execution, compaction/restart, branch isolation and installed
  coexistence with pi-codex-native-compaction v0.3.1.
- Source recovery only: reruns can repeat side effects. No execution journal.
