# Changelog

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
