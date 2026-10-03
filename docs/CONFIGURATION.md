# Configuration

`PI_CODEBUFFER` is a JSON object; unknown keys, types and limits are rejected.

```json
{
  "enabled": true,
  "hideRawCodemode": true,
  "debug": false,
  "preferredFormat": "replace",
  "cacheBytes": 33554432,
  "durableBytes": 67108864,
  "scratch": {
    "scratchBytes": 67108864,
    "successes": 4,
    "failures": 16,
    "revisions": 8,
    "ttlMs": 86400000
  }
}
```

`scratchDirectory` optionally selects an absolute private store path. Never point it at project source, a session directory, or shared/untrusted storage. Isolated tests select a temporary directory. Partial `scratch` settings merge with defaults. Limits are positive integers: count limits at most 64, revisions at most 8, TTL at most 7 days, byte limits at most 256 MiB. Cache/durable budgets must be at least 4096 bytes. A store smaller than reservation requirements rejects work safely.

`preferredFormat` is advisory: `replace`, `range`, `apply_patch` remain accepted regardless of provider/model. There is no model-ID inference or provider registration. `debug` only enables compatibility notifications, not source logging. No network/proxy settings or telemetry.
