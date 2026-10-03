import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BranchIndex } from "../src/index-cache.js";
import { ENTRY, hash, State, type Revision } from "../src/state.js";
test("50k legacy events cache without rebuilding; sibling and restart identities stay separate", () => {
  const entries: {
    id: string;
    type: string;
    customType: string;
    data: Revision;
  }[] = [];
  let parent: string | null = null;
  for (let i = 0; i < 50000; i++) {
    const id = randomUUID();
    entries.push({
      id,
      type: "custom",
      customType: ENTRY,
      data: {
        kind: "revision",
        name: "legacy",
        revision: i + 1,
        id,
        parent,
        hash: hash("text(" + (i % 2) + ");"),
        timestamp: "2026-01-01T00:00:00Z",
        syntax: { valid: true },
        ...(i
          ? { patch: { old: String((i - 1) % 2), replacement: String(i % 2) } }
          : { source: "text(0);" }),
      },
    });
    parent = id;
  }
  const index = new BranchIndex();
  assert.equal(index.get("s", entries).get("legacy").source, "text(1);");
  for (let i = 0; i < 10; i++)
    assert.equal(index.get("s", entries).get("legacy").source, "text(1);");
  assert.equal(index.reconstructions, 50000);
  const sibling = [
    ...entries.slice(0, -1),
    {
      ...entries.at(-1)!,
      id: randomUUID(),
      data: {
        ...entries.at(-1)!.data,
        id: randomUUID(),
        patch: { old: "0", replacement: "2" },
        hash: hash("text(2);"),
      },
    },
  ];
  assert.equal(index.get("s", sibling).get("legacy").source, "text(2);");
  assert.equal(
    new BranchIndex().get("s", entries).get("legacy").source,
    "text(1);",
  );
  const duplicate = { ...entries[0]!.data, name: "other" };
  assert.throws(
    () =>
      new State([
        entries[0]!,
        { type: "custom", customType: ENTRY, data: duplicate },
      ]),
    /STATE_CORRUPT/,
  );
});
