// Deliberate Windows CI boundary: not part of Linux *.test.ts glob.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScratchStore } from "../src/scratch.js";
test("Windows private-ACL incompatibility is explicit and performs no scratch write", () => {
  assert.equal(process.platform, "win32");
  const dir = mkdtempSync(join(tmpdir(), "codebuffer-win-"));
  try {
    const path = join(dir, "scratch");
    assert.throws(
      () => new ScratchStore(path).create("windows", null, "text(1);"),
      /INCOMPATIBLE_SCRATCH_ACL/,
    );
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
