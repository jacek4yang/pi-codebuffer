/** PURE multi-text planning only. This does not read, authorize or write files. */
import { parsePatch } from "./patch.js";
import { applyIR, compileChunks, validText, type EditIR } from "./edit.js";
import { hash, bytes, MAX_SOURCE } from "./text.js";
export type TextChange =
  | { kind: "create"; path: string; source: string }
  | { kind: "delete"; path: string; baseHash: string }
  | { kind: "splice"; path: string; ir: EditIR };
export function compileTextPatchSet(
  bases: ReadonlyMap<string, { source: string; hash: string }>,
  patch: string,
): TextChange[] {
  const files = parsePatch(patch);
  const touched = new Set<string>();
  const result: TextChange[] = [];
  const claim = (path: string) => {
    if (
      !path ||
      path.includes("\\") ||
      path.includes(":") ||
      path.startsWith("/") ||
      path
        .split("/")
        .some(
          (p) =>
            !p ||
            [".", "..", ".git", ".pi"].includes(p) ||
            p.endsWith(".") ||
            p.endsWith(" "),
        )
    )
      throw new Error("UNSAFE_PATH");
    const key = path.toLowerCase();
    if (touched.has(key)) throw new Error("TARGET_CONFLICT");
    touched.add(key);
  };
  for (const f of files) {
    claim(f.path);
    const base = bases.get(f.path);
    if (f.kind === "add") {
      if (base) throw new Error("TARGET_EXISTS");
      validText(f.source);
      if (bytes(f.source) > MAX_SOURCE) throw new Error("SOURCE_TOO_LARGE");
      result.push({ kind: "create", path: f.path, source: f.source });
      continue;
    }
    if (!base || hash(base.source) !== base.hash)
      throw new Error("STALE_SNAPSHOT: " + f.path);
    if (f.kind === "delete") {
      result.push({ kind: "delete", path: f.path, baseHash: base.hash });
      continue;
    }
    const ir: EditIR = {
      version: 1,
      baseHash: base.hash,
      splices: compileChunks(base.source, f.chunks),
    };
    const after = applyIR(base.source, ir);
    if (f.move) {
      claim(f.move);
      if (bases.has(f.move)) throw new Error("TARGET_EXISTS");
      result.push(
        { kind: "delete", path: f.path, baseHash: base.hash },
        { kind: "create", path: f.move, source: after },
      );
    } else result.push({ kind: "splice", path: f.path, ir });
  }
  return result;
}
