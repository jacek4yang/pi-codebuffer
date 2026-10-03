# Deterministic protocol replay

Measured locally on Node 24.21.0 / Pi 1.0.0 / Linux. `npm run benchmark -- /tmp/codebuffer-benchmark.json` runs both protocols on this SAME candidate and original QuickJS executor with a local deterministic SSE provider. It is not a historical v0.1.0 schema comparison or a paid-provider intelligence/billing study.

Workload: clean execution; 12 KiB syntax failure plus repair; 12 KiB runtime failure plus repair; 20 independent snippets; an 8 KiB block replacement. Total: 24 initial programs and 3 repairs. Mutation assertions must all pass.

| Measurement                                          | Legacy create/run + patch/run | Fused exec/repair |
| ---------------------------------------------------- | ----------------------------: | ----------------: |
| Top-level model tool calls                           |                            54 |                27 |
| Complete tool name + arguments JSON bytes            |                        45,900 |            35,245 |
| Full SDK tool-result JSON bytes                      |                        18,342 |            18,142 |
| Provider request bodies, including growing history   |                     5,452,551 |         2,395,538 |
| Provider SSE response body bytes                     |                       211,449 |           142,515 |
| Provider requests                                    |                           108 |                54 |
| Repeated tool declaration bytes (subset of requests) |                       796,500 |           398,250 |
| Separately submitted examples                        |                             0 |                 0 |
| Complete initial source submitted                    |                        33,012 |            33,012 |
| Old/replacement/text body bytes in repairs           |                         8,212 |                18 |
| Named delta reconstruction applications              |                            27 |                 0 |
| Measured named reconstruction time (ms)              |                          9.86 |              0.00 |
| Accounted retained named cache bytes                 |                       117,745 |                 0 |
| Final private scratch JSON bytes                     |                             0 |            10,710 |
| Durable custom-entry bytes                           |                        49,602 |                 0 |
| Workload wall time (ms)                              |                         5,446 |             4,739 |

Each protocol performs the same 26 native delegations: the initial syntax failure never delegates. Both already avoid full-program regeneration on repair. The fused improvement here is fewer top-level invocations and range editing without retransmitting an 8 KiB old body—not a claim that legacy exact patches regenerated everything.

Complete tool envelopes above are defined as `{name,arguments}` and the SDK result; separate full provider JSON/SSE body counters include framing/content and history but not HTTP headers. Repeated schemas are a subset, not an additional cost to add twice. Description examples are included there. The final status observation is excluded from workload call/byte totals. CodeBuffer status legacy metrics describe named history, so zero named reconstructions does not mean zero script execution. Scratch uses full bounded snapshots; JSON/hash verification overhead is included in workload time, not mislabeled as delta reconstruction.

Wall-clock timings and response byte lengths containing native runtime timing can vary; deterministic call counts, generated workloads and correctness assertions are the evidence. Retained cache accounting is not RSS, and scratch JSON size excludes filesystem allocation overhead. Separate tests exercise 1000 store lifecycles and 200 SDK snippets with tiny handle limits; this workload is not an infinite-history proof.

No tokenizer was used. No provider-reported billing/cache savings or improved model task success are claimed. No paid API was called.
