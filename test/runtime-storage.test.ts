import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeStorage } from "../src/runtime/storage.js";
import { processIdentity } from "../src/runtime/job-journal.js";

const id = (n: number) => n.toString(16).padStart(64, "0");

test("runtime storage evicts oldest inactive sessions but never a live owner or job", () => {
  const parent = mkdtempSync(join(tmpdir(), "runtime-storage-"));
  const root = join(parent, "runtime");
  try {
    for (let n = 0; n < 8; n++)
      runtimeStorage(
        root,
        id(n),
        (path) => {
          if (n < 2) {
            const jobs = join(path, "jobs");
            mkdirSync(jobs, { mode: 0o700 });
            const process = processIdentity(globalThis.process.pid)!;
            const value =
              n === 0
                ? { ...process, nonce: "fixture" }
                : { version: 1, records: [{ process }] };
            writeFileSync(
              join(jobs, n === 0 ? ".owner" : ".jobs.json"),
              JSON.stringify(value),
              { mode: 0o600 },
            );
          }
        },
        100 + n,
      );
    runtimeStorage(root, id(8), () => {}, 1000);
    assert.ok(existsSync(join(root, id(0))));
    assert.ok(existsSync(join(root, id(1))));
    assert.ok(!existsSync(join(root, id(2))));
    assert.ok(existsSync(join(root, id(8))));
    runtimeStorage(root, id(8), () => {}, 86400000 + 2000);
    assert.ok(!existsSync(join(root, id(3))));
    assert.ok(existsSync(join(root, id(0))));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runtime storage rejects unowned and linked artifacts instead of deleting them", () => {
  const parent = mkdtempSync(join(tmpdir(), "runtime-storage-"));
  const root = join(parent, "runtime");
  try {
    runtimeStorage(root, id(0), () => {});
    const target = join(parent, "keep");
    writeFileSync(target, "important");
    symlinkSync(target, join(root, id(0), "linked"));
    assert.throws(
      () => runtimeStorage(root, id(1), () => {}, Date.now() + 86400001),
      /UNSAFE_RUNTIME_ARTIFACT/,
    );
    assert.ok(existsSync(target));
    assert.ok(existsSync(join(root, id(0))));
    rmSync(join(root, id(0), "linked"));
    assert.doesNotThrow(() => runtimeStorage(root, id(1), () => {}));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
