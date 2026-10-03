import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { ScratchStore, defaults } from "../src/scratch.js";
import { BranchIndex } from "../src/index-cache.js";
import { ENTRY, hash, type Revision } from "../src/state.js";
const timed = <T>(f: () => T) => {
  const start = performance.now();
  const value = f();
  return { ms: performance.now() - start, value };
};
const stats = (values: number[]) => {
  const a = [...values].sort((a, b) => a - b);
  return {
    p50: a[Math.floor(a.length * 0.5)],
    p95: a[Math.min(a.length - 1, Math.floor(a.length * 0.95))],
    max: a.at(-1),
  };
};
const dir = mkdtempSync(join(tmpdir(), "codebuffer-saturation-"));
const output: { scratch?: unknown; legacy: unknown[]; rssPeakBytes?: number } =
  { legacy: [] };
try {
  const store = new ScratchStore(join(dir, "owned"), {
    ...defaults,
    successes: 64,
    failures: 64,
  });
  const build = timed(() => {
    for (let i = 0; i < 1024; i++) {
      const r = store.create(
        "session" + Math.floor(i / 32),
        null,
        "//" + "x".repeat(12000) + "\ntext(" + i + ");",
      );
      r.execution = i % 3 === 0 ? "failed" : "completed";
      store.update(r, r.revisions[0]!.metadata.id);
    }
  });
  console.error("scratch built", build.ms);
  const status = Array.from(
    { length: 30 },
    () => timed(() => store.status()).ms,
  );
  const reopen = timed(() =>
    new ScratchStore(store.root, store.limits).status(),
  );
  const overflow = store.create("new-session", null, "text(1);");
  overflow.execution = "completed";
  store.update(overflow, overflow.revisions[0]!.metadata.id);
  const state = store.status() as { handles: number; diskBytes: number };
  assert.equal(state.handles, 1024);
  assert(state.diskBytes <= store.limits.scratchBytes);
  output.scratch = {
    buildMs: build.ms,
    statusMs: stats(status),
    reopenMs: reopen.ms,
    state: store.status(),
  };
  console.error("scratch complete", JSON.stringify(output.scratch));
  for (const count of [10000, 50000]) {
    console.error("legacy start", count);
    const entries: {
      id: string;
      type: string;
      customType: string;
      data: Revision;
    }[] = [];
    let parent: string | null = null;
    for (let i = 0; i < count; i++) {
      const source = "text(" + (i % 2) + ");";
      const id = randomUUID();
      const r: Revision = {
        kind: "revision",
        name: "legacy",
        revision: i + 1,
        id,
        parent,
        hash: hash(source),
        timestamp: "2026-01-01T00:00:00.000Z",
        syntax: { valid: true },
        ...(i
          ? { patch: { old: String((i - 1) % 2), replacement: String(i % 2) } }
          : { source }),
      };
      entries.push({ id, type: "custom", customType: ENTRY, data: r });
      parent = id;
    }
    const index = new BranchIndex();
    const before = process.memoryUsage();
    const first = timed(
      () => index.get("session", entries).get("legacy").source,
    );
    console.error("legacy first", count, first.ms);
    const cached = Array.from(
      { length: 10 },
      () => timed(() => index.get("session", entries).get("legacy").source).ms,
    );
    const branch = timed(
      () =>
        index.get("session", entries.slice(0, count / 2)).get("legacy").source,
    );
    const restart = timed(
      () => new BranchIndex().get("session", entries).get("legacy").source,
    );
    output.legacy.push({
      count,
      firstMs: first.ms,
      cachedMs: stats(cached),
      branchMs: branch.ms,
      restartMs: restart.ms,
      heapDeltaBytes: process.memoryUsage().heapUsed - before.heapUsed,
      index: index.status(),
    });
  }
  output.rssPeakBytes = process.resourceUsage().maxRSS * 1024;
  const json = JSON.stringify(output, null, 2) + "\n";
  if (process.argv[2]) writeFileSync(process.argv[2], json);
  console.log(json);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
