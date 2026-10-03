import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { harness, jsonOf, textOf } from "./harness.js";
import { State, ENTRY, revision, summary } from "../src/state.js";

test("README JSON examples and documented Codex repair pass the real schema", async () => {
  const root = dirname(
    process.env.PI_CODEBUFFER_TEST_EXTENSION ?? resolve("index.ts"),
  );
  const snippets = (file: string) =>
    [
      ...readFileSync(join(root, file), "utf8").matchAll(
        /```json\n([\s\S]*?)```/g,
      ),
    ].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
  const h = await harness();
  try {
    const s = await h.make();
    const [exec, repair] = snippets("README.md");
    const bad = await h.call(s, exec!);
    assert.equal(bad.isError, true);
    const id = jsonOf(bad);
    assert.equal(
      (await h.call(s, { ...repair, ref: id.ref, base: id.base })).isError,
      false,
    );
    const badPatch = await h.call(s, {
      action: "exec",
      source: "text(missing);",
    });
    const r = jsonOf(badPatch);
    const patch = snippets("docs/EDITING.md")[1]!;
    const result = await h.call(s, { ...patch, ref: r.ref, base: r.base });
    assert.equal(result.isError, false, textOf(result));
    const made = await h.call(s, {
      action: "create",
      name: "retired",
      source: "text(1);",
    });
    assert.equal(made.isError, false);
    assert.equal(
      (await h.call(s, { action: "retire", name: "retired" })).isError,
      false,
    );
    assert.equal(
      (await h.call(s, { action: "read", name: "retired" })).isError,
      false,
    );
    assert.match(
      textOf(
        await h.call(s, {
          action: "patch",
          name: "retired",
          baseRevision: 1,
          old: "1",
          replacement: "2",
        }),
      ),
      /BUFFER_RETIRED/,
    );
    assert.equal(
      (
        jsonOf(await h.call(s, { action: "status" })).metrics as {
          buffers: number;
        }
      ).buffers,
      0,
    );
  } finally {
    await h.close();
  }
});

test("source snapshots are hash checked and excluded from metadata; retirement preserves history", () => {
  const entries: {
    type: string;
    customType: string;
    data: ReturnType<typeof revision>;
  }[] = [];
  let previous;
  for (let i = 1; i <= 130; i++) {
    const source = "text(" + i + ");";
    const r = revision(
      "a",
      source,
      previous,
      previous ? { old: previous.source, replacement: source } : undefined,
    );
    entries.push({ type: "custom", customType: ENTRY, data: r });
    previous = { metadata: r, source };
  }
  assert.equal(entries.filter((e) => e.data.snapshot).length, 2);
  const state = new State(entries, 1);
  assert.equal(state.get("a", 130).source, "text(130);");
  assert.equal(state.get("a", 64).source, "text(64);");
  assert(!JSON.stringify(summary(state.get("a", 64))).includes("text(64)"));
  state.apply({ kind: "retire", name: "a" });
  assert.equal(state.active.size, 0);
  assert.equal(state.get("a", 1).source, "text(1);");
  entries[63]!.data.snapshot!.source = "changed";
  assert.throws(() => new State(entries), /STATE_CORRUPT/);
});
