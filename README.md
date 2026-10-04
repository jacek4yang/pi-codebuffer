# pi-codebuffer

Pi host peers are unrestricted (`*`). Users control host upgrades; required API/safety checks remain. Dev/CI versions pin reproducible tests, not runtime support. Untested versions are not guaranteed compatible.

Revisioned source editing in front of Pi's **original CodeMode executor**. No replacement VM, provider, replay engine, or telemetry.

## Retained source: reuse, derive, or inspect ranges

Successful `{code}` calls return `{ref, base}`. For a nontrivial program worth repeating, send `{ref, base, rerun:"from-start"}` instead of retransmitting its source. This explicitly repeats all effects and does not resume an instruction cursor. Missing acknowledgments after delegation fail closed.

For a similar program, add `edit` to that compact request. It uses the same canonical Edit IR and creates a new source revision; unchanged source is not resent. `run:false` edits without execution. Do not reuse a stale base or regenerate an entire program for a small change.

For large edits, `readScratch` with `lines:true` returns `{base, units, lines:[{start,end,text}], nextOffset}`: exact UTF-16 spans, retaining CRLF and Unicode. Select the first span's start and last span's end for a guarded range replacement/deletion. Pages contain at most 256 spans/16000 units; body text is not duplicated. The default view remains plain `source`. `units` is the entire source length, not a token count.

Short one-shot operations still belong to direct tools: ref/base overhead can exceed the cost of a tiny script. Retention is bounded; `promote` keeps intentionally reusable source durable. No automatic replay, workspace transactions, new host runtimes or language transpilation.

## Recommended workflow: code → success, or repair → rerun

Model-facing `codebuffer` calls (not JavaScript globals):

```json
{ "code": "return tools.read({path: 'README.md'});" }
```

`code` is the compact spelling of `exec(source)`, with exactly the same executor and safety checks. Top-level `return` awaits and emits its result; use `text()` only for multiple/incremental results. Success adds only `{ref, base}` to native output; the retained source remains available for repair or promotion. Do not mix `code` with legacy fields. Existing `action:"exec",source` remains compatible.

A failure returns `ref` and `base` (full immutable UUID), syntax/execution state, hash, source bytes, retention state, and a recovery hint. Repair in **one** further invocation:

```json
{
  "action": "repair",
  "ref": "<returned-ref>",
  "base": "<returned-base>",
  "rerun": "from-start",
  "edit": {
    "format": "replace",
    "edits": [{ "old": "README.md", "replacement": "docs/EDITING.md" }]
  }
}
```

`repair` runs by default. `run:false` creates a draft without executing. Syntax-invalid source never executes. A previous delegation requires `rerun:"from-start"` for executing repair, including after cancellation. It is **not a continuation**: prior writes, commands and network effects may happen again. Native errors/images/streaming/cancellation remain native. An outer completed script does not prove a command exit code was zero; inspect structured results explicitly.

No name or durable slot is needed for `exec`. Successful scratch handles are automatically reduced to a small recent window. Failed handles persist privately while retained. Use `readScratch` for bounded UTF-16 ranges, `release` to retire scratch, `retire(name)` to free a named active slot without deleting history, and `promote(ref,base,name)` to create durable named source before expiry. `status` lists retained references on the current branch, including interrupted work whose response was lost.

Legacy `create/read/patch/run/status` remain supported. New named `patch` can use `baseRevision`, immutable `base`, and `edit`; old `old/replacement` still works. `/codebuffer status` is metadata-only. `/codebuffer recover` inspects scratch ownership, locks and hashes without deleting evidence. The outer orchestrator is non-reentrant; do not call it from CodeMode.

## Install, platforms and rollback

```sh
pi install git:github.com/jacek4yang/pi-codebuffer
# Roll back the package (not external effects):
pi install git:github.com/jacek4yang/pi-codebuffer@v0.1.0
```

Reload Pi after changing the installed version. To evaluate separately, prefix the install command with `PI_CODING_AGENT_DIR=/absolute/temporary/pi-home`. No npm publication.

Supported baseline: **Pi 1.0.2, Node 24.x, local Linux filesystem** (development Node 24.21.0). Windows CI verifies legacy named buffers and scratch refusal only: `exec/repair` private scratch persistence is **unsupported/fail-closed** there. Network/shared-host stores are unsupported.

Back up sessions before upgrading. v0.1.0 cannot reconstruct newer named IR records; reopen those sessions with v0.2.0, or use an older session copy after rollback. Scratch cleanup neither removes transcript arguments nor rolls back external tool effects.

## Scope

CodeBuffer owns CodeMode source lifecycle, immutable source editing, execution/repair, bounded scratch retention and reusable **pure** editing primitives. A complete source edit commits one revision or none; syntax-invalid drafts remain repairable. This is not atomicity or rollback of tools invoked by the source.

Workspace editing and command conveniences belong to **pi-workflow**, not this package. Its enhanced edit consumes the pure IR and Pi's public mutation queue; its workflow tool delegates through Pi's policy-visible bash tool. The multi-text planner here never writes files.

Use direct tools for simple operations. For composition, CodeBuffer can be the sole model-visible script tool (`hideRawCodemode:true`, the default), while still delegating to native CodeMode. Keep native CodeMode enabled (`mode:"on"`) to retain direct tools; hiding its declaration does not remove the executor.

## Editing and retention

- [Editing formats and executable examples](docs/EDITING.md): exact replacement, revision-bound ranges, strict local Codex-style patch syntax.
- [Retention/migration](docs/RETENTION.md): scratch vs canonical session entries vs derived caches vs Pi's transcript.
- [Configuration](docs/CONFIGURATION.md): conservative defaults and strict validation.
- [Architecture](docs/ARCHITECTURE.md), [failure model](docs/FAILURE_MODEL.md), [security](SECURITY.md).
- [Testing](docs/TESTING.md), [benchmark](docs/BENCHMARK.md), [release policy](docs/RELEASING.md).

The pure TypeScript/ESM API is `pi-codebuffer/editing`. It builds/validates immutable plans and **does not write or execute**. Native CodeMode does not gain Node imports, filesystem globals, or new VM helpers.

Byte counts are not tokens or billing savings. Pi's append-only conversation history can still grow; CodeBuffer does not rewrite it.
