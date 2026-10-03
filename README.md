# pi-codebuffer

Revisioned source editing in front of Pi's **original CodeMode executor**. No replacement VM, provider, replay engine, or telemetry.

## Candidate status

`0.2.0-alpha.1` is a source-workflow candidate, not a stable release. Tested locally with Pi **1.0.0**, Node **24.21.0**, Linux. Windows scratch execution fails closed because this implementation cannot establish equivalent private ACLs. Legacy named buffers remain available. See [acceptance gaps](docs/ACCEPTANCE.md) before installing. The requested policy-equivalent workspace transaction backend is **not implemented**; the exported multi-text planner performs no filesystem mutation.

Stable installation remains `pi install git:github.com/jacek4yang/pi-codebuffer@v0.1.0`. For isolated evaluation of this branch:

```sh
PI_CODING_AGENT_DIR=/absolute/temporary/pi-home pi install git:github.com/jacek4yang/pi-codebuffer@feat/daily-use-codebuffer
```

Do not replace an active installation while testing a candidate. No npm publication.

## One call, then a small repair

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

Legacy `create/read/patch/run/status` remain supported. New named `patch` can use `baseRevision`, immutable `base`, and `edit`; old `old/replacement` still works. `/codebuffer status|inspect|list` remains metadata-only. The outer orchestrator is non-reentrant; do not call it from CodeMode.

## Editing and retention

- [Editing formats and executable examples](docs/EDITING.md): exact replacement, revision-bound ranges, strict local Codex-style patch syntax.
- [Retention/migration](docs/RETENTION.md): scratch vs canonical session entries vs derived caches vs Pi's transcript.
- [Configuration](docs/CONFIGURATION.md): conservative defaults and strict validation.
- [Architecture](docs/ARCHITECTURE.md), [failure model](docs/FAILURE_MODEL.md), [security](SECURITY.md).
- [Testing](docs/TESTING.md), [benchmark](docs/BENCHMARK.md), [release policy](docs/RELEASING.md).

The pure TypeScript/ESM API is `pi-codebuffer/editing`. It builds/validates immutable plans and **does not write or execute**. Native CodeMode does not gain Node imports, filesystem globals, or new VM helpers.

Byte counts are not tokens or billing savings. Pi's append-only conversation history can still grow; CodeBuffer does not rewrite it.
