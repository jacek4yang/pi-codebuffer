# Security policy

Only the latest released version is supported. v0.1.0 is tested with Pi 1.0.0.

Do not post credentials, session files or exploitable details in a public issue.
Use [GitHub private vulnerability reporting](https://github.com/jacek4yang/pi-codebuffer/security/advisories/new).
Include versions, a minimal sanitized reproduction and expected impact.
Please allow time for investigation and coordinated disclosure.

This extension executes explicitly requested source through Pi's existing
CodeMode sandbox and permission hooks. Parse-only validation is not a security
boundary. Review the tools enabled in Pi and apply appropriate permission
policies. Do not rely on hidden declarations as authorization.

Sources and deltas persist in plaintext session files. Do not embed credentials
or private data you would not want in the session. Runtime results retain normal
Pi privacy semantics. Metadata/status exclude source, patch payloads, credentials
and hidden reasoning; no telemetry is collected.

The 0.2.0-alpha.1 candidate adds plaintext private scratch records outside the project. Modes/ownership/symlinks are checked on POSIX; Windows scratch is refused because Node mode bits do not establish a private ACL. Do not share the store across hosts or use network filesystems. Quotas bound logical owned payloads/reservations, not transcript size, allocated filesystem blocks or total RSS.

The exported patch planner does not authorize filesystem access. This candidate deliberately has no workspace-write backend: a new tool name does not automatically inherit policies guarding built-in edit/write. Ambiguous scratch crash artifacts fail closed; preserve evidence, stop all owning processes and inspect hashes before any manual recovery. No recovery ever executes source.
