import { hash, bytes, MAX_SOURCE } from "./text.js";
import { parsePatch, type Chunk } from "./patch.js";

/** Version 1: UTF-16 half-open splices against ONE immutable base. Pure: no I/O. */
export interface Splice {
  start: number;
  end: number;
  text: string;
}
export interface EditIR {
  version: 1;
  baseHash: string;
  splices: Splice[];
}
export type EditRequest =
  | {
      format: "replace";
      edits: { old: string; replacement: string; count?: number }[];
    }
  | { format: "range"; edits: Splice[] }
  | { format: "apply_patch"; patch: string };
export function boundary(s: string, n: number): boolean {
  return (
    Number.isSafeInteger(n) &&
    n >= 0 &&
    n <= s.length &&
    !(
      n > 0 &&
      n < s.length &&
      /[\uD800-\uDBFF]/.test(s[n - 1]!) &&
      /[\uDC00-\uDFFF]/.test(s[n]!)
    )
  );
}
export function validText(s: string): void {
  if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      s,
    ) ||
    s.includes("\0")
  )
    throw new Error("UNSUPPORTED_TEXT: invalid Unicode or NUL");
}
export function applyIR(base: string, ir: EditIR): string {
  if (ir.version !== 1 || ir.baseHash !== hash(base))
    throw new Error("STALE_SNAPSHOT");
  validText(base);
  if (ir.splices.length > 1024) throw new Error("EDIT_LIMIT");
  const sorted = [...ir.splices].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  let end = -1;
  let start = -1;
  for (const s of sorted) {
    if (!boundary(base, s.start) || !boundary(base, s.end) || s.end < s.start)
      throw new Error("INVALID_RANGE");
    if (s.start < end || s.start === start) throw new Error("EDIT_OVERLAP");
    validText(s.text);
    end = s.end;
    start = s.start;
  }
  const size =
    bytes(base) +
    sorted.reduce(
      (n, s) => n + bytes(s.text) - bytes(base.slice(s.start, s.end)),
      0,
    );
  if (size > MAX_SOURCE) throw new Error("SOURCE_TOO_LARGE");
  let offset = 0;
  const parts: string[] = [];
  for (const s of sorted) {
    parts.push(base.slice(offset, s.start), s.text);
    offset = s.end;
  }
  parts.push(base.slice(offset));
  return parts.join("");
}
export function compileEdit(base: string, request: EditRequest): EditIR {
  if (bytes(JSON.stringify(request)) > 2 * MAX_SOURCE)
    throw new Error("EDIT_LIMIT");
  let splices: Splice[];
  if (request.format === "range") splices = request.edits;
  else if (request.format === "replace") {
    if (!request.edits.length || request.edits.length > 1024)
      throw new Error("EDIT_LIMIT");
    splices = request.edits.flatMap((e, i) => {
      if (!e.old) throw new Error("PATCH_EMPTY: operation " + i);
      const positions: number[] = [];
      for (
        let p = base.indexOf(e.old);
        p >= 0;
        p = base.indexOf(e.old, p + 1)
      ) {
        positions.push(p);
        if (positions.length > 1024) throw new Error("EDIT_LIMIT");
      }
      if (!positions.length) throw new Error("PATCH_NOT_FOUND: operation " + i);
      if (positions.length !== (e.count ?? 1))
        throw new Error("PATCH_AMBIGUOUS: operation " + i);
      return positions.map((start) => ({
        start,
        end: start + e.old.length,
        text: e.replacement,
      }));
    });
  } else if (request.format === "apply_patch")
    splices = bufferPatch(base, request.patch);
  else throw new Error("UNSUPPORTED_FORMAT");
  const ir: EditIR = {
    version: 1,
    baseHash: hash(base),
    splices: splices.map((s) => ({ ...s })),
  };
  applyIR(base, ir);
  return ir;
}
/** Strict local Codex-style single virtual-file dialect. No fuzzy relocation. */
function bufferPatch(base: string, patch: string): Splice[] {
  const files = parsePatch(patch);
  const f = files[0];
  if (
    files.length !== 1 ||
    f?.kind !== "update" ||
    f.path !== "buffer" ||
    f.move
  )
    throw new Error("PATCH_DIALECT: expected one Update File: buffer");
  return compileChunks(base, f.chunks);
}
export function compileChunks(base: string, chunks: Chunk[]): Splice[] {
  const newline = base.includes("\r\n") ? "\r\n" : "\n";
  if (newline === "\r\n" && base.replaceAll("\r\n", "").includes("\n"))
    throw new Error("UNSUPPORTED_TEXT: mixed newlines");
  const result: Splice[] = [];
  for (const { oldLines: before, newLines: after, eof, context } of chunks) {
    let from = 0;
    if (context !== undefined) {
      const needle = context + newline;
      const at = base.indexOf(needle);
      if (
        at < 0 ||
        base.indexOf(needle, at + 1) >= 0 ||
        (at > 0 && base[at - 1] !== "\n")
      )
        throw new Error(
          "PATCH_AMBIGUOUS: context must identify one complete line",
        );
      from = at + needle.length;
    }
    if (!before.length)
      throw new Error(
        "PATCH_DIALECT: insertion needs context; use range for empty source",
      );
    let old = before.join(newline);
    let replacement = after.join(newline);
    // Hunks describe complete lines; preserve EOF newline state.
    if (!eof || base.endsWith(newline)) {
      old += newline;
      if (after.length) replacement += newline;
    }
    const start = base.indexOf(old, from);
    if (start < 0) throw new Error("PATCH_NOT_FOUND: hunk " + result.length);
    if (base.indexOf(old, start + 1) >= 0)
      throw new Error("PATCH_AMBIGUOUS: hunk " + result.length);
    if (start > 0 && base[start - 1] !== "\n")
      throw new Error("PATCH_NOT_FOUND: not a line boundary");
    if (eof && start + old.length !== base.length)
      throw new Error("PATCH_NOT_FOUND: EOF");
    result.push({ start, end: start + old.length, text: replacement });
  }
  return result;
}
