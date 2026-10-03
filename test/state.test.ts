import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import {
  ENTRY,
  State,
  revision,
  exact,
  hash,
  syntax,
  MAX_SOURCE,
} from "../src/state.js";

const entry = (data: unknown) => ({ type: "custom", customType: ENTRY, data });
test("parse-only async body accepts await/return; errors locate the original source", () => {
  assert.deepEqual(syntax("await Promise.resolve(); return 1;"), {
    valid: true,
  });
  assert.deepEqual(syntax('throw new Error("not executed");'), { valid: true });
  const invalid = syntax('text("a");\nconst = 1;');
  assert.equal(invalid.valid, false);
  if (!invalid.valid) {
    assert.equal(invalid.line, 2);
    assert.equal(invalid.column, 7);
  }
  assert.equal(syntax('} text("escape"); {').valid, false);
});
test("exact patch handles overlap, Unicode, deletion; no fuzzy or empty match", () => {
  assert.throws(() => exact("aaa", "aa", "b"), /PATCH_AMBIGUOUS/);
  assert.throws(() => exact("a", "", "b"), /PATCH_EMPTY/);
  assert.throws(() => exact(" a", "a ", "b"), /PATCH_NOT_FOUND/);
  assert.equal(exact("a🙂中文", "🙂", ""), "a中文");
});
test("deterministic delta replay verifies hash, ancestry and syntax; ignores unrelated entries", () => {
  const one = revision("x", 'text("one");');
  const base = { metadata: one, source: one.source! };
  const patch = { old: "one", replacement: "two" };
  const two = revision("x", 'text("two");', base, patch);
  assert.equal(two.source, undefined);
  const state = new State([
    entry(one),
    {
      type: "custom",
      customType: "another-extension",
      data: { secret: "ignored" },
    },
    entry(two),
  ]);
  assert.equal(state.get("x").metadata.hash, hash('text("two");'));
  assert.equal(state.get("x", 1).metadata.id, one.id);
  assert.equal(state.get("x").metadata.parent, one.id);
  for (const changed of [
    { ...two, hash: "bad" },
    { ...two, parent: "bad" },
    { ...two, revision: 4 },
    { ...two, patch: { old: "missing", replacement: "" } },
    { ...two, syntax: { valid: false } },
    { ...two, source: "overwrite" },
  ]) {
    assert.throws(
      () => new State([entry(one), entry(changed)]),
      /STATE_CORRUPT/,
    );
  }
  assert.throws(() => new State([entry(null)]), /STATE_CORRUPT/);
  assert.throws(() => state.get("x", 3), /REVISION_NOT_FOUND/);
});
test("bounded source, valid names, metrics use UTF-8 bytes not tokens", () => {
  assert.throws(() => revision("../x", ""), /INVALID_NAME/);
  assert.throws(
    () => revision("x", "a".repeat(MAX_SOURCE + 1)),
    /SOURCE_TOO_LARGE/,
  );
  const one = revision("x", '"中"');
  const two = revision(
    "x",
    '"a"',
    { metadata: one, source: one.source! },
    { old: "中", replacement: "a" },
  );
  const state = new State([
    entry(one),
    entry(two),
    entry({ kind: "metric", metric: "runs", bytes: 3 }),
    entry({ kind: "metric", metric: "patchFailures", bytes: 0 }),
  ]);
  assert.equal(
    state.metrics.patchBytes,
    Buffer.byteLength(JSON.stringify(two.patch)),
  );
  assert.equal(state.metrics.runs, 1);
  assert.equal(state.metrics.reconstructedSourceBytes, 3);
  assert.equal(state.metrics.estimatedAvoidedRegenerationBytes, 0);
});
test("configuration defaults and strict rejection", () => {
  assert.deepEqual(config("{}"), {
    enabled: true,
    hideRawCodemode: true,
    debug: false,
    scratch: {
      scratchBytes: 67108864,
      successes: 4,
      failures: 16,
      revisions: 8,
      ttlMs: 86400000,
    },
    cacheBytes: 33554432,
    durableBytes: 67108864,
    preferredFormat: "replace",
  });
  assert.equal(config('{"enabled":false}').enabled, false);
  for (const raw of [
    "null",
    "[]",
    "1",
    '{"debug":"yes"}',
    '{"extra":true}',
    '{"toString":true}',
    '{"__proto__":true}',
    "{",
  ])
    assert.throws(() => config(raw));
});
