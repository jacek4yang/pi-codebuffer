import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import {
  getAgentDir,
  withFileMutationQueue,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import {
  compileEdit,
  applyIR,
  parsePatch,
  boundary,
  validText,
  type EditRequest,
} from "../../editing.js";
import { prepare } from "./schema.js";
const MAX = 256 * 1024;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const abort = (s?: AbortSignal) => {
  if (s?.aborted) throw new Error("CANCELLED: no write attempted");
};
function guard(path: string) {
  const agent = resolve(getAgentDir());
  if (
    path === resolve(agent, "auth.json") ||
    path.startsWith(resolve(agent, "sessions") + sep) ||
    path.startsWith(resolve(homedir(), ".ssh") + sep) ||
    path.split(sep).includes(".git")
  )
    throw new Error("PROTECTED_PATH");
}
export async function edit(
  input: unknown,
  cwd: string,
  signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  const a = prepare(input);
  if (a.path.includes("\0") || a.path.includes("\n"))
    throw new Error("INVALID_PATH");
  const target = resolve(
    cwd,
    a.path.startsWith("~/") ? homedir() + a.path.slice(1) : a.path,
  );
  guard(target);
  return withFileMutationQueue(
    target,
    async (): Promise<AgentToolResult<unknown>> => {
      abort(signal);
      const canonical = await realpath(target);
      guard(canonical);
      abort(signal);
      const before = await stat(canonical);
      if (!before.isFile() || before.nlink !== 1)
        throw new Error(
          "UNSUPPORTED_TARGET: regular single-link file required",
        );
      if (before.size > MAX) throw new Error("FILE_TOO_LARGE: maximum 256 KiB");
      const f = await open(
        canonical,
        (a.format === "snapshot" ? constants.O_RDONLY : constants.O_RDWR) |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      let writing = false;
      try {
        const identity = await f.stat();
        if (
          !identity.isFile() ||
          identity.nlink !== 1 ||
          identity.ino !== before.ino ||
          identity.dev !== before.dev
        )
          throw new Error("TARGET_CHANGED");
        const buffer = Buffer.alloc(MAX + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await f.read(
            buffer,
            length,
            buffer.length - length,
            length,
          );
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > MAX) throw new Error("FILE_TOO_LARGE");
        const bytes = buffer.subarray(0, length);
        const base = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        validText(base);
        abort(signal);
        const baseHash = hash(base);
        if (a.base && a.base !== baseHash)
          throw new Error("STALE_BASE: reread a snapshot; file unchanged");
        if (a.format === "snapshot") {
          const start = a.offset ?? 0;
          let end = Math.min(base.length, start + (a.limit ?? 0));
          if (!boundary(base, start)) throw new Error("INVALID_RANGE");
          if (!boundary(base, end)) end--;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  base: baseHash,
                  units: base.length,
                  start,
                  end,
                  ...(a.limit ? { text: base.slice(start, end) } : {}),
                }),
              },
            ],
            details: undefined,
            structuredContent: {
              status: "snapshot",
              path: a.path,
              base: baseHash,
              units: base.length,
              start,
              end,
              text: base.slice(start, end),
            },
          };
        }
        let request: EditRequest;
        if (a.format === "apply_patch") {
          const parsed = parsePatch(a.patch!);
          const p = parsed[0];
          if (
            parsed.length !== 1 ||
            p?.kind !== "update" ||
            p.move ||
            resolve(cwd, p.path) !== target
          )
            throw new Error(
              "PATCH_PATH: one Update File matching outer path required",
            );
          request = {
            format: "apply_patch",
            patch: a.patch!.replace(
              "*** Update File: " + p.path,
              "*** Update File: buffer",
            ),
          };
        } else request = { format: a.format, edits: a.edits } as EditRequest;
        const ir = compileEdit(base, request);
        const next = applyIR(base, ir);
        const after = hash(next);
        const sorted = [...ir.splices].sort((a, b) => a.start - b.start);
        const firstChangedLine = sorted.length
          ? base.slice(0, sorted[0]!.start).split("\n").length
          : undefined;
        const changes = ir.splices.filter(
          (s) => base.slice(s.start, s.end) !== s.text,
        );
        const added = changes.reduce(
          (n, s) => n + s.text.split("\n").length - (s.text === "" ? 1 : 0),
          0,
        );
        const removed = changes.reduce(
          (n, s) =>
            n +
            base.slice(s.start, s.end).split("\n").length -
            (s.start === s.end ? 1 : 0),
          0,
        );
        if (after !== baseHash) {
          // Verify pathname identity and content again while retaining Pi's queue.
          if ((await realpath(target)) !== canonical)
            throw new Error("TARGET_CHANGED");
          const current = await stat(canonical);
          if (
            current.ino !== identity.ino ||
            current.dev !== identity.dev ||
            current.size !== bytes.length ||
            current.mtimeMs !== identity.mtimeMs ||
            current.ctimeMs !== identity.ctimeMs
          )
            throw new Error("TARGET_CHANGED");
          abort(signal);
          const data = Buffer.from(next);
          writing = true;
          for (let offset = 0; offset < data.length;) {
            const { bytesWritten } = await f.write(
              data,
              offset,
              data.length - offset,
              offset,
            );
            if (!bytesWritten) throw new Error("short write");
            offset += bytesWritten;
          }
          await f.truncate(data.length);
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                (after === baseHash ? "unchanged " : "edited ") +
                a.path +
                " (+" +
                added +
                "/-" +
                removed +
                "), base=" +
                after.slice(0, 12),
            },
          ],
          structuredContent: {
            status: after === baseHash ? "unchanged" : "committed",
            path: a.path,
            base: baseHash,
            after,
            format: a.format,
            operations: ir.splices.length,
            added,
            removed,
          },
          details: {
            firstChangedLine,
            diff: changes.slice(0, 16).map((s) => ({
              start: s.start,
              end: s.end,
              removed: base.slice(s.start, s.end).slice(0, 256),
              inserted: s.text.slice(0, 256),
            })),
            truncated:
              changes.length > 16 ||
              changes.some((s) => s.end - s.start > 256 || s.text.length > 256),
          },
        };
      } catch (error) {
        if (writing)
          throw new Error(
            "WRITE_FAILED: file may be partially changed; reread before retry: " +
              String(error),
          );
        throw error;
      } finally {
        await f.close();
      }
    },
  );
}
