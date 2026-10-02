# Architecture

## Source inspection and the Pi 1.0.0 boundary

Inspected npm release `@earendil-works/pi-coding-agent@1.0.0` and upstream
`earendil-works/pi` main `9fba660cf1caca0ade5bea72269352416e595a19`.
The current upstream SHA matched the task's baseline at inspection time; no
implementation imports or depends on that private source/SHA.

In upstream `packages/coding-agent/src/core/agent-session.ts`, callable tools
exclude `model-only` tools. CodeMode's built-in definition is `model-only`.
Thus the proposed hide-only approach demonstrably fails: the real-SDK baseline
test receives `Tool codemode not found`, despite CodeMode being active.

The supported public surfaces provide a minimal adaptation:

1. Register `codebuffer` as a model-only, sequential orchestrator.
2. Capture the original bound CodeMode `execute` from public
   `prepareLoadout.registered` before adapting it.
3. At session startup, get CodeMode's definition from public
   `createCodemodeExtension()` using a registration adapter. Re-register its
   definition with `exposure: "direct"` **and the captured original execute
   function**, preserving the actual executor and its original options.
4. Activate both names. `prepareLoadout.hiddenDeclarations` hides raw CodeMode
   without deactivating it. The public factory's loadout hook supplies CodeMode's
   generated documentation/catalog inside CodeBuffer's tool description.
5. A run pins the reconstructed revision, records an attempt, and delegates
   through `ctx.executeTool("codemode", { code }, { signal, onUpdate })`.
6. Permit nested CodeMode calls only when their immediate parent is an active
   CodeBuffer run. CodeMode itself excludes its own name from its script tool
   catalog; CodeBuffer is model-only. The extra guard blocks reentry through
   another nested tool.

This is an **exposure adapter**, not a new executor. The bound execute function
comes from the original registration, not an independently configured execution
clone. A regression with the original factory's `models:false` proves those
options survive. No private imports, QuickJS copy, permission replacement, MCP
proxy, model proxy or output truncation implementation exists here. The public
factory is also used to preserve the official schema/renderers. Loading another
extension that replaces `codemode` is unsupported.

The adapter registers during `session_start`, after all initial declarations
exist. Missing APIs/executor refuse tool operations instead of selecting another
runtime. The `hideRawCodemode:false` fallback changes visibility only.
SDK callers should supply Pi's public built-in factory, as demonstrated in tests;
ordinary Pi CLI installations already do so.

## Revision log

Custom entry type: `pi-codebuffer.v1`. The first revision includes full source.
Each later revision includes only `{old,replacement}` and metadata:

- name, branch-local revision number, immutable UUID;
- parent UUID (null for creation);
- SHA-256 of exact UTF-8 reconstructed source;
- ISO timestamp and parse-only syntax result.

No newline normalization or fuzzy patching. Exact matching includes overlapping
occurrences. Parent must be the current branch head. Failed patches append only a
counter event, never a revision. Corrupt data fail closed; no silent repair.

On every operation, reconstruct from `ctx.sessionManager.getBranch()`, never
`getEntries()`. Branch paths include pre-compaction custom entries. Replaying
deltas verifies hashes, parents, revision order, source limits and syntax before
use. There is no mutable cache to invalidate on resume, fork, tree navigation or
compaction. UUIDs make revision identity unambiguous across sibling branches;
numbers are convenient addresses relative to the active branch.

All mutations finish synchronously before execution awaits; the tool is also
declared sequential. No last-write-wins merge. One Pi process should own a
session file: this extension does not provide cross-process session-file locks.

## Output and privacy boundary

Revision/status responses contain no source or patch text. Explicit reads are
bounded. Create/patch arguments remain ordinary model conversation history;
custom entries themselves are never projected into context.

Nested CodeMode content (including images), details, error state and update
callbacks are forwarded. A short revision/hash/status prefix identifies the
execution. Pi records nested usage; it is not copied onto the outer result to
avoid double accounting. Neither outputs nor runtime error text are stored in
CodeBuffer custom metadata.

Syntax precheck uses Acorn in a synthetic async function, checks that source
cannot escape that wrapper, and adjusts locations to source coordinates. It is
compile-only. Syntax validity is not proof of QuickJS compatibility.

## Metrics and limits

Counters are replayed from the same branch log. Run attempts are counted before
delegation, including permission/runtime failure, not syntax-rejected runs.
Reconstructed source bytes count source handed to delegated attempts.
Syntax failures count invalid revisions, not each attempted run of one.
Patch failures count rejected semantic mutations, not Pi's schema rejections.
Patch bytes include UTF-8 JSON encoding of the stored delta, excluding metadata;
avoided bytes are a clamped per-patch source-minus-delta estimate.

256 KiB source, 64 buffer names per branch, 16,000 UTF-16 characters per read.
Replay is linear in revision count and repeatedly parses/reconstructs source;
very long chains may become slow. No premature checkpoints/database framework.
Session retention/deletion and source confidentiality remain Pi/user concerns.
