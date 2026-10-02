import { createHash, randomUUID } from "node:crypto";
import { parse } from "acorn";

export const ENTRY = "pi-codebuffer.v1";
export const MAX_SOURCE = 262144;
export const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
export const hash = (s: string): string =>
  createHash("sha256").update(s).digest("hex");
export type Syntax =
  | { valid: true }
  | { valid: false; error: string; line: number; column: number };
export function syntax(source: string): Syntax {
  try {
    const tree = parse("async function __codebuffer__(){\n" + source + "\n}", {
      ecmaVersion: "latest",
      locations: true,
    });
    if (
      tree.body.length !== 1 ||
      tree.body[0]?.type !== "FunctionDeclaration"
    ) {
      return {
        valid: false,
        error: "Source must be an async function body",
        line: Math.max(1, (tree.body[1]?.loc?.start.line ?? 2) - 1),
        column: (tree.body[1]?.loc?.start.column ?? 0) + 1,
      };
    }
    return { valid: true };
  } catch (error) {
    const e = error as SyntaxError & { loc?: { line: number; column: number } };
    return {
      valid: false,
      error: e.message.replace(/ \(\d+:\d+\)$/, ""),
      line: Math.max(1, (e.loc?.line ?? 2) - 1),
      column: (e.loc?.column ?? 0) + 1,
    };
  }
}
export function exact(
  source: string,
  old: string,
  replacement: string,
): string {
  if (!old) throw new Error("PATCH_EMPTY: old must not be empty");
  const at = source.indexOf(old);
  if (at < 0) throw new Error("PATCH_NOT_FOUND");
  if (source.indexOf(old, at + 1) >= 0) throw new Error("PATCH_AMBIGUOUS");
  return source.slice(0, at) + replacement + source.slice(at + old.length);
}
export interface Revision {
  kind: "revision";
  name: string;
  revision: number;
  id: string;
  parent: string | null;
  hash: string;
  timestamp: string;
  syntax: Syntax;
  source?: string;
  patch?: { old: string; replacement: string };
}
export interface Metric {
  kind: "metric";
  metric: "runs" | "patchFailures";
  bytes: number;
}
export type Event = Revision | Metric;
export interface Materialized {
  metadata: Revision;
  source: string;
}
export function revision(
  name: string,
  source: string,
  previous?: Materialized,
  patch?: Revision["patch"],
): Revision {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
    throw new Error("INVALID_NAME: use 1–64 letters, digits, _ or -");
  if (bytes(source) > MAX_SOURCE)
    throw new Error("SOURCE_TOO_LARGE: maximum 256 KiB UTF-8");
  return {
    kind: "revision",
    name,
    revision: (previous?.metadata.revision ?? 0) + 1,
    id: randomUUID(),
    parent: previous?.metadata.id ?? null,
    hash: hash(source),
    timestamp: new Date().toISOString(),
    syntax: syntax(source),
    ...(patch ? { patch } : { source }),
  };
}
export class State {
  buffers = new Map<string, Materialized[]>();
  metrics = {
    buffers: 0,
    revisions: 0,
    runs: 0,
    patchBytes: 0,
    reconstructedSourceBytes: 0,
    estimatedAvoidedRegenerationBytes: 0,
    patchFailures: 0,
    syntaxFailures: 0,
  };
  constructor(
    entries: readonly { type: string; customType?: string; data?: unknown }[],
  ) {
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      try {
        this.apply(entry.data);
      } catch {
        throw new Error(
          "STATE_CORRUPT: invalid CodeBuffer entry; do not run or replace it",
        );
      }
    }
  }
  private apply(data: unknown): void {
    if (!data || typeof data !== "object") throw new Error();
    const e = data as Event;
    if (e.kind === "metric") {
      if (
        !["runs", "patchFailures"].includes(e.metric) ||
        !Number.isSafeInteger(e.bytes) ||
        e.bytes < 0
      )
        throw new Error();
      this.metrics[e.metric]++;
      if (e.metric === "runs") this.metrics.reconstructedSourceBytes += e.bytes;
      return;
    }
    if (
      e.kind !== "revision" ||
      typeof e.name !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(e.name) ||
      typeof e.id !== "string" ||
      !e.id ||
      typeof e.timestamp !== "string" ||
      !Number.isFinite(Date.parse(e.timestamp))
    )
      throw new Error();
    const chain = this.buffers.get(e.name) ?? [];
    const previous = chain.at(-1);
    if (
      e.revision !== chain.length + 1 ||
      e.parent !== (previous?.metadata.id ?? null)
    )
      throw new Error();
    let source: string;
    if (previous) {
      if (
        e.source !== undefined ||
        !e.patch ||
        typeof e.patch.old !== "string" ||
        typeof e.patch.replacement !== "string"
      )
        throw new Error();
      source = exact(previous.source, e.patch.old, e.patch.replacement);
    } else {
      if (
        e.patch !== undefined ||
        typeof e.source !== "string" ||
        this.buffers.size >= 64
      )
        throw new Error();
      source = e.source;
    }
    if (
      bytes(source) > MAX_SOURCE ||
      hash(source) !== e.hash ||
      JSON.stringify(syntax(source)) !== JSON.stringify(e.syntax) ||
      chain.some((r) => r.metadata.id === e.id)
    )
      throw new Error();
    chain.push({ metadata: e, source });
    this.buffers.set(e.name, chain);
    this.metrics.buffers = this.buffers.size;
    this.metrics.revisions++;
    if (!e.syntax.valid) this.metrics.syntaxFailures++;
    if (e.patch) {
      const payload = bytes(JSON.stringify(e.patch));
      this.metrics.patchBytes += payload;
      this.metrics.estimatedAvoidedRegenerationBytes += Math.max(
        0,
        bytes(source) - payload,
      );
    }
  }
  get(name: string, number?: number): Materialized {
    const chain = this.buffers.get(name);
    const found = number === undefined ? chain?.at(-1) : chain?.[number - 1];
    if (!found)
      throw new Error(
        "REVISION_NOT_FOUND: " + name + (number ? "@" + number : ""),
      );
    return found;
  }
  status(name?: string): object {
    return {
      metrics: this.metrics,
      buffers: [...this.buffers]
        .filter(([n]) => name === undefined || n === name)
        .map(([n, chain]) => ({
          name: n,
          revisions: chain.length,
          head: summary(chain.at(-1)!),
        })),
    };
  }
}
export function summary(r: Materialized): object {
  const { source: _source, patch: _patch, ...metadata } = r.metadata;
  void _source;
  void _patch;
  return { ...metadata, sourceBytes: bytes(r.source) };
}
