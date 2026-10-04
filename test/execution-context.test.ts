import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionContext, routeEnvironment } from "../src/runtime/context.js";

test("context patches are atomic, partial, bounded and stable across cwd changes", () => {
  const c = new ExecutionContext("/project");
  const first = c.update({
    python: ".venv/bin/python",
    env: { MODE: "test" },
    routes: {
      programs: { git: "personal", gh: "personal" },
      proxies: { personal: "http://127.0.0.1:10808" },
    },
  });
  assert.equal(first.python, "/project/.venv/bin/python");
  assert.equal(c.update({ cwd: "/other" }).python, first.python);
  assert.equal(c.snapshot().env.MODE, "test");
  const before = c.snapshot();
  assert.throws(() => c.update({ cwd: "/bad", node: "bad\u0000node" }));
  assert.deepEqual(c.snapshot(), before);
  assert.throws(() => c.update({ env: { MODE: "x".repeat(65537) } }));
  assert.deepEqual(c.snapshot(), before);
  c.update({ env: { MODE: null }, python: null });
  assert.equal(c.snapshot().python, undefined);
  assert.equal(c.snapshot().env.MODE, undefined);
  assert.throws(() => c.update({ unknown: true }));
});
test("branch restore replaces removed environment and route keys atomically", () => {
  const c = new ExecutionContext("/project");
  const initial = c.snapshot();
  c.update({
    env: { BRANCH: "other" },
    routes: { programs: { git: "direct" } },
  });
  c.restore(initial);
  assert.deepEqual(c.snapshot(), initial);
  assert.throws(() => c.restore({ env: { HTTP_PROXY: "invalid" } }));
  assert.deepEqual(c.snapshot(), initial);
});

test("durable commit failure leaves the execution context unchanged", () => {
  const c = new ExecutionContext("/project");
  const before = c.snapshot();
  assert.throws(
    () =>
      c.update({ env: { TEST: "new" } }, undefined, () => {
        throw new Error("disk-full");
      }),
    /disk-full/,
  );
  assert.deepEqual(c.snapshot(), before);
});
test("batch cwd resolves interpreters once; callers cannot mutate snapshots", () => {
  const c = new ExecutionContext("/original");
  const s = c.update({
    cwd: "new",
    python: "./bin/python",
    env: { TEST: "one" },
  });
  assert.equal(s.python, "/original/new/bin/python");
  s.env.TEST = "changed";
  assert.equal(c.snapshot().env.TEST, "one");
  c.update({ cwd: null });
  assert.equal(c.snapshot().cwd, "/original");
});
test("per-program routes override default; explicit direct clears all proxy variants", () => {
  const c = new ExecutionContext("/project");
  c.update({
    routes: {
      default: "public",
      proxies: {
        public: "http://127.0.0.1:10809",
        personal: "http://127.0.0.1:10808",
      },
      programs: { gh: "personal", python: "direct" },
    },
  });
  const inherited = {
    PATH: "/bin",
    HTTP_PROXY: "old",
    no_proxy: "*",
    ALL_PROXY: "old",
  };
  assert.equal(
    routeEnvironment(c.snapshot(), "gh", inherited).HTTP_PROXY,
    "http://127.0.0.1:10808",
  );
  assert.deepEqual(routeEnvironment(c.snapshot(), "python", inherited), {
    PATH: "/bin",
  });
  assert.equal(
    routeEnvironment(c.snapshot(), "npm", inherited).HTTP_PROXY,
    "http://127.0.0.1:10809",
  );
  assert.equal(
    routeEnvironment(c.snapshot(), "gh", inherited, "inherit").HTTP_PROXY,
    "old",
  );
  c.update({ routes: { programs: { gh: null } } });
  assert.equal(
    routeEnvironment(c.snapshot(), "gh", inherited).HTTP_PROXY,
    "http://127.0.0.1:10809",
  );
});
test("bad routes and oversized rule maps never partially apply", () => {
  const c = new ExecutionContext("/project");
  for (const patch of [
    { env: { HTTP_PROXY: "http://x" } },
    { routes: { programs: { ".codebuffer-env-v1": "direct" } } },
    { routes: { programs: { "..": "direct" } } },
    { routes: { default: "personal" } },
    { routes: { proxies: { public: "http://user:pass@host" } } },
    {
      routes: {
        programs: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => ["cmd" + i, "inherit"]),
        ),
      },
    },
  ])
    assert.throws(() => c.update(patch));
  assert.deepEqual(c.snapshot(), new ExecutionContext("/project").snapshot());
});
