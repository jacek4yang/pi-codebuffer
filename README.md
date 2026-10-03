# pi-codebuffer

Revisioned source editing in front of Pi's **original CodeMode executor**. No replacement VM, provider, replay engine, or telemetry.

## Recommended workflow: exec → success, or repair → rerun

Model-facing `codebuffer` calls (not JavaScript globals):

```json
{ "action": "exec", "source": "text(answer);" }
```

The failure returns `ref` and `base` (full immutable UUID), syntax/execution state, hash, source bytes, retention state, and a recovery hint. Repair in **one** further invocation:

```json
{
  "action": "repair",
  "ref": "<returned-ref>",
  "base": "<returned-base>",
  "rerun": "from-start",
  "edit": {
    "format": "replace",
    "edits": [{ "old": "answer", "replacement": "42" }]
  }
}
```

`repair` runs by default. `run:false` creates a draft without executing. Syntax-invalid source never executes. A previous delegation requires `rerun:"from-start"` for executing repair, including after cancellation. It is **not a continuation**: prior writes, commands and network effects may happen again. Native errors/images/streaming/cancellation remain native. An outer completed script does not prove a command exit code was zero; inspect structured results explicitly.

No name or durable slot is needed for `exec`. Successful scratch handles are automatically reduced to a small recent window. Failed handles persist privately while retained. Use `readScratch` for bounded UTF-16 ranges, `release` to retire scratch, `retire(name)` to free a named active slot without deleting history, and `promote(ref,base,name)` to create durable named source before expiry. `status` lists retained references on the current branch, including interrupted work whose response was lost.

Legacy `create/read/patch/run/status` remain supported. New named `patch` can use `baseRevision`, immutable `base`, and `edit`; old `old/replacement` still works. `/codebuffer status` is metadata-only. `/codebuffer recover` inspects scratch ownership, locks and hashes without deleting evidence. The outer orchestrator is non-reentrant; do not call it from CodeMode.

## Install, platforms and rollback

```sh
pi install git:github.com/jacek4yang/pi-codebuffer@v0.2.0
# Roll back the package (not external effects):
pi install git:github.com/jacek4yang/pi-codebuffer@v0.1.0
```

Reload Pi after changing the installed version. To evaluate separately, prefix the install command with `PI_CODING_AGENT_DIR=/absolute/temporary/pi-home`. No npm publication.

Supported baseline: **Pi 1.0.0, Node 24.x, local Linux filesystem** (development Node 24.21.0). Windows CI verifies legacy named buffers and scratch refusal only: `exec/repair` private scratch persistence is **unsupported/fail-closed** there. Network/shared-host stores are unsupported.

Back up sessions before upgrading. v0.1.0 cannot reconstruct newer named IR records; reopen those sessions with v0.2.0, or use an older session copy after rollback. Scratch cleanup neither removes transcript arguments nor rolls back external tool effects.

## Scope

CodeBuffer owns CodeMode source lifecycle, immutable source editing, execution/repair, bounded scratch retention and reusable **pure** editing primitives. A complete source edit commits one revision or none; syntax-invalid drafts remain repairable. This is not atomicity or rollback of tools invoked by the source.

Workspace file transactions, Git/build/package workflows, process management and general engineering orchestration belong to future **pi-workflow**, not this package. Pi 1.0.0 has no inspected public API providing policy-equivalent authorization plus file-mutation coordination; no private-API bypass is used. The multi-text planner never writes files.

## Editing and retention

- [Editing formats and executable examples](docs/EDITING.md): exact replacement, revision-bound ranges, strict local Codex-style patch syntax.
- [Retention/migration](docs/RETENTION.md): scratch vs canonical session entries vs derived caches vs Pi's transcript.
- [Configuration](docs/CONFIGURATION.md): conservative defaults and strict validation.
- [Architecture](docs/ARCHITECTURE.md), [failure model](docs/FAILURE_MODEL.md), [security](SECURITY.md).
- [Testing](docs/TESTING.md), [benchmark](docs/BENCHMARK.md), [release policy](docs/RELEASING.md).

The pure TypeScript/ESM API is `pi-codebuffer/editing`. It builds/validates immutable plans and **does not write or execute**. Native CodeMode does not gain Node imports, filesystem globals, or new VM helpers.

Byte counts are not tokens or billing savings. Pi's append-only conversation history can still grow; CodeBuffer does not rewrite it.
