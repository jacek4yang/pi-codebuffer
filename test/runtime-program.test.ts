import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Jobs } from "../src/runtime/jobs.js";
import { hostProgram } from "../src/runtime/program.js";
import type { Language } from "../src/runtime/environment.js";

test("host programs use stdin, preserve module/Unicode semantics and do not hit CLI argument limits", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-program-"));
  const jobs = new Jobs(root);
  try {
    for (const [language, executable, source, expected] of [
      [
        "node",
        process.execPath,
        'await Promise.resolve();console.log("🧪 node")',
        "🧪 node",
      ],
      ["python", "/usr/bin/python3", 'print("🧪 python")', "🧪 python"],
      ["bash", "/bin/bash", "printf '%s\\n' '🧪 shell'\n\n", "🧪 shell"],
      [
        "node",
        process.execPath,
        `console.log(${JSON.stringify("x".repeat(170000))}.length)`,
        "170000",
      ],
    ] as [Language, string, string, string][]) {
      const program = hostProgram(language, executable, source);
      assert(!program.args.includes(source));
      const id = jobs.start({
        executable,
        ...program,
        cwd: root,
        env: process.env,
      });
      const result = await jobs.wait(id, 5000);
      assert.equal(result.exitCode, 0, result.output);
      assert(result.output.includes(expected), result.output);
    }
  } finally {
    await jobs.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("incomplete programs never execute earlier source statements", async () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-syntax-"));
  const jobs = new Jobs(join(root, "jobs"));
  try {
    const target = join(root, "must-not-exist");
    for (const [language, executable, source] of [
      ["bash", "/bin/bash", `printf touched > ${JSON.stringify(target)}\nif`],
      [
        "python",
        "/usr/bin/python3",
        `open(${JSON.stringify(target)},'w').write('touched')\ndef incomplete(`,
      ],
      [
        "node",
        process.execPath,
        `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(target)},'touched');if (`,
      ],
    ] as [Language, string, string][]) {
      const id = jobs.start({
        executable,
        ...hostProgram(language, executable, source),
        cwd: root,
        env: process.env,
      });
      assert.equal((await jobs.wait(id, 5000)).state, "failed");
      assert(!existsSync(target));
    }
  } finally {
    await jobs.close();
    rmSync(root, { recursive: true, force: true });
  }
});
