import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Jobs } from "../src/runtime/jobs.js";
import {
  processIdentity,
  isAlive,
  type ProcessIdentity,
} from "../src/runtime/job-journal.js";

test("cancel does not strand a TERM-ignoring grandchild after its parent exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-process-tree-"));
  const jobs = new Jobs(join(root, "jobs"));
  const ready = join(root, "ready");
  let childIdentity: ProcessIdentity | undefined;
  try {
    const child = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const id = jobs.start({
      executable: process.execPath,
      args: ["-e", parent],
      cwd: root,
      env: process.env,
      limitMs: 5000,
    });
    for (let i = 0; i < 100 && !existsSync(ready); i++) await delay(10);
    assert(existsSync(ready));
    childIdentity = processIdentity(Number(readFileSync(ready, "utf8")));
    assert(childIdentity);
    jobs.cancel(id);
    await jobs.wait(id, 2500);
    for (let i = 0; i < 150 && isAlive(childIdentity); i++) await delay(10);
    assert(
      !isAlive(childIdentity),
      "grandchild must not survive cancelled job",
    );
  } finally {
    if (isAlive(childIdentity)) process.kill(childIdentity!.pid, "SIGKILL");
    await jobs.close();
    rmSync(root, { recursive: true, force: true });
  }
});
