# pi-codebuffer

Generate CodeMode source once. Repair a failure with a small exact patch, then run
the persisted revision — instead of regenerating the program.

A narrow Pi extension: one `codebuffer` tool, immutable revisions, branch-local
session persistence, parse-only prechecks, and **Pi's original CodeMode executor**.
No telemetry. No execution journal. No npm publication for v0.1.0.

## Install

Requires Node **24+** and Pi's built-in CodeMode enabled. Tested with
**Pi 1.0.0 / Node 24.21.0**; other Pi versions are not claimed compatible.

```sh
pi install git:github.com/jacek4yang/pi-codebuffer@v0.1.0
```

Restart Pi or use its extension reload. Use `pi config` to enable built-in
CodeMode if it was disabled. Do not load a second custom executor named
`codemode`.

By default the raw CodeMode declaration is hidden; `codebuffer` includes its
generated contract and tool catalog. All execution still goes through
`ctx.executeTool("codemode", { code })`. Pi 1.0.0's CodeMode is initially
`model-only`: a small public-factory **exposure adapter retains the original
bound execute function**, makes it internally callable, and blocks nested
recursion. No sandbox is copied. See [architecture](docs/ARCHITECTURE.md).

## Model workflow

```js
codebuffer({ action: "create", name: "main", source: 'text("hello";' });
// revision 1, syntax.valid false; nothing executes
codebuffer({ action: "run", name: "main", revision: 1 });
// failed; patch the existing buffer, do not regenerate
codebuffer({
  action: "patch",
  name: "main",
  baseRevision: 1,
  old: '";',
  replacement: '");',
});
// revision 2, syntax.valid true
codebuffer({ action: "run", name: "main", revision: 2 });
```

| Action   | Arguments                                               |
| -------- | ------------------------------------------------------- |
| `create` | `name, source` — fails if name already exists           |
| `read`   | `name, revision?, offset?, limit?`                      |
| `patch`  | `name, baseRevision, old, replacement`                  |
| `run`    | `name, revision?` — omitted revision means current head |
| `status` | `name?` — metadata and branch-local metrics, no source  |

Names: 1–64 ASCII letters, digits, underscores or hyphens. Source: up to 256 KiB
UTF-8 per revision; 64 buffers per session branch. Read offsets are zero-based
**UTF-16 character offsets**, not lines or UTF-8 byte offsets; default limit
4,000, maximum 16,000. `nextOffset` continues a paginated read.

A patch must match **exactly once**, including overlapping matches. Zero matches
returns `PATCH_NOT_FOUND`; multiple matches return `PATCH_AMBIGUOUS`. Empty
`old` is invalid; empty `replacement` deletes. A stale `baseRevision` is
rejected, never silently rebased. Historical revisions can be read/run, not
patched in place: navigate/fork Pi's session tree to develop another branch.
Numbers are branch-local; UUID and SHA-256 distinguish sibling revisions.

The fast Acorn syntax precheck parses an async function body without execution
and reports source-relative 1-based line/column. It is not a runtime, type checker
or security boundary: Pi/QuickJS remains authoritative.

## Persistence and privacy

Full initial source and subsequent exact deltas are canonical custom session
entries. They survive resume, normal compaction, native checkpoints and branch
navigation. Reads replay only the current session branch, validating ancestry,
syntax and hashes. No project files or separate database are created.

Custom state entries never enter normal LLM context. Explicit tool arguments and
read/run results do, like any Pi tool exchange; this extension cannot erase the
original model-generated source from pre-compaction history. Status/metadata
responses omit source and patch text. Source and deltas are stored in **plaintext
Pi session files**: do not embed secrets. No credentials, hidden reasoning or
execution outputs are added to CodeBuffer metadata.

## Commands and configuration

`/codebuffer status`, `/codebuffer inspect` (compact head metadata), and
`/codebuffer list` all show the current branch's metadata summary. Use tool
`read` for source.

Optional environment variable:

```sh
PI_CODEBUFFER='{"enabled":true,"hideRawCodemode":true,"debug":false}' pi
```

Unknown keys/non-booleans fail configuration loading. `enabled:false` registers
nothing. `hideRawCodemode:false` is the declaration compatibility fallback: both
tools remain visible, but CodeBuffer still delegates normally. It does **not**
emulate missing orchestration APIs. Missing executor/capabilities fail clearly.
Debug only emits a readiness notification, never source. No proxy configuration.

Status metrics: buffers, revisions, delegated run attempts, successful patch-delta
JSON bytes, reconstructed bytes submitted to runs, patch failures and
syntax-invalid revisions. Estimated avoided regeneration bytes sum
`max(0, repairedSourceUtf8Bytes - patchDeltaJsonUtf8Bytes)`.
These are **local byte heuristics, not token or billing savings**.

## Measured regression

The deterministic real-SDK fixture creates a **12,367-byte** program with a tiny
syntax defect. Its repair is an **82-byte complete model tool request**, including
a **34-byte patch delta**; the repaired source is 12,368 bytes. Estimated avoided
regeneration: **12,334 bytes**. The repaired run sends only name/revision from the
model, while Pi reconstructs the source internally. A second regression repairs
a real nested `read` offset failure without resending its large program.

Packaged-install tests also load
[`pi-codex-native-compaction` v0.3.1](https://github.com/jacek4yang/pi-codex-native-compaction):
before/after native checkpoint, restart and execution pass with a local
deterministic provider fixture. Neither extension owns the other's lifecycle.
No paid/live provider test is implied.

## Important limitation

**Rerunning executes the entire revision again.** If A and B had side effects
before C failed, rerunning repeats A and B. Source repair is not execution
recovery. Inspect consequences before rerunning non-idempotent scripts.
No journal, replay, network recovery, learning, search, embeddings or compaction
implementation is included.

[Architecture](docs/ARCHITECTURE.md) · [Failure model](docs/FAILURE_MODEL.md) ·
[Testing](docs/TESTING.md) · [Releasing](docs/RELEASING.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
