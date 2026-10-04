import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs } from "../src/runtime/jobs.js";

function fixture(limits = {}) {
  const root = mkdtempSync(join(tmpdir(), "codebuffer-jobs-"));
  const events: string[] = [];
  const jobs = new Jobs(
    join(root, "owned"),
    (job) => {
      events.push(job.state);
    },
    limits,
  );
  return {
    root,
    jobs,
    events,
    async close() {
      await jobs.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const spec = (code: string, extra = {}) => ({
  executable: process.execPath,
  args: ["-e", code],
  cwd: process.cwd(),
  env: { ...process.env },
  ...extra,
});
test("wait expiry detaches, immutable launch environment and one completion event", async () => {
  const h = fixture();
  try {
    const input = spec("setTimeout(()=>console.log(process.env.TEST),70)", {
      env: { TEST: "original" },
    });
    const id = h.jobs.start(input);
    input.env.TEST = "changed";
    assert.equal((await h.jobs.wait(id, 1)).state, "running");
    const done = await h.jobs.wait(id, 2000);
    assert.equal(done.state, "completed");
    assert.equal(done.exitCode, 0);
    assert.match(done.output, /original/);
    assert.deepEqual(h.events, ["completed"]);
  } finally {
    await h.close();
  }
});
test("bounded logs keep draining; failures are never automatically rerun", async () => {
  const h = fixture({ logBytes: 2048, outputBytes: 512 });
  try {
    const id = h.jobs.start(
      spec(
        'process.stdout.write("x".repeat(200000));console.error("FINAL_ERROR");process.exitCode=7',
      ),
    );
    const result = await h.jobs.wait(id, 2000);
    assert.equal(result.exitCode, 7);
    assert.equal(result.state, "failed");
    assert(result.truncated);
    assert(Buffer.byteLength(result.output) <= 512);
    assert(Buffer.byteLength(readFileSync(result.log)) <= 2048);
    assert.match(result.output, /FINAL_ERROR/);
    assert.deepEqual(h.events, ["failed"]);
  } finally {
    await h.close();
  }
});
test("hard deadline and cancellation terminate; concurrent quota is enforced", async () => {
  const h = fixture({ active: 1 });
  try {
    const id = h.jobs.start(spec("setInterval(()=>{},1000)", { limitMs: 70 }));
    assert.throws(() => h.jobs.start(spec("")), /ACTIVE_JOB_LIMIT/);
    assert.equal((await h.jobs.wait(id, 2000)).state, "timed_out");
    const second = h.jobs.start(spec("setInterval(()=>{},1000)"));
    h.jobs.cancel(second);
    assert.equal((await h.jobs.wait(second, 2000)).state, "cancelled");
    assert.equal(h.jobs.list().filter((j) => j.state === "running").length, 0);
  } finally {
    await h.close();
  }
});
test("record quota reclaims only completed jobs; invalid requests have no process effects", async () => {
  const h = fixture({ records: 1, active: 1 });
  try {
    const id = h.jobs.start(spec('console.log("one")'));
    const first = await h.jobs.wait(id, 2000);
    const next = h.jobs.start(spec('console.log("two")'));
    assert(!existsSync(first.log));
    assert.throws(() => h.jobs.get(id), /JOB_EXPIRED/);
    assert.equal((await h.jobs.wait(next, 2000)).state, "completed");
    assert.throws(
      () => h.jobs.start(spec("", { limitMs: -1 })),
      /INVALID_LIMIT/,
    );
  } finally {
    await h.close();
  }
});
