import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Host, type HostPlan } from "../src/runtime/host.js";
import { Jobs } from "../src/runtime/jobs.js";
import { ScratchStore } from "../src/scratch.js";
import { ExecutionContext } from "../src/runtime/context.js";

const scope = {
  session: "fixture-session",
  anchor: null,
  ancestry: new Set<string>(),
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "runtime-host-"));
  const scratch = new ScratchStore(join(root, "scratch"));
  const context = new ExecutionContext(root);
  const host = new Host(scratch, context, join(root, "runtime"));
  return {
    root,
    scratch,
    context,
    host,
    async close() {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("settlement failures remain observable through job inspection and restart", async () => {
  const h = fixture();
  let restored: Jobs | undefined;
  try {
    const update = h.scratch.update.bind(h.scratch);
    h.scratch.update = (...args) => {
      if (args[0].execution === "completed")
        throw new Error("fixture disk failure");
      return update(...args);
    };
    const result = await h.host.execute(
      h.host.prepare(
        "node",
        { code: "console.log('done')" },
        scope,
      ) as HostPlan,
    );
    assert.equal(result.job.storageError, "BUFFER_SETTLEMENT_FAILED");
    assert.equal(
      h.host.jobs.get(result.job.id).storageError,
      "BUFFER_SETTLEMENT_FAILED",
    );
    await h.host.close();
    restored = new Jobs(join(h.root, "runtime", "jobs"));
    assert.equal(
      restored.get(result.job.id).storageError,
      "BUFFER_SETTLEMENT_FAILED",
    );
  } finally {
    await restored?.close();
    await h.close();
  }
});

test("host draft, deferred syntax failure, guarded repair and explicit rerun", async () => {
  const h = fixture();
  try {
    const draft = h.host.prepare(
      "python",
      { code: "print(", run: false },
      scope,
    );
    assert(!("command" in draft));
    assert.equal(h.host.jobs.list().length, 0);
    const first = h.host.prepare(
      "python",
      { ref: draft.ref, base: draft.base },
      scope,
    ) as HostPlan;
    const failed = await h.host.execute(first);
    assert.equal(failed.execution, "failed");
    assert.equal(
      h.scratch.get(draft.ref, scope.session, scope.ancestry).execution,
      "failed",
    );
    const changed = h.scratch.repair({
      ref: draft.ref,
      base: draft.base,
      session: scope.session,
      ancestry: scope.ancestry,
      anchor: null,
      run: false,
      edit: {
        format: "replace",
        edits: [{ old: "print(", replacement: "print('fixed')" }],
      },
    });
    const args = {
      ref: draft.ref,
      base: changed.revisions.at(-1)!.metadata.id,
    };
    assert.throws(
      () => h.host.prepare("python", args, scope),
      /RERUN_ACK_REQUIRED/,
    );
    const repaired = await h.host.execute(
      h.host.prepare(
        "python",
        { ...args, rerun: "from-start" },
        scope,
      ) as HostPlan,
    );
    assert.equal(repaired.execution, "completed");
    assert.match(repaired.job.output, /fixed/);
    assert.equal(
      readdirSync(join(h.root, "runtime", "environments")).length,
      0,
    );
  } finally {
    await h.close();
  }
});
test("detached execution pins source and environment; discarded plans execute nothing", async () => {
  const h = fixture();
  try {
    h.context.update({ env: { MODE: "captured" } });
    const plan = h.host.prepare(
      "node",
      {
        code: "await new Promise(r=>setTimeout(r,120));console.log(process.env.MODE)",
        wait: 0,
      },
      scope,
    ) as HostPlan;
    h.context.update({ env: { MODE: "new" } });
    const started = await h.host.execute(plan);
    assert.equal(started.execution, "running");
    assert.throws(
      () =>
        h.scratch.repair({
          ref: started.ref,
          base: started.base,
          session: scope.session,
          ancestry: scope.ancestry,
          anchor: null,
          run: false,
        }),
      /SCRATCH_BUSY/,
    );
    const done = await h.host.jobs.wait(started.job.id, 3000);
    assert.equal(done.state, "completed");
    assert.match(done.output, /captured/);
    assert.equal(
      h.scratch.get(started.ref, scope.session, scope.ancestry).execution,
      "completed",
    );
    const abandoned = h.host.prepare(
      "bash",
      { code: "exit 99" },
      scope,
    ) as HostPlan;
    h.host.discard(abandoned);
    await assert.rejects(h.host.execute(abandoned), /PLAN_EXPIRED/);
    assert.equal(h.host.jobs.list().length, 1);
  } finally {
    await h.close();
  }
});
