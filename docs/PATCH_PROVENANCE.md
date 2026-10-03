# Patch parser provenance

`src/patch.ts` adapts the small directive/chunk grammar and data model documented in OpenAI Codex `codex-rs/apply-patch/src/parser.rs`, inspected from https://github.com/openai/codex on 2026-10-03. Copyright OpenAI; Apache-2.0. The complete upstream license is distributed at `third-party/codex-APACHE-2.0.txt`. The rest of this project remains MIT.

Inspected reference file SHA-256: `6b8086467d0500f4fc9aa9a35cd33a0bce53c01bcb74b915b9efc6fcf187f7ce`.

This is a deliberately stricter TypeScript adaptation, not the complete upstream executor. It omits lenient parsing, shell/heredoc wrapping, fuzzy relocation and filesystem I/O. Unique-anchor compilation and the shared guarded splice IR are local implementations. Parser input, file count and hunk count are bounded. No Agents SDK or provider transport was added. Tests exercise malformed final hunks, multiple files, add/delete/move, ambiguity, overlap, Unicode, EOF and CRLF.
