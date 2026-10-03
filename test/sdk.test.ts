import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { harness, jsonOf, textOf } from "./harness.js";
import { State, hash, bytes, ENTRY } from "../src/state.js";

const padding = "// " + "large-source-".repeat(950) + "\n";

test("disabled configuration leaves the builtin untouched", async () => {
  process.env.PI_CODEBUFFER = '{"enabled":false}';
  const h = await harness();
  try {
    const s = await h.make();
    assert(!s.getAllTools().some((t) => t.name === "codebuffer"));
    assert.equal(
      s.getAllTools().find((t) => t.name === "codemode")?.exposure,
      "model-only",
    );
  } finally {
    delete process.env.PI_CODEBUFFER;
    await h.close();
  }
});

test("action-specific validation rejects incomplete/irrelevant fields without mutation", async () => {
  const h = await harness();
  try {
    const s = await h.make();
    for (const args of [
      { action: "create", name: "missing" },
      { action: "patch", name: "missing", old: "x", replacement: "y" },
      { action: "status", source: "not allowed" },
    ]) {
      const r = await h.call(s, args);
      assert.equal(r.isError, true);
      assert.match(textOf(r), /INVALID_ARGUMENTS/);
    }
    assert.equal(new State(s.sessionManager.getBranch()).metrics.revisions, 0);
    const declared = (
      h.payloads[0]!.tools as {
        name: string;
        parameters: { type: string; anyOf?: unknown };
      }[]
    ).find((t) => t.name === "codebuffer");
    assert.equal(declared?.parameters.type, "object");
    assert.equal(declared?.parameters.anyOf, undefined);
  } finally {
    await h.close();
  }
});

test("Pi 1.0.1 baseline: model-only CodeMode rejects nested orchestration", async () => {
  const h = await harness({
    extension: false,
    factories: [
      (pi) => {
        pi.registerTool({
          name: "probe",
          label: "Probe",
          description: "Fixture",
          parameters: Type.Object({}),
          async execute(id, args, signal, onUpdate, ctx) {
            const outcome = await ctx.executeTool("codemode", {
              code: 'text("must not run");',
            });
            return { ...outcome.result, isError: outcome.isError };
          },
        });
      },
    ],
  });
  try {
    const s = await h.make();
    s.setActiveToolsByName([...s.getActiveToolNames(), "codemode"]);
    const result = await h.call(s, {}, "probe");
    assert(s.getActiveToolNames().includes("codemode"));
    assert(!s.getCallableToolNames().includes("codemode"));
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Tool codemode not found/);
  } finally {
    await h.close();
  }
});

test("official executor keeps original options, structured nested output, discovery, images and errors", async () => {
  const h = await harness({
    models: false,
    factories: [
      (pi) => {
        pi.registerTool({
          name: "structured",
          label: "Structured",
          description: "Fixture",
          exposure: "codemode",
          parameters: Type.Object({}),
          outputSchema: Type.Object({ value: Type.Integer() }),
          async execute() {
            return {
              content: [{ type: "text", text: "not-structured" }],
              details: undefined,
              structuredContent: { value: 42 },
            };
          },
        });
        pi.registerTool({
          name: "recurse",
          label: "Recurse",
          description: "Fixture",
          exposure: "codemode",
          parameters: Type.Object({}),
          async execute(_id, _args, _signal, _onUpdate, ctx) {
            const outcome = await ctx.executeTool("codemode", {
              code: 'throw new Error("should not execute");',
            });
            return { ...outcome.result, isError: outcome.isError };
          },
        });
      },
    ],
  });
  try {
    const s = await h.make();
    await h.call(s, {
      action: "create",
      name: "outputs",
      source:
        'text(typeof models); text(await tools.structured({})); text(describeTool("structured")); text("codebuffer" in tools); text("codemode" in tools); store("k",42); image("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=");',
    });
    const r = await h.call(s, { action: "run", name: "outputs" });
    assert.equal(r.isError, false, textOf(r));
    assert.match(textOf(r), /undefined/); // The original models:false executor survived adaptation.
    assert.match(textOf(r), /42/);
    assert.match(textOf(r), /false/);
    assert(r.content.some((c) => c.type === "image"));
    await h.call(s, {
      action: "create",
      name: "failure",
      source: 'text(load("k")); throw new Error("fixture-runtime-failure");',
    });
    const failure = await h.call(s, { action: "run", name: "failure" });
    assert.equal(failure.isError, true);
    assert.match(textOf(failure), /42/);
    assert.match(textOf(failure), /fixture-runtime-failure/);
    await h.call(s, {
      action: "create",
      name: "recursive",
      source: "await tools.recurse({});",
    });
    const recursion = await h.call(s, { action: "run", name: "recursive" });
    assert.equal(recursion.isError, true);
    assert.match(textOf(recursion), /CODEMODE_RECURSION_BLOCKED/);
  } finally {
    await h.close();
  }
});
test("real SDK: large syntax repair, raw hidden but callable, runtime/read repair, permission checks", async (t) => {
  let executorCalls = 0;
  let denyRead = false;
  const h = await harness({
    factories: [
      (pi) => {
        pi.on("tool_call", (e) => {
          if (e.toolName === "codemode") executorCalls++;
          if (e.toolName === "read" && denyRead)
            return { block: true, reason: "fixture permission denial" };
        });
      },
    ],
  });
  try {
    const s = await h.make();
    const source = padding + 'text("fixed";';
    assert(bytes(source) > 11000);
    const created = jsonOf(
      await h.call(s, { action: "create", name: "main", source }),
    );
    assert.equal((created.syntax as { valid: boolean }).valid, false);
    const failure = await h.call(s, {
      action: "run",
      name: "main",
      revision: 1,
    });
    assert.equal(failure.isError, true);
    assert.match(textOf(failure), /Patch the existing buffer/);
    assert.equal(executorCalls, 0);
    const patch = {
      action: "patch",
      name: "main",
      baseRevision: 1,
      old: '";',
      replacement: '");',
    };
    await h.call(s, patch);
    const ran = await h.call(s, { action: "run", name: "main", revision: 2 });
    assert.equal(ran.isError, false, textOf(ran));
    assert.match(textOf(ran), /fixed/);
    assert.equal(executorCalls, 1);
    assert(s.getActiveToolNames().includes("codemode"));
    for (const p of h.payloads) {
      const tools = p.tools as { name: string }[];
      assert(tools.some((t) => t.name === "codebuffer"));
      assert(!tools.some((t) => t.name === "codemode"), JSON.stringify(tools));
    }
    const mutations = s.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content)
      .filter((c) => c.type === "toolCall" && c.name === "codebuffer")
      .map((c) => (c.type === "toolCall" ? c.arguments : {}));
    assert.deepEqual(mutations[2], patch);
    assert(!JSON.stringify(patch).includes(padding));
    t.diagnostic(
      JSON.stringify({
        sourceBytes: bytes(source),
        patchRequestBytes: bytes(JSON.stringify(patch)),
        patchDeltaBytes: bytes(
          JSON.stringify({ old: patch.old, replacement: patch.replacement }),
        ),
        estimatedAvoidedRegenerationBytes: new State(
          s.sessionManager.getBranch(),
        ).metrics.estimatedAvoidedRegenerationBytes,
      }),
    );
    writeFileSync(join(h.dir, "sample.txt"), "first\nsecond\n");
    const runtimeSource =
      padding +
      'text(await tools.read({path:"sample.txt",offset:999,limit:1}));';
    await h.call(s, { action: "create", name: "read", source: runtimeSource });
    const badRead = await h.call(s, { action: "run", name: "read" });
    assert.equal(badRead.isError, true, textOf(badRead));
    assert.match(textOf(badRead), /failed/);
    const readPatch = {
      action: "patch",
      name: "read",
      baseRevision: 1,
      old: "offset:999",
      replacement: "offset:1",
    };
    await h.call(s, readPatch);
    const goodRead = await h.call(s, {
      action: "run",
      name: "read",
      revision: 2,
    });
    assert.equal(goodRead.isError, false, textOf(goodRead));
    assert.match(textOf(goodRead), /first/);
    denyRead = true;
    const blocked = await h.call(s, { action: "run", name: "read" });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /fixture permission denial/);
    assert.equal(executorCalls, 4);
    const state = new State(s.sessionManager.getBranch());
    assert.equal(state.get("main", 1).source, source);
    assert.equal(
      state.get("read").metadata.hash,
      hash(runtimeSource.replace("offset:999", "offset:1")),
    );
    const metadata = await h.call(s, { action: "status" });
    assert(!textOf(metadata).includes(padding));
    assert(
      !JSON.stringify(
        s.sessionManager
          .getBranch()
          .filter((e) => e.type === "custom" && e.customType === ENTRY),
      ).includes("fixture-only"),
    );
    const paged = jsonOf(
      await h.call(s, {
        action: "read",
        name: "main",
        revision: 1,
        offset: 3,
        limit: 9,
      }),
    );
    assert.equal(paged.source, source.slice(3, 12));
  } finally {
    await h.close();
  }
});

test("real SDK: failed patches do not create revisions; history is immutable", async () => {
  const h = await harness();
  try {
    const s = await h.make();
    await h.call(s, { action: "create", name: "a", source: 'text("x x");' });
    for (const [old, expected] of [
      ["x", "PATCH_AMBIGUOUS"],
      ["z", "PATCH_NOT_FOUND"],
    ] as const) {
      const r = await h.call(s, {
        action: "patch",
        name: "a",
        baseRevision: 1,
        old,
        replacement: "",
      });
      assert.equal(r.isError, true);
      assert.match(textOf(r), new RegExp(expected));
      assert.equal(
        new State(s.sessionManager.getBranch()).metrics.revisions,
        1,
      );
    }
    await h.call(s, {
      action: "patch",
      name: "a",
      baseRevision: 1,
      old: "x x",
      replacement: "y",
    });
    const stale = await h.call(s, {
      action: "patch",
      name: "a",
      baseRevision: 1,
      old: "y",
      replacement: "z",
    });
    assert.match(textOf(stale), /STALE_REVISION/);
    const dupe = await h.call(s, { action: "create", name: "a", source: "" });
    assert.match(textOf(dupe), /BUFFER_EXISTS/);
    const state = new State(s.sessionManager.getBranch());
    assert.equal(state.metrics.revisions, 2);
    assert.equal(state.metrics.patchFailures, 3);
    assert.equal(state.get("a", 1).source, 'text("x x");');
    assert.equal(state.get("a", 2).source, 'text("y");');
  } finally {
    await h.close();
  }
});

test("real SDK: restart, fork and tree branch isolate abandoned revisions", async () => {
  const h = await harness();
  try {
    const s = await h.make();
    await h.call(s, {
      action: "create",
      name: "tree",
      source: 'text("root");',
    });
    const anchor = s.sessionManager.getLeafId()!;
    await h.call(s, {
      action: "patch",
      name: "tree",
      baseRevision: 1,
      old: "root",
      replacement: "abandoned",
    });
    const abandoned = new State(s.sessionManager.getBranch()).get(
      "tree",
    ).metadata;
    const file = s.sessionManager.getSessionFile()!;
    s.dispose();
    const reopened = await h.make(SessionManager.open(file));
    assert.equal(
      new State(reopened.sessionManager.getBranch()).get("tree").metadata.hash,
      abandoned.hash,
    );
    assert.match(
      textOf(await h.call(reopened, { action: "run", name: "tree" })),
      /abandoned/,
    );
    const forkFile = reopened.sessionManager.createBranchedSession(anchor);
    assert(forkFile);
    const fork = await h.make(SessionManager.open(forkFile));
    assert.equal(
      new State(fork.sessionManager.getBranch()).get("tree").metadata.revision,
      1,
    );
    await h.call(fork, {
      action: "patch",
      name: "tree",
      baseRevision: 1,
      old: "root",
      replacement: "fork",
    });
    assert.notEqual(
      new State(fork.sessionManager.getBranch()).get("tree").metadata.id,
      abandoned.id,
    );
    const tree = await h.make(SessionManager.open(file));
    await tree.navigateTree(anchor, { summarize: false });
    assert.equal(
      new State(tree.sessionManager.getBranch()).get("tree").source,
      'text("root");',
    );
    assert.match(
      textOf(await h.call(tree, { action: "run", name: "tree", revision: 1 })),
      /root/,
    );
    const resumedTree = SessionManager.open(file);
    assert.equal(
      new State(resumedTree.getBranch()).get("tree").source,
      'text("root");',
    );
  } finally {
    await h.close();
  }
});

for (const companion of [
  undefined,
  ...(process.env.PI_CODEBUFFER_COMPANION
    ? [process.env.PI_CODEBUFFER_COMPANION]
    : []),
]) {
  test(
    "real SDK: " +
      (companion
        ? "native checkpoint + restart coexistence"
        : "ordinary compaction + restart"),
    async () => {
      const h = await harness({ companion });
      try {
        const s = await h.make();
        await h.call(s, {
          action: "create",
          name: "compact",
          source: padding + 'text("before");',
        });
        await h.call(s, {
          action: "patch",
          name: "compact",
          baseRevision: 1,
          old: "before",
          replacement: "after",
        });
        assert.equal(
          (await h.call(s, { action: "run", name: "compact" })).isError,
          false,
        );
        const before = new State(s.sessionManager.getBranch()).get("compact");
        await s.compact();
        const entry = s.sessionManager
          .getBranch()
          .findLast((e) => e.type === "compaction");
        assert(entry?.type === "compaction");
        if (companion) {
          assert.match(entry.summary, /Codex Remote Compaction/);
          assert(
            h.payloads.some((p) =>
              JSON.stringify(p.input).includes("compaction_trigger"),
            ),
          );
        } else assert.match(entry.summary, /^fixture-ok/);
        assert.equal(
          new State(s.sessionManager.getBranch()).get("compact").metadata.hash,
          before.metadata.hash,
        );
        // Source custom entries are not projected into LLM context after compaction.
        assert(!JSON.stringify(s.messages).includes(padding));
        const file = s.sessionManager.getSessionFile()!;
        s.dispose();
        const reopened = await h.make(SessionManager.open(file));
        const result = await h.call(reopened, {
          action: "run",
          name: "compact",
          revision: 2,
        });
        assert.equal(result.isError, false, textOf(result));
        assert.match(textOf(result), /after/);
        assert.equal(
          new State(reopened.sessionManager.getBranch()).get("compact").source,
          before.source,
        );
        assert(!JSON.stringify(h.payloads.at(-1)).includes(padding));
        if (companion)
          assert(
            JSON.stringify(h.payloads.at(-1)).includes(
              "opaque-fixture-not-real",
            ),
          );
      } finally {
        await h.close();
      }
    },
  );
}

test("real SDK: fallback keeps raw declaration and still delegates", async () => {
  process.env.PI_CODEBUFFER = '{"hideRawCodemode":false}';
  const h = await harness();
  try {
    const s = await h.make();
    await h.call(s, {
      action: "create",
      name: "fallback",
      source: 'text("fallback");',
    });
    assert.equal(
      (await h.call(s, { action: "run", name: "fallback" })).isError,
      false,
    );
    assert(
      (h.payloads[0]!.tools as { name: string }[]).some(
        (t) => t.name === "codemode",
      ),
    );
  } finally {
    delete process.env.PI_CODEBUFFER;
    await h.close();
  }
});

test("real SDK: missing executor fails clearly without writing state", async () => {
  const h = await harness({ builtin: false });
  try {
    const s = await h.make();
    const r = await h.call(s, {
      action: "create",
      name: "no",
      source: 'text("no");',
    });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /INCOMPATIBLE_PI/);
    assert.equal(new State(s.sessionManager.getBranch()).metrics.buffers, 0);
  } finally {
    await h.close();
  }
});
