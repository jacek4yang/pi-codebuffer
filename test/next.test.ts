import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { harness, jsonOf, textOf } from "./harness.js";
import { compileEdit, applyIR } from "../src/edit.js";
import { ScratchStore, defaults } from "../src/scratch.js";
import { ENTRY } from "../src/state.js";

test("canonical replace/range/strict patch agree, validate complete batches and Unicode boundaries", () => {
  const base = "first\nsecond\n";
  const expected = "first\nlast\n";
  for (const edit of [
    {
      format: "replace" as const,
      edits: [{ old: "second", replacement: "last" }],
    },
    { format: "range" as const, edits: [{ start: 6, end: 12, text: "last" }] },
    {
      format: "apply_patch" as const,
      patch:
        "*** Begin Patch\n*** Update File: buffer\n@@\n first\n-second\n+last\n*** End Patch",
    },
  ])
    assert.equal(applyIR(base, compileEdit(base, edit)), expected);
  assert.throws(
    () =>
      compileEdit(base, {
        format: "replace",
        edits: [
          { old: "first", replacement: "a" },
          { old: "second", replacement: "b" },
          { old: "missing", replacement: "c" },
        ],
      }),
    /PATCH_NOT_FOUND/,
  );
  assert.equal(base, "first\nsecond\n");
  assert.throws(
    () =>
      compileEdit("aaa", {
        format: "replace",
        edits: [{ old: "aa", replacement: "b", count: 2 }],
      }),
    /EDIT_OVERLAP/,
  );
  assert.throws(
    () =>
      compileEdit("🙂", {
        format: "range",
        edits: [{ start: 1, end: 2, text: "" }],
      }),
    /INVALID_RANGE/,
  );
  assert.equal(
    applyIR(
      "",
      compileEdit("", {
        format: "range",
        edits: [{ start: 0, end: 0, text: "🙂" }],
      }),
    ),
    "🙂",
  );
  assert.equal(
    applyIR(
      "\ufeffx\r\ny\r\n",
      compileEdit("\ufeffx\r\ny\r\n", {
        format: "replace",
        edits: [{ old: "y", replacement: "z" }],
      }),
    ),
    "\ufeffx\r\nz\r\n",
  );
  assert.throws(
    () =>
      compileEdit(base, {
        format: "apply_patch",
        patch:
          "*** Begin Patch\n*** Update File: buffer\n@@\n-first\n+a\n@@\nbad\n*** End Patch",
      }),
    /PATCH_DIALECT/,
  );
});

test("scratch store bounded steady state, restart, branch isolation and explicit expiry", () => {
  const dir = mkdtempSync(join(tmpdir(), "codebuffer-store-"));
  try {
    const limits = {
      ...defaults,
      successes: 2,
      failures: 2,
      scratchBytes: 16000,
    };
    const store = new ScratchStore(join(dir, "owned"), limits);
    let first = "";
    for (let i = 0; i < 1000; i++) {
      const r = store.create("s", "root", "text(" + i + ");");
      if (!i) first = r.ref;
      r.execution = "completed";
      store.update(r, r.revisions[0]!.metadata.id);
      assert(
        readdirSync(store.root).filter((n) => n.endsWith(".json")).length <= 2,
      );
    }
    assert.throws(
      () => store.get(first, "s", new Set(["root"])),
      /SOURCE_EXPIRED/,
    );
    const failed = store.create("s", "child", "throw 1;");
    failed.execution = "failed";
    failed.delegated = true;
    store.update(failed, failed.revisions[0]!.metadata.id);
    const reopened = new ScratchStore(store.root, limits);
    assert.equal(
      reopened.get(failed.ref, "s", new Set(["child"])).revisions[0]!.source,
      "throw 1;",
    );
    assert.throws(
      () => reopened.get(failed.ref, "s", new Set(["root"])),
      /SOURCE_EXPIRED/,
    );
    assert.equal(statSync(store.root).mode & 0o777, 0o700);
    assert((store.status() as { diskBytes: number }).diskBytes <= 16000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real SDK fused syntax repair and acknowledged runtime repair; scratch never adds durable source", async () => {
  let calls = 0;
  const h = await harness({
    factories: [
      (pi) => {
        pi.on("tool_call", (e) => {
          if (e.toolName === "codemode") calls++;
        });
      },
    ],
  });
  try {
    const s = await h.make();
    const bad = await h.call(s, {
      action: "exec",
      source: "// " + "padding".repeat(1500) + "\ntext(42;",
    });
    assert.equal(bad.isError, true, textOf(bad));
    assert.equal(calls, 0);
    const metadata = jsonOf(bad);
    const repair = {
      action: "repair",
      ref: metadata.ref,
      base: metadata.base,
      edit: { format: "replace", edits: [{ old: "42;", replacement: "42);" }] },
    };
    const fixed = await h.call(s, repair);
    assert.equal(fixed.isError, false, textOf(fixed));
    assert.equal(calls, 1);
    assert.match(textOf(fixed), /42/);
    assert.equal((await h.call(s, repair)).isError, true);
    assert.equal(calls, 1);
    const runtime = await h.call(s, {
      action: "exec",
      source: "text(1); throw new Error(2);",
    });
    const r = jsonOf(runtime);
    assert.equal(runtime.isError, true);
    assert.equal(calls, 2);
    const request = {
      action: "repair",
      ref: r.ref,
      base: r.base,
      edit: {
        format: "replace",
        edits: [{ old: "throw new Error(2);", replacement: "text(3);" }],
      },
    };
    assert.match(textOf(await h.call(s, request)), /RERUN_ACK_REQUIRED/);
    const file = s.sessionManager.getSessionFile()!;
    s.dispose();
    const resumed = await h.make(SessionManager.open(file));
    const good = await h.call(resumed, { ...request, rerun: "from-start" });
    assert.equal(good.isError, false, textOf(good));
    assert.equal(calls, 3);
    assert(
      !resumed.sessionManager
        .getBranch()
        .some((e) => e.type === "custom" && e.customType === ENTRY),
    );
  } finally {
    await h.close();
  }
});
