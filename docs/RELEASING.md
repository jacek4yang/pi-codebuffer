# Releasing

GitHub-first; no npm publication policy. Do not publish to npm.

1. Update version/changelog and package-lock. Run all TESTING.md gates, saturation and deterministic replay. Review `npm pack --json`: no fixtures, secrets, sessions or local output.
2. Use a pull request. Protected `main` requires strict `verify`, resolved conversations and linear history; administrators are included. Do not bypass protections or force-push. Only squash merges are enabled.
3. Move the PR out of Draft only when review-ready. Wait for Linux and Windows boundary checks; squash merge when eligible.
4. Check out clean merged main, confirm its SHA, rerun gates and wait for main CI on that exact commit. Generate `npm pack --json`.
5. Tag that verified commit `v0.2.0`, push the tag, create a GitHub release and attach `pi-codebuffer-0.2.0.tgz` plus `SHA256SUMS`.
6. Download published assets into a new directory and verify hashes. In a temporary `PI_CODING_AGENT_DIR`, install `git:github.com/jacek4yang/pi-codebuffer@v0.2.0`, confirm tag SHA and run `npm run smoke:install -- --installed /absolute/installed/checkout`. Never alter unrelated active settings.
7. Record exact commit, PR/CI URLs, versions, package checksum, limitations and benchmark. No release claim if permissions block publication.

## Upgrade / rollback

`pi install git:github.com/jacek4yang/pi-codebuffer@v0.2.0`, then reload Pi. Back up sessions first. To roll back the installed package, install `git:github.com/jacek4yang/pi-codebuffer@v0.1.0` and reload. Existing v1 exact-only sessions remain readable. New named IR records require 0.2.0; retain that version or reopen an older session copy rather than editing session JSONL.

Scratch release/cleanup is not rollback of writes, commands or network calls already performed by native CodeMode. Do not remove uncertain crash evidence. `/codebuffer recover` inspects only.
