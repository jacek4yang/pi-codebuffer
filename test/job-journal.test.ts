import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JobJournal,
  processIdentity,
  isAlive,
} from "../src/runtime/job-journal.js";

test("journal has one live owner, bounded snapshots and nonce-safe repeated close", () => {
  const root = mkdtempSync(join(tmpdir(), "job-journal-"));
  try {
    const first = new JobJournal(root);
    assert.throws(() => new JobJournal(root), /JOB_STORE_BUSY/);
    first.save([{ id: "fixture", state: "completed" }]);
    assert.throws(() => first.save(["x".repeat(65536)]), /JOB_JOURNAL_QUOTA/);
    first.close();
    const second = new JobJournal(root);
    assert.deepEqual(second.load(), [{ id: "fixture", state: "completed" }]);
    first.close();
    assert.throws(() => new JobJournal(root), /JOB_STORE_BUSY/);
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("stale process identity is not treated as ownership; malformed admission fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "job-journal-"));
  try {
    const current = processIdentity(process.pid)!;
    assert(isAlive(current));
    assert(!isAlive({ ...current, start: current.start + "1" }));
    writeFileSync(
      join(root, ".owner"),
      JSON.stringify({ ...current, start: current.start + "1" }),
      { mode: 0o600 },
    );
    const journal = new JobJournal(root);
    journal.close();
    writeFileSync(join(root, ".admission"), "interrupted", { mode: 0o600 });
    assert.throws(() => new JobJournal(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
