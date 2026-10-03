import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScratchStore, defaults } from "../src/scratch.js";

test("recovery inspection is read-only with live, dead, incomplete locks and pending evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "codebuffer-inspect-"));
  try {
    const s = new ScratchStore(join(dir, "owned"));
    assert.deepEqual(s.inspect(), { state: "absent", changed: false });
    const r = s.create("s", null, "text(1);");
    const file = join(s.root, r.ref + ".json");
    const original = readFileSync(file, "utf8");
    mkdirSync(join(s.root, "lock"), { mode: 0o700 });
    let report = s.inspect() as { lock: { state: string }; issueCount: number };
    assert.equal(report.lock.state, "ambiguous");
    assert.equal(report.issueCount, 1);
    writeFileSync(join(s.root, "lock", "owner"), String(process.pid), {
      mode: 0o600,
    });
    report = s.inspect() as typeof report;
    assert.equal(report.lock.state, "possibly_live");
    writeFileSync(join(s.root, "lock", "owner"), "2147483647");
    report = s.inspect() as typeof report;
    assert.equal(report.lock.state, "dead_owner");
    writeFileSync(join(s.root, "pending"), "private evidence", { mode: 0o600 });
    const names = readdirSync(s.root);
    report = s.inspect() as typeof report;
    assert.equal(report.issueCount, 1);
    assert.deepEqual(readdirSync(s.root), names);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.equal(
      readFileSync(join(s.root, "pending"), "utf8"),
      "private evidence",
    );
    assert.throws(() => s.status(), /SCRATCH_RECOVERY_REQUIRED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("near-byte-quota repeated repair, shared sessions, restart and expiry stay bounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "codebuffer-pressure-"));
  try {
    const limits = {
      ...defaults,
      scratchBytes: 70000,
      successes: 4,
      failures: 16,
    };
    let s = new ScratchStore(join(dir, "owned"), limits);
    const protectedRecord = s.create("active", null, "//" + "x".repeat(11000));
    for (let i = 0; i < 100; i++) {
      let r = s.create(
        "s" + (i % 5),
        null,
        "//" + "x".repeat(5000) + "\ntext(1);",
      );
      r.execution = "failed";
      s.update(r, r.revisions.at(-1)!.metadata.id);
      r = s.repair({
        ref: r.ref,
        base: r.revisions.at(-1)!.metadata.id,
        session: r.session,
        ancestry: new Set(),
        anchor: null,
        run: false,
        edit: {
          format: "range",
          edits: [{ start: 0, end: 5002, text: "//small" }],
        },
      });
      assert.equal(
        s.get(r.ref, r.session, new Set()).revisions.at(-1)!.source,
        "//small\ntext(1);",
      );
      const status = s.status() as { diskBytes: number; handles: number };
      assert(status.diskBytes < limits.scratchBytes);
      assert(status.handles <= 1024);
      if (i % 20 === 0) s = new ScratchStore(s.root, limits);
    }
    assert.equal(
      s.get(protectedRecord.ref, "active", new Set()).execution,
      "running",
    );
    const last = s.create("expiry", null, "text(1);");
    last.execution = "failed";
    s.update(last, last.revisions[0]!.metadata.id);
    const expired = new ScratchStore(s.root, { ...limits, ttlMs: -1 });
    assert.throws(
      () => expired.get(last.ref, "expiry", new Set()),
      /SOURCE_EXPIRED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
