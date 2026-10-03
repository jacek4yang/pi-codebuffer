import test from "node:test";
import assert from "node:assert/strict";
import { harness, jsonOf, textOf } from "./harness.js";

test("code shorthand awaits returned tools once, retains repair and rejects mixed inputs", async () => {
  let calls = 0;
  const h = await harness({
    factories: [
      (pi) => {
        pi.on("tool_call", (e) => {
          if (e.toolName === "bash") calls++;
        });
      },
    ],
  });
  try {
    const s = await h.make();
    const good = await h.call(s, {
      code: 'return tools.bash({command:"printf shorthand-ok"});',
    });
    assert.equal(good.isError, false, textOf(good));
    assert.match(textOf(good), /shorthand-ok/);
    assert.equal(calls, 1);
    assert.deepEqual(Object.keys(jsonOf(good)).sort(), ["base", "ref"]);
    const bad = await h.call(s, { code: "return 42;(" });
    assert.equal(bad.isError, true);
    const metadata = jsonOf(bad);
    assert.equal(metadata.effects, "not_started");
    const fixed = await h.call(s, {
      action: "repair",
      ref: metadata.ref,
      base: metadata.base,
      edit: { format: "replace", edits: [{ old: ";(", replacement: ";" }] },
    });
    assert.equal(fixed.isError, false, textOf(fixed));
    assert.match(textOf(fixed), /42/);
    for (const args of [
      { code: "return 1", source: "return 2" },
      { code: "return 1", action: "status" },
    ]) {
      assert.equal((await h.call(s, args)).isError, true);
    }
    assert.equal(calls, 1);
  } finally {
    await h.close();
  }
});
