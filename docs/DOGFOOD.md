# Stabilization dogfood observations

The implementation agent used the installed `0.2.0-alpha.1` while editing its repository successor. Repository edits did not hot-reload the active executor; fresh SDK/package processes verified changed code. This is a manually tallied development observation, not a controlled provider experiment. No reasoning, session transcript, private source or credentials are included.

Recorded implementation window (release/CI housekeeping excluded): at least 29 independent `exec` calls, 2 `repair` calls, 0 legacy create/run calls. Both repairs used exact replace with explicit count=3 and `rerun:from-start`; no retained failed source was regenerated. Range and apply_patch correctness were exercised through SDK regression/packaged tests, not artificially induced live-agent failures.

Observed unexpected execution failures: 2 benchmark timeouts. No observed stale revision, patch-not-found, ambiguous patch, schema, scratch quota or scratch recovery-required errors in agent orchestration. One nested TypeScript command failed after a quoting mistake in a file edit; the source runner correctly returned the nonzero exit code, the affected line was inspected and fixed. A diagnostic process search returned exit 1 for no matches; it was not treated as test success.

Defects addressed:

- Full-store parsing/hashing on every operation caused expensive saturation work. A bounded verified metadata index avoids rereading unchanged source; selected targets remain authoritative disk reads.
- Legacy duplicate UUID scans were quadratic, and counting Pi-owned canonical source again caused avoidable index eviction/rebuild. A UUID set and derived-only accounting fixed both; 50k-event regressions cover siblings/restart.
- Scratch success results redundantly repeated revision identity and generic named-buffer fields. Results now carry one base UUID, hash, bytes, syntax/execution/effect/retention state; failures have contextual repair hints. The active alpha still emitted its old results during development.
- Ambiguous crash evidence lacked a safe inspection UI. `/codebuffer recover` now reports read-only observations without cleanup or execution.

The two failed benchmark programs were explicitly rerun **from the beginning** after changes; no continuation or cached execution occurred. New task-owned temporary stores were used. Full-source regeneration, artificial counter-padding and an accumulating remainingStep dispatcher were avoided.
