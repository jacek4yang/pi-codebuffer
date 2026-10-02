# Failure model

| Failure                                     | Outcome                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| Existing buffer name                        | `BUFFER_EXISTS`; patch it, do not recreate                                    |
| Missing revision                            | `REVISION_NOT_FOUND`                                                          |
| Old text absent                             | `PATCH_NOT_FOUND`; inspect relevant source                                    |
| Old text repeated/overlapping               | `PATCH_AMBIGUOUS`; include more exact context                                 |
| Empty old text                              | schema rejection / `PATCH_EMPTY`                                              |
| Stale base                                  | `STALE_REVISION`; read head and intentionally retry                           |
| Oversized source / too many names           | `SOURCE_TOO_LARGE` / `BUFFER_LIMIT`                                           |
| Syntax-invalid create/patch                 | persists an invalid revision with location; patchable, not runnable           |
| Syntax-invalid run                          | error with recovery instruction; CodeMode not invoked                         |
| Tool/runtime/permission error               | original CodeMode output plus revision and patch/rerun instruction            |
| Cancellation                                | signal forwarded to Pi; no new source revision; prior side effects may remain |
| Corrupt custom entry                        | `STATE_CORRUPT`; no execution or automatic rewrite                            |
| Missing original executor / unsupported API | explicit unavailable/incompatible error                                       |
| Wrong action arguments                      | schema validation or `INVALID_ARGUMENTS`; no mutation                         |
| Recursive nested executor                   | `CODEMODE_RECURSION_BLOCKED`                                                  |

A failed patch may increment its failure counter but **never creates a revision**.
A syntax-invalid patch is a successful textual mutation, not a failed patch.
Historical revisions remain immutable and readable even after a repair.

No network request, project write, nested tool call or source evaluation occurs
during parse precheck. QuickJS runtime semantics remain authoritative and may
reject a source that passed precheck.

## Side effects are not rolled back

Revision execution is not transactional. There is no journal or replay cache.
The extension neither retries execution automatically nor decides which previous
effects can be skipped. An interrupted operation may already have changed
external state. Rerunning any revision starts at its first statement. Review and
reconcile effects manually, particularly after writes, deployments and payments.

## Privacy

Source is explicit model-generated input, not captured model reasoning.
Session files store source/deltas unencrypted; secrets embedded in input remain
there, and runtime output may expose them under normal Pi semantics. Metrics and
metadata do not harvest credentials, environment variables, reasoning or outputs.
Debug does not log source. No telemetry or proxy configuration.

## Compatibility

Tested Pi 1.0.0, Node 24.21.0, Linux. Windows/macOS and other Pi releases are not
certified. Provider-independent object-root schemas and real provider adapters
are exercised locally; tests do not prove every remote provider accepts every
request. The native companion test uses a synthetic encrypted checkpoint,
not a production Codex checkpoint.

The declaration fallback leaves raw CodeMode visible. It cannot bypass an
incompatible executor API. Do not load a competing custom `codemode` replacement.
No concurrent multi-process session writers are supported.
