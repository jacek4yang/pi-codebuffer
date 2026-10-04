# Unified execution (opt-in)

Enable with `PI_CODEBUFFER='{"unified":true}'`, merged with your existing CodeBuffer configuration. Do not load the standalone `pi-workflow` extension at the same time: its `edit` registration conflicts with the unified file tool. Remove that package from the loadout, but keep `~/.pi/agent/workflow.json`. Existing legacy CodeBuffer behavior remains available with `unified:false`.

## Small, familiar entry points

- `code {code}`: native CodeMode QuickJS orchestration, not Node. Use `tools.*` for host I/O. Existing retained-source reuse and Edit IR remain available.
- `python {code}`, `node {code}`, `bash {command}`: real host interpreters, source passed on stdin. Node uses ES modules/top-level await. Bash parses all source before executing it.
- `read`, `write`, `edit`: ordinary files or `buffer:<ref>`. File edits retain the strict mutation queue, UTF-8, link and protected-path checks from Workflow.
- `code {context:...}`, `{job:...}`, or `{workflow:...}`: controls, separate from source execution.

These are not new programming languages. No Python-to-JavaScript translator, implicit REPL, automatic command retry, or mandatory temporary script files are involved. Host programs still have the user's OS permissions; this is not a security sandbox.

## Context

```json
{
  "context": {
    "cwd": "/work/app",
    "python": ".venv/bin/python",
    "node": "/opt/node/bin/node",
    "env": { "MODE": "test" }
  }
}
```

Set several fields together or just one. Omitted fields stay unchanged; `null` clears an override. `{"context":"show"}` displays explicit configuration, not the inherited environment. `{"context":null}` resets the session context. Updates validate atomically and are saved in the session branch. Tree navigation restores the selected branch's context without launching work.

Each submission captures its context. Later changes do not retarget running jobs or already prepared source. Interpreter processes are fresh: environment configuration persists, Python globals and shell variables set inside a subprocess do not. Use context changes for persistent environment settings.

Limits: 64 KiB context, 128 environment keys, 8 KiB per environment value, 64 program-route rules; persisted context history is capped at 8 MiB. Unchanged context updates do not add history entries.

## Routes, projects, and named workflows

The existing `~/.pi/agent/workflow.json` is read, not overwritten. Example:

```json
{
  "routes": {
    "public": "http://127.0.0.1:10809",
    "personal": "http://127.0.0.1:10808"
  },
  "programs": { "git": "personal", "gh": "personal", "curl": "public" },
  "projects": {
    "app": {
      "cwd": "/work/app",
      "python": ".venv/bin/python",
      "env": { "MODE": "test" }
    }
  },
  "workflows": {
    "git-review": "git status --short && git diff --stat",
    "gh-checks": "gh pr checks",
    "rust-test": "cargo test",
    "python-test": "python -m pytest"
  }
}
```

`code {context:{project:"app"}}` selects project defaults, optionally overridden in the same patch. `code {workflow:"list"}` lists configured names; `{workflow:"rust-test"}` runs that exact command through the same Bash authorization and job engine. No implicit commit, push, dependency install or failure retry occurs. Config is capped at 64 KiB; at most 32 projects and 32 workflows; each workflow command is at most 16 KiB.

Program rules use private PATH wrappers: `git`, `gh` and `curl` inside one Bash invocation can use different routes. A tool's explicit `route` overrides program rules, which override the context default. `direct` clears proxy/bypass variables; `inherit` preserves them. No route fallback is attempted after a network failure. Absolute executable paths, Git SSH, programs which ignore proxy environment variables, or deliberately modified PATHs are not transparently routed. Select an HTTPS Git remote when HTTP proxy routing is required. Node routes enable `NODE_USE_ENV_PROXY` where supported by the selected Node runtime.

## Incremental source and edits

```json
{ "code": "def report():\n", "run": false }
```

Use the returned `ref` and `base`:

```json
{
  "path": "buffer:<ref>",
  "format": "append",
  "base": "<revision>",
  "text": "    print('ready')\nreport()\n"
}
```

Then execute with the corresponding language tool:

```json
{ "ref": "<ref>", "base": "<latest-revision>" }
```

Append is a guarded range insertion, not a new executor. Drafts may be syntactically incomplete. Edits do not execute code. Running buffers cannot be edited or released. Repeating a previously delegated execution requires explicit `rerun:"from-start"`; this starts over, not from a partial instruction pointer. Inspect the job and side effects first.

Prefer logical chunks of roughly 4–16 KiB, not many tiny fragments or the entire program repeatedly. There is no minimum chunk size; source is capped at 256 KiB. Existing scratch quotas, retention, expiry, and branch isolation still apply. A provider disconnection before a complete tool invocation cannot preserve an unsubmitted source tail; no incomplete arguments are executed.

For buffers, `read.offset` and `read.limit` are **0-based UTF-16 units**, capped at 16,000 units per read; surrogate pairs are not split. Ordinary file reads retain Pi's **1-based line** semantics. `edit` snapshot returns the guarded base; file bases are SHA-256, buffer bases are revision IDs. Use `readScratch(lines:true)` on the retained code surface for guarded line spans where appropriate.

## Jobs, deadlines, and completion

`wait` is seconds to wait for a receipt (default 5, maximum 60). `wait:0` returns promptly with a job. Reaching this wait does **not** kill the program. `limit` is the hard execution deadline (default 30 minutes, maximum 24 hours), enforced by an external watchdog. At the deadline or explicit cancellation, terminate the process group and escalate to KILL after one second. Deliberate `setsid` escapes are not contained.

```json
{"command":"cargo test","wait":0,"limit":1800}
{"job":"list"}
{"job":{"id":"<job>","action":"inspect"}}
{"job":{"id":"<job>","action":"cancel"}}
```

Completion is delivered once, without provider polling. A follow-up provider turn is requested only for the same user/branch after the agent is idle, not during compaction or after an error/cancellation pause. New user work and tree navigation must not be overwritten by an old job. Shutdown stops owned jobs; after a crash, surviving watchdog jobs are inspected as orphaned rather than relaunched. No proof of completion means interrupted, never fabricated success.

Per runtime: 4 active jobs, 16 job records, 256 KiB combined retained log per job, 8 KiB inline output, 16 undelivered completions. stderr is prioritized in bounded output. Limits reject new work rather than silently drop unfinished jobs. Up to 8 runtime session directories are retained; inactive directories expire after 24 hours or are evicted oldest-first under pressure. Live owners and live job identities are never collected. Admission checks cap storage at 48 MiB and 4,096 entries. PID plus process start time protects against PID reuse.

Unknown files, unsafe links, corrupted metadata and abandoned allocation locks fail closed. Inspect ownership and job identities before manually repairing a crashed allocation; do not blindly delete its directory. No CPU/RAM limit or protection against arbitrary disk writes by user scripts is claimed.

## Display and recovery boundaries

Tool cards show source previews with syntax highlighting, expandable input/output, job state and exit code. Requested edit removals are red and additions green; the preview is not a claim that the mutation succeeded. Display previews are bounded and terminal-control characters filtered. Generic secret detection/redaction is deliberately not included.

Native compaction and generation-recovery remain separate extensions. They can recover provider transport failures at safe boundaries; the executor does not replay host side effects. A long report or unfinished tool argument stream can still terminate. Retained chunks reduce repeated source generation, but no zero-token-overhead or universally lower billing claim is made.
