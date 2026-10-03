# Candidate acceptance and blockers

This branch is **not yet the full requested daily-use release-ready successor**. It preserves a tested source-workflow improvement without inventing unavailable guarantees. Do not tag/merge/release it as a completed workspace-transaction product.

Implemented: fused exec/repair, acknowledgement before replaying effects, private retained scratch source, bounded successful handle window, quota reservations, immutable IR revisions, exact/range/strict Codex-style frontends, pure public planning API, v1 reading, branch-prefix cache, isolated real-SDK tests and companion coexistence.

Blocking or incomplete requirements:

1. **Workspace backend:** Pi 1.0.0 lacks the inspected public authorization-only/file-queue surface needed to preserve existing name-specific built-in edit/write policies while staging atomic replacements. No host workspace writes are exposed. Therefore transactional rollback, durable file journals, mid-commit process termination, guarded external-writer recovery and their fault-injection matrix are not implemented. A pure multi-text plan is not a substitute.
2. **Windows private scratch ACLs:** fail-closed boundary only; no Windows scratch support claim. Local Linux behavior is tested; CI separately checks the Windows refusal and legacy SDK behavior.
3. **History/index worst-case bounds:** retained caches are bounded, but a very large old branch can incur a linear rebuild and temporary metadata allocations. New histories have verified source snapshots every 64 revisions and named retirement. Old v1 chains still have no bounded reconstruction depth before their first new snapshot; transient metadata during a full rebuild is not strictly bounded by the retained-cache counter.
4. **Scratch crash settlement:** hard-killed owners retain source and never replay. Ambiguous lock/staging leftovers fail closed for manual investigation, rather than an automatic recovery command. Logical storage accounting is not allocated filesystem blocks or RSS.
5. **Benchmark scope:** deterministic local provider, actual released SDK/QuickJS, protocol replay on the same candidate. No paid provider, tokenizer or billing claim.

The package is installable for isolated evaluation. These limitations are not waived by passing tests.
