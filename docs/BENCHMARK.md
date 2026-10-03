# Deterministic protocol replay

Measured locally on Node 24.21.0 / Pi 1.0.0 / Linux. `npm run benchmark -- /tmp/codebuffer-benchmark.json` runs both protocols on the SAME implementation and original QuickJS executor with a local deterministic SSE provider. It is not a historical v0.1.0 schema comparison or a paid-provider intelligence/billing study.

Workload: clean execution; 12 KiB syntax failure plus repair; 12 KiB runtime failure plus repair; 20 independent snippets; an 8 KiB block replacement. Total: 24 initial programs and 3 repairs. Mutation assertions must all pass.

| Measurement                                          | Legacy create/run + patch/run | Fused exec/repair |
| ---------------------------------------------------- | ----------------------------: | ----------------: |
| Top-level model tool calls                           |                            54 |                27 |
| Complete tool name + arguments JSON bytes            |                        45,900 |            35,245 |
| Full SDK tool-result JSON bytes                      |                        18,342 |            13,799 |
| Provider request bodies, including growing history   |                     5,430,411 |         2,262,583 |
| Provider SSE response body bytes                     |                       211,449 |           142,515 |
| Provider requests                                    |                           108 |                54 |
| Repeated tool declaration bytes (subset of requests) |                       774,360 |           387,180 |
| Separately submitted examples                        |                             0 |                 0 |
| Complete initial source submitted                    |                        33,012 |            33,012 |
| Old/replacement/text body bytes in repairs           |                         8,212 |                18 |
| Named delta reconstruction applications              |                            27 |                 0 |
| Measured named reconstruction time (ms)              |                          9.89 |              0.00 |
| Accounted retained named cache bytes                 |                        71,641 |                 0 |
| Final private scratch JSON bytes                     |                             0 |            10,710 |
| Durable custom-entry bytes                           |                        49,602 |                 0 |
| Workload wall time (ms)                              |                         5,899 |             4,785 |

Each protocol performs the same 26 native delegations: the initial syntax failure never delegates. Both already avoid full-program regeneration on repair. The fused improvement here is fewer top-level invocations and range editing without retransmitting an 8 KiB old body—not a claim that legacy exact patches regenerated everything.

Complete tool envelopes above are defined as `{name,arguments}` and the SDK result; separate full provider JSON/SSE body counters include framing/content and history but not HTTP headers. Repeated schemas are a subset, not an additional cost to add twice. Description examples are included there. The final status observation is excluded from workload call/byte totals. CodeBuffer status legacy metrics describe named history, so zero named reconstructions does not mean zero script execution. Scratch uses full bounded snapshots; JSON/hash verification overhead is included in workload time, not mislabeled as delta reconstruction.

Wall-clock timings and response byte lengths containing native runtime timing can vary; deterministic call counts, generated workloads and correctness assertions are the evidence. Retained cache accounting is not RSS, and scratch JSON size excludes filesystem allocation overhead. Separate tests exercise 1000 store lifecycles and 200 SDK snippets with tiny handle limits; this workload is not an infinite-history proof.

Fused scratch metadata at the end: 4 entries / 1,434 serialized logical bytes. Across 80 store scans: 13.3 ms scan time and 3 canonical record reads (0.48 ms parsing/verification), separate from executor time.

## Saturation and legacy history

`npm exec -- tsx scripts/saturation.ts /tmp/codebuffer-saturation.json` builds 1,024 ~12 KiB records across 32 sessions with mixed outcomes, then measures status, reopen, overflow eviction, and 10k/50k v1 branches. Results are local observations, not latency guarantees.

The initial combined baseline exceeded a 210-second timeout. A diagnostic isolated warm status at 85–124 ms for 1,024 records. The optimized complete fixture finished in about 19 seconds: scratch build ~12.8 s, warm status p50 11.4 ms / p95 11.9 ms (max 12.4 ms), restart verification ~81 ms, logical record storage 12,757,895 bytes. The index is bounded, in-memory and rebuildable; restart still validates every canonical record.

For 50k legacy events, first reconstruction ~1.4 s, cached access ~2.6 ms, navigation ~0.7 s, restart ~1.27 s in the standalone run. Parallel test-suite timings are higher (~4.4 s for the whole multi-branch regression). Revision-ID lookup is no longer quadratic and the retained index no longer double-counts canonical source. The standalone process reported peak RSS 390,070,272 bytes; the 50k phase heap delta was 89,091,144 bytes (GC-sensitive), neither is logical cache accounting. These measurements do not promise bounded RSS or constant-time rebuilding for arbitrary histories.

Real-agent observations are recorded separately in [DOGFOOD.md](DOGFOOD.md). No tokenizer was used. No provider-reported billing/cache savings or improved model task success are claimed. No paid API was called.
