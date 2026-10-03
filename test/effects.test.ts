import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { harness, textOf, jsonOf } from "./harness.js";

test("committed native write followed by schema error or missing diagnostic stays visible and failed", async () => {
  const h = await harness();
  try {
    const s = await h.make();
    for (const ending of [
      "await tools.edit({path:target,edits:[{old:1,newText:2}]});",
      "await tools.unavailable_diagnostic({});",
    ]) {
      const path = join(h.dir, "effect.txt");
      const source =
        "const target=" +
        JSON.stringify(path) +
        "; await tools.write({path:target,content:" +
        JSON.stringify("committed") +
        "}); " +
        ending;
      const result = await h.call(s, { action: "exec", source });
      assert.equal(result.isError, true, textOf(result));
      assert.equal(readFileSync(path, "utf8"), "committed");
      assert.equal(jsonOf(result).effects, "unknown");
      const denied = await h.call(s, {
        action: "repair",
        ref: jsonOf(result).ref,
        base: jsonOf(result).base,
        edit: {
          format: "range",
          edits: [{ start: 0, end: source.length, text: "text(1);" }],
        },
      });
      assert.match(textOf(denied), /RERUN_ACK_REQUIRED/);
      assert.equal(readFileSync(path, "utf8"), "committed");
    }
    const command = await h.call(s, {
      action: "exec",
      source:
        "const r=await tools.bash({command:" +
        JSON.stringify("exit 7") +
        "}); text(r); if(r.exit_code!==0) throw new Error(" +
        JSON.stringify("Nonzero command exit") +
        ");",
    });
    assert.equal(command.isError, true, textOf(command));
  } finally {
    await h.close();
  }
});
