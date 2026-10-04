import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { setTimeout as delay } from "node:timers/promises";
import { harness, jsonOf, textOf } from "./harness.js";

test("unified SDK tools execute through context and retain source", async () => {
  const h = await harness({ unified: true });
  try {
    const session = await h.make();
    const configured = await h.call(
      session,
      { context: { env: { CB_FIXTURE: "hello" } } },
      "code",
    );
    assert.equal(configured.isError, false, textOf(configured));
    for (const [name, args] of [
      ["python", { code: "import os; print(os.environ['CB_FIXTURE'])" }],
      ["node", { code: "console.log(process.env.CB_FIXTURE)" }],
      ["bash", { command: "printf '%s' \"$CB_FIXTURE\"" }],
    ] as const) {
      const output = await h.call(session, args, name);
      assert.equal(output.isError, false, textOf(output));
      assert.match(textOf(output), /hello/);
      assert.equal(typeof jsonOf(output).ref, "string");
    }
    const quickjs = await h.call(session, { code: "text(6 * 7)" }, "code");
    assert.equal(quickjs.isError, false, textOf(quickjs));
    assert.match(textOf(quickjs), /42/);
  } finally {
    await h.close();
  }
});

test("background completion resumes an idle SDK session exactly once without polling", async () => {
  const h = await harness({ unified: true });
  try {
    const session = await h.make();
    let settled = 0;
    const stop = session.subscribe((event) => {
      if (event.type === "agent_settled") settled++;
    });
    try {
      const output = await h.call(
        session,
        {
          code: "await new Promise(r => setTimeout(r, 250)); console.log('background-done')",
          wait: 0,
        },
        "node",
      );
      assert.equal(output.isError, false, textOf(output));
      assert.equal((jsonOf(output).job as { state: string }).state, "running");
      const deadline = Date.now() + 5000;
      while (settled < 2 && Date.now() < deadline) await delay(20);
      assert.equal(settled, 2, "completion should start one follow-up turn");
      await delay(100);
      assert.equal(settled, 2, "completion must not repeatedly resume");
      assert.equal(
        h.payloads.length,
        3,
        "initial tool request, final reply, single completion follow-up",
      );
      assert.match(JSON.stringify(session.messages), /background-done/);
    } finally {
      stop();
    }
  } finally {
    await h.close();
  }
});

test("explicit background cancellation does not launch an unwanted follow-up turn", async () => {
  const h = await harness({ unified: true });
  try {
    const session = await h.make();
    const started = await h.call(
      session,
      { command: "sleep 10", wait: 0, limit: 15 },
      "bash",
    );
    assert.equal(started.isError, false, textOf(started));
    const job = jsonOf(started).job as { id: string; state: string };
    assert.equal(job.state, "running");
    const cancelled = await h.call(
      session,
      { job: { id: job.id, action: "cancel" } },
      "code",
    );
    assert.equal(cancelled.isError, false, textOf(cancelled));
    await delay(1300);
    assert.equal(
      h.payloads.length,
      4,
      "a new user's cancellation must not resume the old job's user turn",
    );
    const status = await h.call(
      session,
      { job: { id: job.id, action: "inspect" } },
      "code",
    );
    assert.equal(jsonOf(status).state, "cancelled");
  } finally {
    await h.close();
  }
});

test("unified file tools assemble and edit retained host source without execution", async () => {
  const h = await harness({ unified: true });
  try {
    const session = await h.make();
    const draft = await h.call(
      session,
      { code: 'print("', run: false },
      "python",
    );
    assert.equal(draft.isError, false, textOf(draft));
    const { ref, base } = jsonOf(draft);
    const path = "buffer:" + ref;
    const appended = await h.call(
      session,
      { path, base, format: "append", text: 'hello")' },
      "edit",
    );
    assert.equal(appended.isError, false, textOf(appended));
    const read = await h.call(session, { path }, "read");
    assert.equal(jsonOf(read).text, 'print("hello")');
    const changed = await h.call(
      session,
      { path, base: jsonOf(read).base, content: 'print("updated")' },
      "write",
    );
    assert.equal(changed.isError, false, textOf(changed));
    const run = await h.call(
      session,
      { ref, base: jsonOf(changed).base },
      "python",
    );
    assert.equal(run.isError, false, textOf(run));
    assert.match(textOf(run), /updated/);
    const file = join(h.dir, "normal.txt");
    const written = await h.call(
      session,
      { path: file, content: "before" },
      "write",
    );
    assert.notEqual(written.isError, true, textOf(written));
    const edited = await h.call(
      session,
      {
        path: file,
        format: "replace",
        edits: [{ old: "before", replacement: "after" }],
      },
      "edit",
    );
    assert.notEqual(edited.isError, true, textOf(edited));
    assert.match(
      textOf(await h.call(session, { path: file }, "read")),
      /after/,
    );
  } finally {
    await h.close();
  }
});

test("configured projects and workflows use the same guarded SDK executor", async () => {
  const h = await harness({ unified: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = h.dir;
  try {
    writeFileSync(
      join(h.dir, "workflow.json"),
      JSON.stringify({
        projects: {
          fixture: { cwd: h.dir, env: { PRESET_VALUE: "sdk-preset" } },
        },
        workflows: { check: "printf '%s' \"$PRESET_VALUE\"" },
      }),
    );
    const session = await h.make();
    const configured = await h.call(
      session,
      { context: { project: "fixture" } },
      "code",
    );
    assert.equal(configured.isError, false, textOf(configured));
    const listed = await h.call(session, { workflow: "list" }, "code");
    assert.deepEqual(jsonOf(listed).workflows, ["check"]);
    const executed = await h.call(session, { workflow: "check" }, "code");
    assert.equal(executed.isError, false, textOf(executed));
    assert.match(textOf(executed), /sdk-preset/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await h.close();
  }
});

test("legacy workflow conflicts fail closed before host side effects", async () => {
  const h = await harness({
    unified: true,
    factories: [
      (pi) => {
        pi.registerTool({
          name: "workflow",
          label: "Legacy fixture",
          description: "Legacy workflow",
          parameters: Type.Object({}),
          async execute() {
            return {
              content: [{ type: "text", text: "fixture" }],
              details: undefined,
            };
          },
        });
      },
    ],
  });
  try {
    const session = await h.make();
    const target = join(h.dir, "conflict-must-not-exist");
    const output = await h.call(
      session,
      { code: `open(${JSON.stringify(target)}, 'w').write('bad')` },
      "python",
    );
    assert.equal(output.isError, true, textOf(output));
    assert.match(textOf(output), /UNIFIED_TOOL_CONFLICT/);
    assert.equal(existsSync(target), false);
  } finally {
    await h.close();
  }
});

test("unified SDK final bash authorization blocks host side effects", async () => {
  const h = await harness({
    unified: true,
    factories: [
      (pi) => {
        pi.on("tool_call", (event) => {
          if (event.toolName === "bash" && event.parentToolCallId)
            return { block: true, reason: "fixture-denied" };
        });
      },
    ],
  });
  try {
    const session = await h.make();
    const target = join(h.dir, "must-not-exist");
    const output = await h.call(
      session,
      { code: `open(${JSON.stringify(target)}, 'w').write('bad')` },
      "python",
    );
    assert.equal(output.isError, true, textOf(output));
    assert.equal(existsSync(target), false);
  } finally {
    await h.close();
  }
});
