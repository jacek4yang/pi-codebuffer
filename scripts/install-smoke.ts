import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const expectedVersion = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
const target = mkdtempSync(join(tmpdir(), "pi-codebuffer-installed-"));
const installed =
  process.argv[2] === "--installed" ? resolve(process.argv[3]!) : undefined;
const artifact = installed
  ? undefined
  : resolve(process.argv[2] ?? `pi-codebuffer-${expectedVersion}.tgz`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
  const companion =
    process.env.PI_CODEBUFFER_COMPANION_TARBALL ??
    "git+https://github.com/jacek4yang/pi-codex-native-compaction.git";
  const generation =
    process.env.PI_CODEBUFFER_GENERATION_TARBALL ??
    "git+https://github.com/jacek4yang/pi-generation-recovery.git";
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--allow-git=all",
      "--no-audit",
      "--no-fund",
      ...(artifact ? [artifact] : []),
      companion,
      generation,
      "@earendil-works/pi-coding-agent@1.0.2",
      "@earendil-works/pi-ai@1.0.2",
      "typebox@1.3.27",
      "tsx@4.22.4",
    ],
    { cwd: target, stdio: "inherit" },
  );
  const extension = installed ?? join(target, "node_modules/pi-codebuffer");
  const manifest = JSON.parse(
    readFileSync(join(extension, "package.json"), "utf8"),
  );
  assert.equal(manifest.version, expectedVersion);
  assert(existsSync(join(extension, "editing.ts")));
  assert(existsSync(join(extension, "third-party/codex-APACHE-2.0.txt")));
  assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
  assert(existsSync(join(extension, "LICENSE")));
  if (!installed)
    assert(!existsSync(join(extension, "test")), "Do not ship fixtures");
  // Tests run outside the checkout, using only installed source and dependencies.
  cpSync(resolve("test"), join(target, "test"), { recursive: true });
  // Preserve runtime dependency resolution for Git installs (only acorn locally).
  symlinkSync(join(extension, "src"), join(target, "src"), "dir");
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "test/sdk.test.ts",
      "test/state.test.ts",
      "test/next.test.ts",
      "test/shorthand.test.ts",
      "test/reuse.test.ts",
      "test/retention.test.ts",
      "test/effects.test.ts",
      "test/examples.test.ts",
      "test/storage-encoding.test.ts",
      "test/legacy-scale.test.ts",
      "test/scratch-index.test.ts",
      "test/recovery.test.ts",
      ...readdirSync(resolve("test"))
        .filter((name) =>
          /^(runtime-|execution-context|host-buffer|job-journal).*\.test\.ts$/.test(
            name,
          ),
        )
        .map((name) => `test/${name}`),
    ],
    {
      cwd: target,
      stdio: "inherit",
      env: {
        ...process.env,
        PI_CODEBUFFER: "{}",
        PI_CODEBUFFER_TEST_EXTENSION: join(extension, "index.ts"),
        PI_CODEBUFFER_GENERATION: join(
          target,
          "node_modules/pi-generation-recovery/index.ts",
        ),
        PI_CODEBUFFER_COMPANION: join(
          target,
          "node_modules/pi-codex-native-compaction/index.ts",
        ),
      },
    },
  );
  console.log(
    JSON.stringify({
      packagedSmoke: "passed",
      extension,
      pi: "1.0.2",
      node: process.version,
      companion,
      generation,
    }),
  );
} finally {
  rmSync(target, { recursive: true, force: true });
}
