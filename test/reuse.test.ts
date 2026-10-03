import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { harness, jsonOf, textOf } from "./harness.js";

test("retained shorthand reuses once, range-derives a similar program, and rejects stale/foreign state", async () => {
  let calls = 0;
  const h = await harness({
    factories: [
      (pi) => {
        pi.on("tool_call", (e) => {
          if (e.toolName === "codemode") calls++;
        });
      },
    ],
  });
  try {
    let s = await h.make();
    const source = 'return "first";\r\n//🙂' + "padding".repeat(1000) + "\r\n";
    const initial = await h.call(s, { code: source });
    assert.equal(initial.isError, false, textOf(initial));
    const m = jsonOf(initial);
    const rejected = await h.call(s, { ref: m.ref, base: m.base });
    assert.equal(rejected.isError, true);
    assert.match(textOf(rejected), /RERUN_ACK_REQUIRED/);
    assert.equal(calls, 1);
    const reused = await h.call(s, {
      ref: m.ref,
      base: m.base,
      rerun: "from-start",
    });
    assert.equal(reused.isError, false, textOf(reused));
    assert.equal(jsonOf(reused).base, m.base);
    assert.match(textOf(reused), /first/);
    assert.equal(calls, 2);
    const view = jsonOf(
      await h.call(s, {
        action: "readScratch",
        ref: m.ref,
        base: m.base,
        lines: true,
        limit: 80,
      }),
    );
    assert.equal(view.units, source.length);
    assert.equal(view.source, undefined);
    const lines = view.lines as { start: number; end: number; text: string }[];
    assert.deepEqual(lines[0], {
      start: 0,
      end: 17,
      text: 'return "first";\r\n',
    });
    assert.equal(
      lines.map((l) => l.text).join(""),
      source.slice(0, Number(view.end)),
    );
    const changed = await h.call(s, {
      ref: m.ref,
      base: m.base,
      edit: {
        format: "range",
        edits: [{ start: 0, end: lines[0]!.end, text: 'return "second";\r\n' }],
      },
      run: false,
    });
    assert.equal(changed.isError, false, textOf(changed));
    assert.equal(calls, 2);
    const n = jsonOf(changed);
    assert.notEqual(n.base, m.base);
    assert.equal(
      (await h.call(s, { ref: m.ref, base: m.base, rerun: "from-start" }))
        .isError,
      true,
    );
    assert.equal((await h.call(s, { ref: n.ref, base: n.base })).isError, true);
    const file = s.sessionManager.getSessionFile()!;
    s.dispose();
    s = await h.make(SessionManager.open(file));
    const fixed = await h.call(s, {
      ref: n.ref,
      base: n.base,
      rerun: "from-start",
    });
    assert.equal(fixed.isError, false, textOf(fixed));
    assert.match(textOf(fixed), /second/);
    assert.equal(calls, 3);
    const other = await h.make();
    assert.equal(
      (await h.call(other, { ref: n.ref, base: n.base, rerun: "from-start" }))
        .isError,
      true,
    );
    assert.equal(calls, 3);
    const args = {
      ref: n.ref,
      base: n.base,
      edit: {
        format: "replace",
        edits: [{ old: "second", replacement: "third" }],
      },
      rerun: "from-start",
    };
    const similar = await h.call(s, args);
    assert.equal(similar.isError, false, textOf(similar));
    assert.match(textOf(similar), /third/);
    assert.equal(calls, 4);
    assert(
      Buffer.byteLength(JSON.stringify(args)) < Buffer.byteLength(source) / 10,
    );
  } finally {
    await h.close();
  }
});

test("line views stay bounded and round-trip exact UTF-16 spans", async () => {
  const h = await harness();
  try {
    const s = await h.make();
    const source = "\n".repeat(600) + 'return "🙂";';
    const m = jsonOf(await h.call(s, { code: source }));
    let offset = 0,
      all = "";
    do {
      const r = jsonOf(
        await h.call(s, {
          action: "readScratch",
          ref: m.ref,
          base: m.base,
          lines: true,
          offset,
          limit: 16000,
        }),
      );
      const lines = r.lines as { start: number; end: number; text: string }[];
      assert(lines.length <= 256);
      for (const l of lines) {
        assert.equal(l.text, source.slice(l.start, l.end));
        all += l.text;
      }
      if (r.nextOffset === null) break;
      assert(Number(r.nextOffset) > offset);
      offset = Number(r.nextOffset);
    } while (true);
    assert.equal(all, source);
  } finally {
    await h.close();
  }
});
