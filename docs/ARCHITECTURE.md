# Architecture

## Executor boundary

The model sees a sequential, model-only `codebuffer` orchestrator. Pi 1.0.0's built-in CodeMode is model-only, so hiding its declaration alone cannot make nested execution legal. The extension captures its original bound `execute`, obtains the public official factory definition, and adapts exposure to `direct` without replacing the executor or options. `prepareLoadout.hiddenDeclarations` hides the raw declaration; both tools remain active. `hideRawCodemode:false` is the explicit visibility fallback, not a substitute runtime.

`ctx.executeTool("codemode", {code}, {signal,onUpdate})` remains the only execution path. Immediate parent IDs guard recursion. Streaming, nested permissions, discovery, MCP, images and `models.*` remain Pi's responsibilities. Nested usage is not counted again. Required capability failures are explicit. No private Pi imports or provider hooks.

## Source backends

Named v1 history stays canonical in custom `pi-codebuffer.v1` entries on `getBranch()`. Initial source is full; exact deltas and new version-1 splice IR revisions are replayed with UUID/parent/hash/syntax verification. Old entries are not rewritten. IR revisions have a UUID parent and a full SHA-256 base guard. Syntax is Acorn parse-only async-body preflight; QuickJS remains authoritative. Invalid drafts are readable but never delegated.

A branch-prefix index reuses only identical entry ancestry within the same session. Divergence/fork/reload rebuilds; sibling same-name/revision numbers cannot authorize edits. Source values use a bounded LRU; metadata is discarded when the index budget is exceeded. This bounds retained derived cache accounting, **not peak reconstruction memory or Pi's resident transcript**. Very large pre-existing histories can still require a linear rebuild. New revisions include independently hash-verified source snapshots every 64 revisions; reconstruction from a new snapshot needs at most 63 following deltas. This does not rewrite old v1 chains.

`exec` allocates an independent scratch lineage in a private plugin store, not a named slot or new full-source custom entry. Submitted source is retained before delegation. The store serializes cooperating operations with a private lock and atomically replaces a JSON record containing at most eight source snapshots. These are **source** snapshots, never execution checkpoints. A repair creates a UUID revision and splice provenance. Source/hash identity is pinned before awaiting CodeMode.

A metadata-only scratch index checks file signatures on every scan and validates changed payloads. It holds no source strings; canonical per-record files remain authoritative. Reopen rebuilds the index; selected reads/repairs still hash-verify source. Duplicate legacy UUID checks use a set; derived index accounting does not count Pi-owned canonical payloads as copies.

A quota reservation includes twice the serialized record size plus settlement headroom for atomic replacement. Running sources cannot be evicted. Terminal success is eligible for the recent-success window; syntax failures, runtime failures and interrupted work are retained under the failed-handle policy. Dead owner PIDs are treated as interrupted, not resumed. The same process never automatically replays anything.

## Editing boundary

`editing.ts` exports pure frontend decoding/planning and one `EditIR {version:1,baseHash,splices}` executor. UTF-16 half-open splices are sorted, checked for overlap/surrogate splits, and applied as one result. Exact replacements compile against the same base, including count guards. Ranges never rebase. Strict Codex-style parsing compiles complete envelopes before planning.

Buffer patches accept only virtual `Update File: buffer`; unexpected paths cannot become filesystem writes. `compileTextPatchSet` is an offline, pure multi-text planner for explicit supplied snapshots, with add/delete/move expressed as creation/deletion/splices. It is **not a workspace backend**, does not observe actual filesystem identities, and cannot authorize or commit files. No mixed transaction is supported.

## Workspace non-goal

Pi 1.0.0 publicly exposes policy-visible tool calls, but not a side-effect-free authorization decision equivalent to every policy guarding built-in `edit/write`, nor a general cooperating file-mutation queue. A new tool name would not inherit name-specific policy denials. Calling the existing writer to a staging path would authorize the wrong target. Host `fs` renames after such a check would bypass that policy. CodeBuffer deliberately exposes no mutating workspace tool instead of weakening that boundary. See ACCEPTANCE.md.
