import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { processIdentity } from "../src/runtime/job-journal.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScratchStore } from "../src/scratch.js";
import { Fused } from "../src/fused.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

test("live host identity pins source after its agent owner exits", () => {
  const root = mkdtempSync(join(tmpdir(), "host-pin-"));
  try {
    const store = new ScratchStore(join(root, "scratch"));
    const record = store.create("s", null, "sleep 10", { language: "bash" });
    record.process = processIdentity(process.pid)!;
    const base = record.revisions.at(-1)!.metadata.id;
    store.update(record, base);
    const path = join(store.root, record.ref + ".json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(saved.process, record.process);
    saved.pid = 2147483647;
    writeFileSync(path, JSON.stringify(saved));
    const reopened = new ScratchStore(store.root);
    assert.equal(reopened.get(record.ref, "s", new Set()).execution, "running");
    assert.throws(
      () =>
        reopened.repair({
          ref: record.ref,
          base,
          session: "s",
          ancestry: new Set(),
          anchor: null,
          run: false,
        }),
      /SCRATCH_BUSY/,
    );
    saved.process.start = "0";
    writeFileSync(path, JSON.stringify(saved));
    assert.equal(
      reopened.get(record.ref, "s", new Set()).execution,
      "interrupted",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host drafts accept incomplete syntax, preserve language and use guarded edits", () => {
  const root = mkdtempSync(join(tmpdir(), "host-buffer-"));
  try {
    const store = new ScratchStore(join(root, "scratch"));
    const draft = store.create("session", null, "def analyze(data):\n", {
      language: "python",
      run: false,
    });
    assert.equal(draft.language, "python");
    assert.equal(draft.execution, "not_started");
    const base = draft.revisions.at(-1)!.metadata.id;
    const next = store.repair({
      ref: draft.ref,
      session: "session",
      ancestry: new Set(),
      base,
      anchor: null,
      run: false,
      edit: {
        format: "range",
        edits: [{ start: 19, end: 19, text: "    return data\n" }],
      },
    });
    assert.equal(next.language, "python");
    assert.equal(next.execution, "not_started");
    assert.match(next.revisions.at(-1)!.source, /return data/);
    assert.throws(
      () =>
        store.repair({
          ref: draft.ref,
          session: "session",
          ancestry: new Set(),
          base,
          anchor: null,
          run: true,
        }),
      /STALE_REVISION/,
    );
    const run = store.repair({
      ref: draft.ref,
      session: "session",
      ancestry: new Set(),
      base: next.revisions.at(-1)!.metadata.id,
      anchor: null,
      run: true,
    });
    assert.equal(run.execution, "running");
    const fused = new Fused(store.root);
    const ctx = {
      sessionManager: {
        getSessionId: () => "session",
        getBranch: () => [],
        getLeafId: () => null,
      },
    } as unknown as ExtensionContext;
    assert.throws(
      () => fused.prepare({ action: "readScratch", ref: run.ref }, ctx),
      /LANGUAGE_MISMATCH/,
    );
    assert.equal(store.get(run.ref, "session", new Set()).execution, "running");
    assert.throws(
      () =>
        store.repair({
          ref: run.ref,
          session: "session",
          ancestry: new Set(),
          base: run.revisions.at(-1)!.metadata.id,
          anchor: null,
          run: false,
        }),
      /SCRATCH_BUSY/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
