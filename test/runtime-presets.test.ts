import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { loadPresets, projectPatch } from "../src/runtime/presets.js";

test("workflow config imports routes/projects and bounded named commands without executing", () => {
  const root = mkdtempSync(join(tmpdir(), "presets-"));
  try {
    const path = join(root, "workflow.json");
    writeFileSync(
      path,
      JSON.stringify({
        routes: {
          public: "http://127.0.0.1:10809",
          personal: "http://127.0.0.1:10808",
        },
        programs: { git: "personal", curl: "public" },
        projects: {
          demo: {
            cwd: root,
            python: ".venv/bin/python",
            env: { A: "1", B: "2" },
          },
        },
        workflows: { test: "python -m pytest && git diff --stat" },
      }),
    );
    const presets = loadPresets(path, root);
    assert.equal(presets.routes?.programs.git, "personal");
    const patch = projectPatch(
      { project: "demo", env: { B: null, C: "3" } },
      presets,
    );
    assert.deepEqual(patch.env, { A: "1", B: null, C: "3" });
    assert.equal(patch.python, ".venv/bin/python");
    assert.throws(
      () => projectPatch({ project: "missing" }, presets),
      /UNKNOWN_PROJECT/,
    );
    writeFileSync(
      path,
      JSON.stringify({ workflows: { huge: "x".repeat(17000) } }),
    );
    assert.throws(() => loadPresets(path, root), /INVALID_WORKFLOW_COMMAND/);
    writeFileSync(
      path,
      JSON.stringify({ routes: { personal: "http://user:secret@localhost" } }),
    );
    assert.throws(() => loadPresets(path, root), /./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
