import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Jobs } from "../src/runtime/jobs.js";
import { processIdentity } from "../src/runtime/job-journal.js";

test("completed jobs survive restart; live owner cannot be stolen", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-restart-"));
  const jobs = new Jobs(root);
  try {
    assert.throws(() => new Jobs(root), /JOB_STORE_BUSY/);
    const id = jobs.start({
      executable: process.execPath,
      args: ["-e", "console.log('durable result')"],
      cwd: root,
      env: process.env,
    });
    assert.equal((await jobs.wait(id, 2000)).state, "completed");
    await jobs.close();
    const next = new Jobs(root);
    try {
      assert.equal(next.get(id).state, "completed");
      assert.equal(next.get(id).exitCode, 0);
      assert.match(next.get(id).output, /durable result/);
    } finally {
      await next.close();
    }
  } finally {
    await jobs.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("live orphan reserves capacity; cancellation verifies PID identity and never invents success", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-orphan-"));
  const jobs = new Jobs(root, undefined, { active: 1 });
  let watchdog: ReturnType<typeof spawn> | undefined;
  let recovered: Jobs | undefined;
  try {
    const id = jobs.start({
      executable: process.execPath,
      args: ["-e", ""],
      cwd: root,
      env: process.env,
    });
    await jobs.wait(id, 2000);
    await jobs.close();
    watchdog = spawn(
      "/usr/bin/timeout",
      [
        "--kill-after=1s",
        "10s",
        process.execPath,
        "-e",
        "setInterval(()=>{},1000)",
      ],
      { detached: true, stdio: "ignore" },
    );
    await once(watchdog, "spawn");
    const path = join(root, ".jobs.json");
    const data = JSON.parse(readFileSync(path, "utf8"));
    data.records[0].state = "running";
    data.records[0].deadline = Date.now() + 11000;
    data.records[0].identity = processIdentity(watchdog.pid!);
    assert(data.records[0].identity);
    writeFileSync(path, JSON.stringify(data));
    recovered = new Jobs(root, undefined, { active: 1 });
    assert.equal(recovered.get(id).state, "orphaned");
    assert.equal(recovered.get(id).exitCode, undefined);
    assert.throws(
      () =>
        recovered!.start({
          executable: process.execPath,
          args: ["-e", ""],
          cwd: root,
          env: process.env,
        }),
      /ACTIVE_JOB_LIMIT/,
    );
    const stopped = once(watchdog, "exit");
    recovered.cancel(id);
    await stopped;
    assert.equal(recovered.get(id).state, "interrupted");
    assert.equal(recovered.get(id).exitCode, undefined);
  } finally {
    if (watchdog?.pid) {
      try {
        process.kill(-watchdog.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await recovered?.close();
    await jobs.close();
    rmSync(root, { recursive: true, force: true });
  }
});
