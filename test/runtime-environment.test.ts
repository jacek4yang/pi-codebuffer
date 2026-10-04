import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ExecutionContext } from "../src/runtime/context.js";
import {
  prepareEnvironment,
  validateContext,
} from "../src/runtime/environment.js";

test("program-specific proxy rules work inside ordinary shell commands, without parent mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "codebuffer-environment-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const name of ["git", "gh", "curl"])
      writeFileSync(
        join(bin, name),
        '#!/bin/sh\nprintf "%s:%s:%s\\n" "' +
          name +
          '" "${HTTP_PROXY-unset}" "${NO_PROXY-unset}"\n',
        { mode: 0o700 },
      );
    const c = new ExecutionContext(root);
    c.update({
      env: { PATH: bin + ":/usr/bin:/bin" },
      routes: {
        default: "direct",
        programs: { git: "personal", gh: "personal", curl: "public" },
        proxies: {
          public: "http://127.0.0.1:10809",
          personal: "http://127.0.0.1:10808",
        },
      },
    });
    const parent = {
      PATH: "/usr/bin:/bin",
      HTTP_PROXY: "wrong",
      NO_PROXY: "*",
    };
    const e = prepareEnvironment(
      c.snapshot(),
      "bash",
      join(root, "job"),
      parent,
    );
    const output = execFileSync(
      e.executable,
      ["-c", "git status; gh pr list; curl fixture"],
      { cwd: root, env: e.env, encoding: "utf8" },
    );
    assert.match(output, /git:http:\/\/127.0.0.1:10808:unset/);
    assert.match(output, /gh:http:\/\/127.0.0.1:10808:unset/);
    assert.match(output, /curl:http:\/\/127.0.0.1:10809:unset/);
    assert.equal(parent.HTTP_PROXY, "wrong");
    const direct = prepareEnvironment(
      c.snapshot(),
      "bash",
      join(root, "explicit"),
      parent,
      "direct",
    );
    assert.match(
      execFileSync(direct.executable, ["-c", "git status"], {
        env: direct.env,
        encoding: "utf8",
      }),
      /git:unset:unset/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("selected interpreter works directly and through PATH; context updates validate atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "codebuffer-interpreter-"));
  try {
    const executable = join(root, "python with spaces");
    writeFileSync(
      executable,
      '#!/bin/sh\nprintf "selected:%s:%s\\n" "$MODE" "$1"\n',
      { mode: 0o700 },
    );
    const c = new ExecutionContext(root);
    c.update(
      { python: executable, env: { MODE: "value with 'quotes'" } },
      (candidate) => validateContext(candidate, process.env),
    );
    const before = c.snapshot();
    assert.throws(() =>
      c.update({ cwd: "/missing-dir", python: "/missing-bin" }, (candidate) =>
        validateContext(candidate, process.env),
      ),
    );
    assert.deepEqual(c.snapshot(), before);
    const e = prepareEnvironment(
      c.snapshot(),
      "bash",
      join(root, "job"),
      process.env,
    );
    const output = execFileSync(
      e.executable,
      ["-c", "python one; python3 two"],
      { env: e.env, encoding: "utf8" },
    );
    assert.match(output, /selected:value with 'quotes':one/);
    assert.match(output, /selected:value with 'quotes':two/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
