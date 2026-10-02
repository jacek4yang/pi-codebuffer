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
