# Releasing

GitHub-first. Do not publish npm for v0.1.0.

1. Develop on a feature branch, update version/changelog and keep package-lock in
   sync. Run all gates in [TESTING](TESTING.md), including packaged installation.
2. Open a pull request. The protected `main` requires a PR, strict `verify`,
   resolved conversations and linear history. Zero approving reviews suits the
   single-maintainer project. Rules enforce administrators too. No routine bypass,
   force push or branch deletion. Only squash merges are enabled.
3. Wait for checks, fix failures on the feature branch and squash merge only when
   eligible. Record the merged main SHA and confirm it through GitHub.
4. Check out clean merged main and rerun gates. Produce `npm pack --json`.
5. Tag that verified commit `v0.1.0`, push the tag, and create a GitHub release.
   Attach `pi-codebuffer-0.1.0.tgz` and `SHA256SUMS` generated with
   `sha256sum pi-codebuffer-0.1.0.tgz`.
6. Download the published assets into a new directory and verify their hashes.
7. With a temporary `PI_CODING_AGENT_DIR`, run:
   `pi install git:github.com/jacek4yang/pi-codebuffer@v0.1.0`.
   Confirm the installed checkout matches the tag and run
   `npm run smoke:install -- --installed /path/to/the/installed/checkout`.
   Do not modify the user's ordinary Pi settings for a smoke test.
8. Record versions, PR, merge SHA, CI, release URLs, tarball checksum, benchmark
   and limitations. Do not claim correctness solely from passing tests.

Actions use immutable SHAs and least-privilege read permissions. GitHub release
assets, not a local tarball or tag alone, are the final artifact to verify.
