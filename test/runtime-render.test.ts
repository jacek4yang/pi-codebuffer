import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { displayText, executionRenderers } from "../src/runtime/render.js";

test("render previews are bounded and suppress terminal controls", () => {
  assert.equal(displayText("a\u001b[2J\u0000\u202e\n", false), "a�[2J��\n");
  assert.match(displayText("line\n".repeat(1000), true), /preview truncated/);
  assert.ok(displayText("x".repeat(100000), true).length < 16100);
});

test("edit renderer distinguishes requested additions and removals", () => {
  const renderer = executionRenderers("edit").renderCall!;
  const theme = {
    fg: (color: string, text: string) => `[${color}]${text}`,
    bold: (text: string) => text,
  } as unknown as Theme;
  const rendered = renderer(
    {
      path: "buffer:example",
      format: "replace",
      edits: [{ old: "before", replacement: "after" }],
    },
    theme,
    { expanded: true } as Parameters<typeof renderer>[2],
  );
  const output = rendered.render(120).join("\n");
  assert.match(output, /requested/);
  assert.match(output, /\[error\]− before/);
  assert.match(output, /\[success\]\+ after/);
});
