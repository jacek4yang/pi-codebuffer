import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScratchStore, defaults } from "../src/scratch.js";
import { State, ENTRY, revision, hash } from "../src/state.js";
import { BranchIndex } from "../src/index-cache.js";
import { compileTextPatchSet } from "../src/patch-set.js";
import { harness, textOf, jsonOf } from "./harness.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";

test("long incremental chains, bounded source cache, branch identity and mixed v1/IR history", () => {
  const entries: {
    id: string;
    type: string;
    customType: string;
    data: ReturnType<typeof revision>;
  }[] = [];
  const index = new BranchIndex(4 * 1024 * 1024);
  let source = "text(0);";
  let previous;
  for (let i = 0; i < 1200; i++) {
    const next = "text(" + i + ");";
    const r = revision(
      "a",
      next,
      previous,
      i ? { old: source, replacement: next } : undefined,
    );
    entries.push({ id: String(i), type: "custom", customType: ENTRY, data: r });
    const s = index.get("one", entries);
    assert.equal(s.get("a").source, next);
    previous = s.get("a");
    source = next;
  }
  assert.equal(index.reconstructions, 1200);
  index.get("one", entries);
  assert.equal(index.reconstructions, 1200);
  const tiny = new State(entries, 64);
  assert(tiny.cacheBytes <= 64);
  assert.equal(tiny.get("a", 1).source, "text(0);");
  assert(tiny.cacheBytes <= 64);
  const sibling = revision("a", "text(77);");
  assert.equal(
    index
      .get("one", [
        { id: "sibling", type: "custom", customType: ENTRY, data: sibling },
      ])
      .get("a").source,
    "text(77);",
  );
  assert.equal(index.get("two", entries).get("a").source, source);
});

test("protected capacity, simultaneous owners, corruption and symlink rejection", () => {
  const dir = mkdtempSync(join(tmpdir(), "codebuffer-fault-"));
  try {
    const store = new ScratchStore(join(dir, "owned"), {
      ...defaults,
      failures: 1,
    });
    const active = store.create("one", null, "text(1);");
    assert.throws(() => store.create("one", null, "text(2);"), /SCRATCH_QUOTA/);
    const other = store.create("two", null, "text(3);");
    assert.equal(store.get(active.ref, "one", new Set()).execution, "running");
    assert.throws(() => store.release(other), /SCRATCH_BUSY/);
    active.execution = "failed";
    store.update(active, active.revisions[0]!.metadata.id);
    const file = join(store.root, active.ref + ".json");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace("text(1);", "text(9);"));
    assert.throws(
      () => store.get(active.ref, "one", new Set()),
      /SCRATCH_CORRUPT/,
    );
    writeFileSync(file, original);
    store.release(active);
    symlinkSync(join(dir, "outside"), file);
    assert.throws(() => store.status(), /UNSAFE_SCRATCH_PATH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-text planning: add/delete/move, conflict, malformed final hunk changes nothing", () => {
  const source = "a\nb\n";
  const bases = new Map([
    ["a.txt", { source, hash: hash(source) }],
    ["gone.txt", { source: "", hash: hash("") }],
  ]);
  const plan = compileTextPatchSet(
    bases,
    "*** Begin Patch\n*** Update File: a.txt\n*** Move to: moved.txt\n@@\n-a\n+c\n*** Delete File: gone.txt\n*** Add File: new.txt\n+hello\n*** End Patch",
  );
  assert.deepEqual(
    plan.map((p) => p.kind),
    ["delete", "create", "delete", "create"],
  );
  assert.throws(
    () =>
      compileTextPatchSet(
        bases,
        "*** Begin Patch\n*** Delete File: a.txt\n*** Add File: A.TXT\n+x\n*** End Patch",
      ),
    /TARGET_CONFLICT/,
  );
  assert.throws(
    () =>
      compileTextPatchSet(
        bases,
        "*** Begin Patch\n*** Delete File: gone.txt\n*** Update File: a.txt\n@@\nmalformed\n*** End Patch",
      ),
    /PATCH_DIALECT/,
  );
  assert.equal(bases.get("a.txt")!.source, source);
  assert(bases.has("gone.txt"));
});

test("real SDK: 200 independent fused snippets, quotas and large range repair", async () => {
  const prior = process.env.PI_CODEBUFFER;
  process.env.PI_CODEBUFFER = JSON.stringify({
    scratch: { successes: 2, failures: 2 },
    durableBytes: 4096,
  });
  const h = await harness();
  try {
    const s = await h.make();
    for (let i = 0; i < 200; i++) {
      const result = await h.call(s, {
        action: "exec",
        source: "text(" + i + ");",
      });
      assert.equal(result.isError, false, textOf(result));
    }
    assert(
      readdirSync(join(h.dir, "scratch")).filter((n) => n.endsWith(".json"))
        .length <= 2,
    );
    const quota = await h.call(s, {
      action: "create",
      name: "large",
      source: "//" + "x".repeat(5000),
    });
    assert.match(textOf(quota), /DURABLE_QUOTA/);
    const bad = await h.call(s, {
      action: "exec",
      source: "const x=" + "unavailable".repeat(600) + ";",
    });
    const ref = jsonOf(bad);
    const fix = await h.call(s, {
      action: "repair",
      ref: ref.ref,
      base: ref.base,
      rerun: "from-start",
      edit: { format: "range", edits: [{ start: 8, end: 6608, text: "42" }] },
    });
    assert.equal(fix.isError, false, textOf(fix));
  } finally {
    if (prior === undefined) delete process.env.PI_CODEBUFFER;
    else process.env.PI_CODEBUFFER = prior;
    await h.close();
  }
});

test("real SDK cancellation retains exact source; no automatic retry", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const h = await harness({
    factories: [
      (pi) => {
        pi.on("tool_call", (e) => {
          if (e.toolName === "codemode") {
            calls++;
            entered();
          }
        });
      },
    ],
  });
  try {
    const s = await h.make();
    const source = "while(true) {}";
    const pending = h.call(s, { action: "exec", source });
    await started;
    await s.abort();
    await pending;
    const store = new ScratchStore(join(h.dir, "scratch"));
    const files = readdirSync(store.root).filter((n) => n.endsWith(".json"));
    assert.equal(files.length, 1);
    const record = JSON.parse(
      readFileSync(join(store.root, files[0]!), "utf8"),
    ) as { execution: string; revisions: { source: string }[] };
    assert.equal(record.revisions[0]!.source, source);
    assert.equal(record.execution, "interrupted");
    assert.equal(calls, 1);
  } finally {
    await h.close();
  }
});

test("killed source owner is recovered as interrupted, never replayed; orphan staging fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "codebuffer-crash-"));
  const root = join(dir, "owned");
  try {
    const module = new URL("../src/scratch.ts", import.meta.url).href;
    const source = "throw new Error(99);";
    const code =
      "import {ScratchStore} from " +
      JSON.stringify(module) +
      ";new ScratchStore(" +
      JSON.stringify(root) +
      ").create(" +
      JSON.stringify("crash") +
      ",null," +
      JSON.stringify(source) +
      ");process.kill(process.pid," +
      JSON.stringify("SIGKILL") +
      ");";
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", code],
      { encoding: "utf8" },
    );
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const file = readdirSync(root).find((n) => n.endsWith(".json"))!;
    const before = readFileSync(join(root, file), "utf8");
    const store = new ScratchStore(root);
    const recovered = store.get(file.slice(0, -5), "crash", new Set());
    assert.equal(recovered.execution, "interrupted");
    assert.equal(recovered.revisions[0]!.source, source);
    writeFileSync(join(root, "pending"), "incomplete", { mode: 0o600 });
    assert.throws(
      () => store.create("crash", null, "text(1);"),
      /SCRATCH_RECOVERY_REQUIRED/,
    );
    assert.equal(readFileSync(join(root, file), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const native = process.env.PI_CODEBUFFER_COMPANION;
const generation = process.env.PI_CODEBUFFER_GENERATION;
if (native && generation)
  for (const unified of [false, true])
    for (const companionsFirst of [false, true])
      test(`both companions, order ${companionsFirst}, unified ${unified}`, async () => {
        const h = await harness({
          companion: native,
          generation,
          companionsFirst,
          unified,
        });
        try {
          const s = await h.make();
          const tool = unified ? "code" : "codebuffer";
          const r = await h.call(
            s,
            { action: "exec", source: "text(missing);" },
            tool,
          );
          assert.equal(r.isError, true);
          const identity = jsonOf(r);
          await s.compact();
          const file = s.sessionManager.getSessionFile()!;
          s.dispose();
          const reopened = await h.make(SessionManager.open(file));
          const repaired = await h.call(
            reopened,
            {
              action: "repair",
              ref: identity.ref,
              base: identity.base,
              rerun: "from-start",
              edit: {
                format: "replace",
                edits: [{ old: "missing", replacement: "7" }],
              },
            },
            tool,
          );
          assert.equal(repaired.isError, false, textOf(repaired));
          const names = reopened.getActiveToolNames();
          assert(names.includes(tool));
          if (!unified) assert(names.includes("codemode"));
        } finally {
          await h.close();
        }
      });
