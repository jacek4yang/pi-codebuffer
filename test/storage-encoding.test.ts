import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScratchStore } from "../src/scratch.js";
import { revision, hash } from "../src/state.js";
import { compileTextPatchSet } from "../src/patch-set.js";

test("serialized storage expansion is budgeted, retained eighth source is readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "codebuffer-encoding-"));
  try {
    const store = new ScratchStore(join(dir, "owned"));
    let r = store.create(
      "s",
      null,
      "//" + String.fromCharCode(1).repeat(200000) + "\ntext(0);",
    );
    r.execution = "failed";
    store.update(r, r.revisions[0]!.metadata.id);
    for (let i = 1; i <= 7; i++) {
      r = store.repair({
        ref: r.ref,
        session: "s",
        ancestry: new Set(),
        base: r.revisions.at(-1)!.metadata.id,
        anchor: null,
        run: false,
        edit: {
          format: "replace",
          edits: [
            { old: "text(" + (i - 1) + ");", replacement: "text(" + i + ");" },
          ],
        },
      });
    }
    const restored = store.get(r.ref, "s", new Set());
    assert.equal(restored.revisions.length, 8);
    assert(restored.revisions.at(-1)!.source.endsWith("text(7);"));
    assert(
      (store.status() as { diskBytes: number }).diskBytes < 64 * 1024 * 1024,
    );
    assert(readdirSync(store.root).length <= 2);
    assert.throws(
      () => revision("a", String.fromCharCode(0)),
      /UNSUPPORTED_TEXT/,
    );
    assert.throws(
      () => revision("a", String.fromCharCode(0xd800)),
      /UNSUPPORTED_TEXT/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unowned directory and stale lock never get reclaimed; move-only patch stays pure", () => {
  const dir = mkdtempSync(join(tmpdir(), "codebuffer-owned-"));
  try {
    writeFileSync(join(dir, "unrelated"), "data");
    assert.throws(
      () => new ScratchStore(dir).create("s", null, "text(1);"),
      /nonempty unmarked/,
    );
    assert(existsSync(join(dir, "unrelated")));
    const store = new ScratchStore(join(dir, "owned"));
    store.create("s", null, "text(1);");
    mkdirSync(join(store.root, "lock"), { mode: 0o700 });
    writeFileSync(join(store.root, "lock/owner"), "2147483647", {
      mode: 0o600,
    });
    assert.throws(
      () => store.status(),
      /SCRATCH_RECOVERY_REQUIRED|SCRATCH_BUSY/,
    );
    assert(existsSync(join(store.root, "lock/owner")));
    const bases = new Map([["a", { source: "hello", hash: hash("hello") }]]);
    const plan = compileTextPatchSet(
      bases,
      "*** Begin Patch\n*** Update File: a\n*** Move to: b\n*** End Patch",
    );
    assert.deepEqual(
      plan.map((p) => p.kind),
      ["delete", "create"],
    );
    assert.equal(bases.get("a")!.source, "hello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
