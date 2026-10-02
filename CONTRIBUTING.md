# Contributing

Use Node 24+, `npm ci --no-audit --no-fund`, then the checks in
[docs/TESTING.md](docs/TESTING.md). Keep strict TypeScript and small focused tests.
Run `npm run format` before opening a PR.

All changes go through feature branches and protected-main PRs. Include the
problem, behavior change and actual validation results. Do not weaken CI or
request routine administrator bypass. Only squash merges are accepted.

Preserve Pi's public executor and session boundaries. Never copy its sandbox,
permissions, MCP or model runtime. New persistence changes require restart,
branch, corruption and compaction regression coverage. Do not add fuzzy patches
or execution replay to this release line. Discuss broader scope in an issue.

Contributions are licensed under the MIT license. Follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Report sensitive vulnerabilities privately
as described in [SECURITY.md](SECURITY.md).
