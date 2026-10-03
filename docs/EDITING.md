# Editing: one IR, several frontends

All edits address one observed immutable base. Offsets are **UTF-16 half-open**, not bytes or file-read line numbers. Neither boundary may split a surrogate pair. EOF insertion is `[length,length)`, deletion uses empty replacement. Empty text is supported with range insertion. NUL and malformed Unicode are rejected. Filesystem decoding is not implemented by this pure API.

Exact replacement supports multiple `edits` against the SAME base. Each match must be unique by default; an explicit integer `count` must equal the observed count, and matches still cannot overlap. Every operation is validated before a new revision is appended.

## Large-block deletion without resending its body

First use `readScratch(ref,base,offset,limit)` (at most 16000 UTF-16 units) to obtain bounded source and exact coordinates. If the observed unwanted block spans `[120,8120)`, submit:

```json
{
  "action": "repair",
  "ref": "<ref>",
  "base": "<immutable-base>",
  "rerun": "from-start",
  "edit": {
    "format": "range",
    "edits": [{ "start": 120, "end": 8120, "text": "" }]
  }
}
```

No deleted body is sent again. Stale UUIDs or invalid coordinates fail instead of relocating. Use `run:false` to retain a draft without execution. Named patches use `name`, `baseRevision`, immutable `base`, and the same `edit` object.

## Codex-style buffer repair

```json
{
  "action": "repair",
  "ref": "<ref>",
  "base": "<immutable-base>",
  "rerun": "from-start",
  "edit": {
    "format": "apply_patch",
    "patch": "*** Begin Patch\n*** Update File: buffer\n@@\n-text(missing);\n+text(42);\n*** End of File\n*** End Patch"
  }
}
```

Only the virtual path `buffer` is accepted for a source repair. This is a strict **local Codex CLI-style envelope**, NOT a Responses API operation object or provider-native tool. No lenient/heredoc envelope, fuzzy matching, whitespace normalization, or omitted `@@` markers. `@@ context` requires one exact complete context line, then searches after it. Hunk text must uniquely match complete lines in that region. EOF markers must be final in their file.

The buffer compiler accepts one update only. The pure multi-text planner additionally accepts Add/Update/Delete File and Move to; moves compile to guarded deletion plus creation and reject destination/alias conflicts. See provenance and Apache license in PATCH_PROVENANCE.md.

Line patches preserve the existing LF/CRLF convention and EOF-newline state. Mixed LF/CRLF inputs are rejected for line patches. A BOM is ordinary explicit source text and stays unless specifically edited. Range/exact edits preserve every untouched code unit, but can explicitly change newline/BOM content. A read page too small for a complete supplementary character fails with an increase-limit hint.

## Multi-text planning is NOT a file transaction

```ts
import { compileTextPatchSet } from "pi-codebuffer/editing";
// bases: Map<string, {source: string, hash: fullSha256}> from the caller.
const plan = compileTextPatchSet(
  bases,
  "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Add File: b.txt\n+hello\n*** End Patch",
);
// No writes have happened. A malformed later operation returns no plan.
```

There is deliberately **no commit(plan)** backend in this candidate. It cannot demonstrate the requested safe multi-file commit/rollback because the policy-equivalence blocker is unresolved. Do not implement a callback that performs writes during planning or treat these lexical paths/hashes as observed filesystem identities. No Node import or global facade is added inside CodeMode.

## Expired references

`SOURCE_EXPIRED` means the private payload is unavailable/expired or not on this branch. It does not select another source. If you retained an external explicit copy, submit it as a new `exec` (review effects first); otherwise recover it explicitly from your own Pi history. The extension never edits session JSONL or auto-runs recovered code. For important source, use `promote(ref,base,name)` before expiry.

Pure exports: `compileEdit`, `applyIR`, `parsePatch`, `compileTextPatchSet`, types. Builders and compilers return data; they do not print. Callers choose whether/how to display it, once.
