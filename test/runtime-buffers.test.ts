import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ScratchStore } from "../src/scratch.js";
import { Buffers } from "../src/runtime/buffers.js";

test("virtual buffers support bounded reads and guarded chunk assembly without execution", () => {
  const root = mkdtempSync(join(tmpdir(), "buffers-"));
  try {
    const store = new ScratchStore(join(root, "scratch"));
    const buffers = new Buffers(store);
    const scope = { session: "s", ancestry: new Set<string>(), anchor: null };
    const record = store.create("s", null, 'print("', {
      language: "python",
      run: false,
    });
    const path = "buffer:" + record.ref;
    const first = buffers.read(path, scope);
    const next = buffers.append(path, first.base, 'hello 😀")', scope);
    assert.equal(
      store.get(record.ref, "s", scope.ancestry).execution,
      "not_started",
    );
    assert.throws(
      () => buffers.write(path, first.base, "bad", scope),
      /STALE_REVISION/,
    );
    assert.match(buffers.read(path, scope).text, /hello 😀/);
    const source = buffers.read(path, scope).text;
    const emoji = source.indexOf("😀");
    assert.equal(buffers.read(path, scope, emoji, 1).text, "");
    assert.throws(() => buffers.read(path, scope, emoji + 1), /./);
    assert.throws(
      () => buffers.read(path, { ...scope, session: "other" }),
      /SOURCE_EXPIRED/,
    );
    store.repair({ ref: record.ref, base: next.base, ...scope, run: true });
    assert.throws(
      () => buffers.append(path, next.base, "\n", scope),
      /SCRATCH_BUSY/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
