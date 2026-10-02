# Testing

Use Node 24+:

```sh
npm ci --no-audit --no-fund
npm run check
npm run format:check
npm pack --json
npm run smoke:install -- pi-codebuffer-0.1.0.tgz
```

`check` includes strict TypeScript, ESLint and unit/real-SDK tests.
The isolated smoke installs the actual tarball, pinned Pi 1.0.0 and released
native-compaction v0.3.1 outside this checkout, then copies only regression tests
and installed state code into that directory. Execution uses installed extension
files and installed dependencies, not the repository's node_modules.

The companion tarball is fetched from its GitHub release and checked against
SHA-256 `07f68ae5bdb2aa8d4e1aa8ed8046646a70524831c9fb9ece2e2d1d24d188c118`.
Set `PI_CODEBUFFER_COMPANION_TARBALL` to an already downloaded tarball to avoid
redownloading. Curl/npm respect the invoking environment; no proxy is configured.
Ordinary CI requires no credentials. A local companion test can also run with
`PI_CODEBUFFER_COMPANION=/absolute/path/to/its/index.ts npm test`.

## Evidence

Tests use the released Pi SDK, real agent loop, public resource loader, actual
CodeMode QuickJS runtime and localhost HTTP/SSE provider. Only model responses
are scripted. Dummy OAuth credentials are test-only; no paid API is called.

- Baseline without adapter: active model-only CodeMode is not callable.
- Adapted run: raw declaration absent from actual provider request, executor
  active and callable, original models-disabled option retained.
- Structured tool results, images, discovery, persistent store, partial output,
  runtime errors, nested permission rejection and recursion guard.
- 12,367-byte invalid source created once; syntax run invokes no executor;
  82-byte model-facing patch request (34-byte delta), then successful run.
- Actual nested read offset failure fixed by only changing the argument.
- Unique/ambiguous/overlapping/missing/deleting patches; immutable parent/hash,
  stale bases, bad state, Unicode byte metrics and configuration rejection.
- Disk reopen, fork and real SDK tree navigation isolate abandoned revisions.
- Real ordinary compaction and restart preserve source but do not project custom
  source entries into the provider request.
- Native companion's actual checkpoint hook and restart preserve both its opaque
  checkpoint and CodeBuffer revisions without lifecycle interception.

The benchmark is deterministic byte accounting, not measured token savings.
No live-provider, live-MCP-server, billing or remote Codex correctness claim is
made. Those services remain delegated to Pi rather than reimplemented.

CI runs the same local gates plus the isolated installed regressions, and uploads
the tarball. The required protected-branch job is named `verify`.
