// Strict grammar adaptation of openai/codex parser.rs (Apache-2.0).
// See docs/PATCH_PROVENANCE.md. No upstream fuzzy matcher or filesystem executor.
import { bytes, MAX_SOURCE } from "./text.js";
export interface Chunk {
  context?: string;
  oldLines: string[];
  newLines: string[];
  eof: boolean;
}
export type PatchFile =
  | { kind: "add"; path: string; source: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; move?: string; chunks: Chunk[] };
export function parsePatch(patch: string): PatchFile[] {
  if (typeof patch !== "string" || bytes(patch) > 2 * MAX_SOURCE)
    throw new Error("PATCH_LIMIT");
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch")
    throw new Error("PATCH_DIALECT: missing strict envelope");
  const result: PatchFile[] = [];
  let i = 0;
  const isHeader = (s: string) => /^\*\*\* (Add|Update|Delete) File: /.test(s);
  while (i < lines.length) {
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++]!);
    if (!match)
      throw new Error(
        "PATCH_DIALECT: expected file directive at line " + (i + 1),
      );
    const path = match[2]!;
    if (match[1] === "Add") {
      const added: string[] = [];
      while (i < lines.length && !isHeader(lines[i]!)) {
        const l = lines[i++]!;
        if (!l.startsWith("+"))
          throw new Error("PATCH_DIALECT: add lines must start with +");
        added.push(l.slice(1));
      }
      result.push({
        kind: "add",
        path,
        source: added.length ? added.join("\n") + "\n" : "",
      });
    } else if (match[1] === "Delete") result.push({ kind: "delete", path });
    else {
      const entry: Extract<PatchFile, { kind: "update" }> = {
        kind: "update",
        path,
        chunks: [],
      };
      if (lines[i]?.startsWith("*** Move to: "))
        entry.move = lines[i++]!.slice(13);
      while (i < lines.length && !isHeader(lines[i]!)) {
        const header = lines[i++]!;
        if (header !== "@@" && !header.startsWith("@@ "))
          throw new Error("PATCH_DIALECT: expected @@ at line " + (i + 1));
        const chunk: Chunk = {
          oldLines: [],
          newLines: [],
          eof: false,
          ...(header.length > 2 ? { context: header.slice(3) } : {}),
        };
        while (
          i < lines.length &&
          !isHeader(lines[i]!) &&
          !lines[i]!.startsWith("@@")
        ) {
          const l = lines[i++]!;
          if (l === "*** End of File") {
            chunk.eof = true;
            break;
          }
          if (![" ", "+", "-"].includes(l[0] ?? ""))
            throw new Error("PATCH_DIALECT: malformed hunk at line " + (i + 1));
          if (l[0] !== "+") chunk.oldLines.push(l.slice(1));
          if (l[0] !== "-") chunk.newLines.push(l.slice(1));
        }
        if (!chunk.oldLines.length && !chunk.newLines.length)
          throw new Error("PATCH_DIALECT: empty hunk");
        entry.chunks.push(chunk);
        if (entry.chunks.length > 1024) throw new Error("PATCH_LIMIT");
        if (chunk.eof && i < lines.length && !isHeader(lines[i]!))
          throw new Error("PATCH_DIALECT: EOF must be final hunk");
      }
      if (!entry.chunks.length && !entry.move)
        throw new Error("PATCH_DIALECT: empty update");
      result.push(entry);
    }
    if (result.length > 64) throw new Error("PATCH_LIMIT");
  }
  if (!result.length) throw new Error("PATCH_DIALECT: empty envelope");
  return result;
}
