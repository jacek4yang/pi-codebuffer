import { randomUUID } from "node:crypto";
import { bytes, hash, MAX_SOURCE } from "./text.js";
import { applyIR, compileEdit, validText, type EditIR } from "./edit.js";
export { bytes, hash, MAX_SOURCE } from "./text.js";
import { parse } from "acorn";

export const ENTRY = "pi-codebuffer.v1";
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
  return applyIR(
    source,
    compileEdit(source, { format: "replace", edits: [{ old, replacement }] }),
  );
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
  edit?: EditIR;
  snapshot?: { source: string; hash: string };
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
  edit?: EditIR,
): Revision {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
    throw new Error("INVALID_NAME: use 1–64 letters, digits, _ or -");
  validText(source);
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
    ...(patch ? { patch } : edit ? { edit } : { source }),
    ...(previous && (previous.metadata.revision + 1) % 64 === 0
      ? { snapshot: { source, hash: hash(source) } }
      : {}),
  };
}
export class State {
  buffers = new Map<string, Materialized[]>();
  active = new Set<string>();
  private sources = new Map<string, string>();
  cacheBytes = 0;
  private retain(id: string, source: string): void {
    const existing = this.sources.get(id);
    if (existing !== undefined) {
      this.cacheBytes -= bytes(existing);
      this.sources.delete(id);
    }
    if (bytes(source) > this.cacheBudget) return;
    while (
      this.cacheBytes + bytes(source) > this.cacheBudget ||
      this.sources.size >= 4096
    ) {
      const first = this.sources.keys().next().value!;
      this.cacheBytes -= bytes(this.sources.get(first)!);
      this.sources.delete(first);
    }
    this.sources.set(id, source);
    this.cacheBytes += bytes(source);
  }
  private materialize(chain: Materialized[], position: number): string {
    let start = position;
    while (
      start > 0 &&
      !this.sources.has(chain[start]!.metadata.id) &&
      !chain[start]!.metadata.snapshot
    )
      start--;
    let source =
      this.sources.get(chain[start]!.metadata.id) ??
      chain[start]!.metadata.snapshot?.source ??
      chain[start]!.metadata.source;
    if (source === undefined) throw new Error("STATE_CORRUPT");
    for (let i = start + 1; i <= position; i++) {
      const r = chain[i]!.metadata;
      source = r.edit
        ? applyIR(source, r.edit)
        : exact(source, r.patch!.old, r.patch!.replacement);
      if (hash(source) !== r.hash) throw new Error("STATE_CORRUPT");
    }
    const target = chain[position]!.metadata;
    if (hash(source) !== target.hash) throw new Error("STATE_CORRUPT");
    this.retain(target.id, source);
    return source;
  }
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
    readonly cacheBudget = 32 * 1024 * 1024,
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
  apply(data: unknown): void {
    if (!data || typeof data !== "object") throw new Error();
    const e = data as Event;
    if ((e as { kind: string }).kind === "retire") {
      const name = (e as unknown as { name: string }).name;
      const chain = this.buffers.get(name);
      if (!chain) throw new Error("STATE_CORRUPT");
      this.active.delete(name);
      for (const r of chain) {
        const old = this.sources.get(r.metadata.id);
        if (old !== undefined) {
          this.cacheBytes -= bytes(old);
          this.sources.delete(r.metadata.id);
        }
      }
      return;
    }
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
        (!e.edit &&
          (!e.patch ||
            typeof e.patch.old !== "string" ||
            typeof e.patch.replacement !== "string")) ||
        (!!e.edit && !!e.patch)
      )
        throw new Error();
      source = e.edit
        ? applyIR(previous.source, e.edit)
        : exact(previous.source, e.patch!.old, e.patch!.replacement);
    } else {
      if (
        e.patch !== undefined ||
        e.edit !== undefined ||
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
    if (
      e.snapshot &&
      (e.snapshot.source !== source || e.snapshot.hash !== e.hash)
    )
      throw new Error("STATE_CORRUPT: snapshot");
    if (!previous) this.active.add(e.name);
    const position = chain.length;
    const materialize = () => this.materialize(chain, position);
    this.retain(e.id, source);
    chain.push({
      metadata: e,
      get source() {
        return materialize();
      },
    });
    this.buffers.set(e.name, chain);
    this.metrics.buffers = this.buffers.size;
    this.metrics.revisions++;
    if (!e.syntax.valid) this.metrics.syntaxFailures++;
    if (e.patch || e.edit) {
      const payload = bytes(JSON.stringify(e.patch ?? e.edit));
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
      metrics: { ...this.metrics, buffers: this.active.size },
      retiredHistories: this.buffers.size - this.active.size,
      buffers: [...this.buffers]
        .filter(([n]) => (name === undefined ? this.active.has(n) : n === name))
        .map(([n, chain]) => ({
          name: n,
          revisions: chain.length,
          head: summary(chain.at(-1)!),
        })),
    };
  }
}
export function summary(r: Materialized): object {
  const {
    source: _source,
    patch: _patch,
    edit: _edit,
    snapshot: _snapshot,
    ...metadata
  } = r.metadata;
  void _edit;
  void _snapshot;
  void _source;
  void _patch;
  return { ...metadata, sourceBytes: bytes(r.source) };
}
