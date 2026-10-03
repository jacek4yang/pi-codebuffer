import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScratchStore, defaults } from "../src/scratch.js";

test("bounded scratch metadata index skips unchanged payloads but never trusts changed records", () => {
  const dir = mkdtempSync(join(tmpdir(), "codebuffer-index-"));
  try {
    const store = new ScratchStore(join(dir, "owned"), {
      ...defaults,
      successes: 2,
      failures: 2,
    });
    for (let i = 0; i < 300; i++) {
      const r = store.create("s" + Math.floor(i / 4), null, "text(" + i + ");");
      r.execution = i % 2 ? "failed" : "completed";
      store.update(r, r.revisions[0]!.metadata.id);
    }
    const first = store.status() as { handles: number; indexEntries: number };
    assert.equal(first.handles, 300);
    assert.equal(first.indexEntries, 300);
    const reads = store.metrics.recordReads;
    store.status();
    assert.equal(store.metrics.recordReads, reads);
    const reopened = new ScratchStore(store.root, store.limits);
    reopened.status();
    assert.equal(reopened.metrics.recordReads, 300);
    reopened.status();
    assert.equal(reopened.metrics.recordReads, 300);
    const r = store.create("target", null, "text(1);");
    r.execution = "failed";
    store.update(r, r.revisions[0]!.metadata.id);
    const file = join(store.root, r.ref + ".json");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace("text(1);", "text(9);"));
    assert.throws(() => store.status(), /SCRATCH_CORRUPT/);
    writeFileSync(file, original);
    assert.equal(
      store.get(r.ref, "target", new Set()).revisions[0]!.source,
      "text(1);",
    );
    unlinkSync(file);
    assert.throws(
      () => store.get(r.ref, "target", new Set()),
      /SOURCE_EXPIRED/,
    );
    assert.equal(
      (store.status() as { indexEntries: number }).indexEntries,
      300,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
