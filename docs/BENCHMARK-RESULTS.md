# gRPC Bridge benchmark evidence and limitations

## Coverage and provenance

The following deterministic gates are merged and passed in
[post-fix CI](https://github.com/dunkymole/grpc-bridge/actions/runs/39211048798).
That run's source tree (`160a2beb42d055b7bc588a5e24196c6ae0e99142`) is identical
to merged revision `b613e636d15a24cd4caaca7e84a979e3c9f3a331`.

| Requirement | Reproducible gate | Retained evidence |
| --- | --- | --- |
| Tunnel/RPC ramps, all shapes, idle/churn/large messages | `npm run benchmark:smoke` and `npm run benchmark -- soak` | Final reports, raw operation/resource JSONL |
| Quota storms, verifier outage/recovery and expiry | Go admission/load tests plus `npm run benchmark:lifecycle` | Go CI log and `load/lifecycle.json` |
| Graceful drain and forced close under four concurrent shapes | `npm run benchmark:lifecycle` | 14 unique backend invocation IDs, all audited exactly once |
| Actual non-consuming readers/writers and reset isolation | `npm run benchmark:backpressure` | `load/backpressure.json`, bounded windows and post-reset cleanup |
| Actual browser process memory/CPU, separate page heap | Chromium `browser-tests/resources.spec.ts` | `load/browser-resources.json` and Playwright attachment |
| Kernel/socket accounting and frontend TLS cost | Soak cgroup samples and `BenchmarkTunnelTLSOverhead` | Raw JSON plus TLS benchmark output |
| Fixed-stage resource growth and repeated recovery | `npm run benchmark:analyze -- <reports>` | `load/soak-comparison.json` after complete repeats |

The CI lifecycle gate completed admission in 3,269 ms, graceful drain in 557 ms,
and the forced scenario in 886 ms (641 ms signal-to-exit). The 500 ms grace is
checked with a two-second CLI/scheduler tolerance. All four forced in-flight RPC
shapes must report `Unavailable`; client-streaming and bidi producers remain held
until the process exits. New tunnels are rejected and committed requests are not
replayed. Quota/global accounting and both-leg closure are also covered by Go
tests. These are bounded scenarios, not a prolonged rolling-deployment soak.

The stronger gate exposed a real client bug: a resumed canceled input producer
could replace the connection failure with `Unknown`/a closed-controller error.
The transport now ignores late input after cancellation/abort. Regression tests
cover late yield, return and throw, with and without configured `Unavailable`
retries, preserving the original failure and one committed invocation. Existing
retry/commit-boundary tests remain enabled; application-configured retries are
not a license to replay non-idempotent committed work.

## Clean post-fix repeats: in progress

Two sequential two-hour repetitions are running from a clean detached checkout of
merged `b613e636d15a24cd4caaca7e84a979e3c9f3a331`, with identical resolved workload
and fresh isolated containers between repetitions. Each uses 32 tunnels (eight
idle), concurrency 1 / 16 / 64, a 900 KB message, 2,000 churn cycles and the existing
recovery thresholds. The Windows/WSL host is an i9-8950HK with 12 logical CPUs,
Docker Desktop 4.93.0, Engine 29.8.1, WSL kernel 6.18.54.1 and cgroup v2.
The reports record exact image IDs, source, Node, CPU and host-memory identity.

There are **no final repeat results yet**. Issue #4 remains open until both
reports, fixed-stage slopes/quartile means, recovery and repeat comparison have
been inspected and published. A pre-fix repeat was deliberately stopped after
about 15 minutes when the client bug was found; its partial data is retained as
superseded evidence, not counted as a pass. The first older attempt that lost
connections is likewise not a completed soak.

## Supplemental Chromium measurement (October 19)

Chromium 153.0.8010.12 on Linux in the pinned Playwright container passed five
mixed-RPC interoperability iterations, then disconnected. Actual browser-process
RSS and cumulative CPU seconds were sampled via CDP plus `/proc`, separately
from page JS heap and the Node test driver.

| Sample | Page JS heap | Sum of reported process RSS | Cumulative process CPU |
| --- | ---: | ---: | ---: |
| Connected baseline | 3.24 MiB | 370.30 MiB | 0.74 s |
| After five iterations | 7.66 MiB | 406.27 MiB | 2.34 s |
| One second after disconnect | 8.02 MiB | 408.10 MiB | 2.48 s |

Elapsed baseline-to-final sampling time was 2.53 seconds; cumulative CPU increased
1.74 seconds. RSS totals double-count shared mappings and are not unique memory.
GC was not forced, and neither heap nor RSS returned to baseline in this short
observation. This is honest cost evidence, not a leak assertion or recovery gate.
It measures Chromium only, not Firefox/WebKit resource usage. Raw JSON is retained
with the [evidence release](https://github.com/dunkymole/grpc-bridge/releases/tag/benchmark-evidence-2026-10-19)
and future CI browser artifacts.

## Original four-hour soak: October 18–19, 2026

Result: **PASS** for this workload and host, not a production capacity guarantee.

### Workload and environment

- Started 2026-10-18 19:35:58 UTC; elapsed 14,426.2 seconds (four hours plus cleanup).
- Windows 10.0.22631, 12 logical CPUs, Docker Engine 29.8.1, Node 24.19.0.
- Base revision `910e7bd21572e089b6ec6699df9abb888b7d4dd2` with local changes.
  The run included this benchmark implementation and separate, uncommitted
  configuration/diagnostics changes. The raw JSON records working-tree status;
  this is not evidence from an
  exact clean checkout of the published commit.
- 32 tunnels (eight idle), concurrency ramp 1 / 16 / 64, 14,400 seconds mixed
  load across three stages, all four RPC shapes, a 900,000-byte message,
  five-second slow consumer/producer holds, cancellation and sibling checks,
  then 2,000 connection churn cycles and resource recovery.
- Benchmark container limits: bridge 128 MiB, backend 512 MiB. Tunnel lifetime
  five hours, versus the unchanged one-hour production default.

Reproduce using the [benchmark guide](BENCHMARKING.md), default soak profile,
and `COMPOSE_PROJECT_NAME=grpc-bridge-benchmark`. Exact resolved parameters,
thresholds, versions, samples and operation durations are in the evidence bundle.

### Results

| Measurement | Observed |
| --- | ---: |
| Successful operations | 8,319,011 |
| Operation errors | 0 |
| Operations / configured mixed-load second | 577.7 |
| Aggregate p50 / p95 / p99 | 45 / 111 / 134 ms |
| Unary / server-stream / client-stream / bidi counts | 2,079,757 / 2,079,759 / 2,079,743 / 2,079,752 |
| Open tunnels, baseline → recovered | 0 → 0 |
| Goroutines, baseline → recovered | 6 → 6 |
| Go allocated heap, baseline → recovered | 0.93 → 1.32 MiB |
| RSS, baseline → recovered | 9.09 → 14.34 MiB |

All configured thresholds passed: zero errors, p99 ≤ 5 seconds, at most 20
additional goroutines, 8 MiB additional allocated heap, 16 MiB additional RSS,
and no remaining tunnels. These broad regression thresholds are not SLOs.
Percentiles use one-millisecond buckets. The throughput denominator is configured
mixed-load time, not end-to-end elapsed time; the operation count also includes
the separately recorded large-message operation.

## Evidence and limitations

### Supplemental TLS and kernel accounting (October 19)

Three Linux/amd64 Go 1.27.1 repetitions on an Intel i9-8950HK compared 16 KiB
verified echo round trips over warm plaintext versus WSS connections:

| Mode | Round-trip range | Aggregate two-direction MB/s | Allocated bytes/op |
| --- | ---: | ---: | ---: |
| Plaintext | 66.740–74.109 µs | 442.16–490.98 | 16,432 |
| WSS | 83.628–96.691 µs | 338.89–391.83 | 16,593–16,606 |

Median round-trip time rose about 21% in this fixture. This is not a full TLS
capacity model: handshake, upstream TLS, application and real-network costs are
excluded, and allocation totals include the test process. The reproducible
benchmark is `BenchmarkTunnelTLSOverhead`; raw output is in the evidence release.

A kernel-aware smoke run (1,477 operations, zero errors, p99 41 ms) separately
sampled bridge cgroup v2 accounting: socket memory was 0–4 KiB and kernel memory
897,024–929,792 bytes, recovering to 0 and 905,216 bytes. These sparse container
samples can miss peaks; they are not per-connection budgets or additive RSS.

[Download the compressed reports and raw JSONL evidence](https://github.com/dunkymole/grpc-bridge/releases/tag/benchmark-evidence-2026-10-19).
The bundle contains the final JSON and Markdown reports, raw operation durations,
and resource time series. Large artifacts are excluded from source packages and
Docker build contexts.

The original plaintext soak itself excludes browser/TLS/kernel and lifecycle
costs; the separate gates and supplemental observations above cover those
components, not one unified production deployment. Process-local quotas do not
imply fleet-wide quotas. Neither sparse samples nor a finite test window prove
absence of all leaks, every socket-buffer bound or hardware-independent capacity.
Do not tighten CI thresholds or derive enterprise sizing from a single laptop.
Sustained upstream-TLS/handshake churn, every browser engine's memory, production
network topology, fleet behavior and application-specific retry policy require
deployment-specific validation beyond this baseline. Clean repeat analysis and
the final comparison remain pending.

An earlier run was incomplete after connections became unavailable. Laptop
hibernation was suspected, and the one-hour default tunnel expiry was another
plausible contributor; root cause was not confirmed. The harness now stops when
the error budget is exceeded, handles slow-producer rejection immediately, and
settles concurrent tasks before writing a failure report. An intentional backend
shutdown verified a nonzero exit and complete reports without a retry flood.
