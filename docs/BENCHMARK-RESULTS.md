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

## Clean post-fix repeats: October 19, 2026

Two sequential two-hour repetitions **passed** from a clean detached checkout of
merged `b613e636d15a24cd4caaca7e84a979e3c9f3a331`, with identical resolved workload
and fresh isolated containers between repetitions. Each uses 32 tunnels (eight
idle), concurrency 1 / 16 / 64, a 900 KB message, 2,000 churn cycles and the existing
recovery thresholds. The Windows/WSL host is an i9-8950HK with 12 logical CPUs,
Docker Desktop 4.93.0, Engine 29.8.1, WSL kernel 6.18.54.1 and cgroup v2.
Both final reports record identical source, workload, thresholds, Node 24.19.0,
CPU/host-memory identity and container image IDs. The host has 34,075,992,064
bytes of RAM; Docker reports 16,631,246,848 bytes available. The bridge image is
`sha256:15b5d2495bcc988c89ad8ff73a7ee559fdaa9440200595f66e9b305601c11900`;
the backend is `sha256:e7287c04b5925b8a782b6362e216c1404f6574efb2d490b59352c9d40c3aa739`.
The backend uses Python 3.12.14, grpcio 1.84.0 and protobuf 7.36.1. Container
limits remain bridge 128 MiB / backend 512 MiB, with bridge `GOMEMLIMIT=48MiB`.
The five-hour benchmark tunnel lifetime does not change production's one hour.
The source remained clean and unchanged through both runs; the runner exited zero.

| Measurement | Repetition 1 | Repetition 2 |
| --- | ---: | ---: |
| Start (UTC, October 19) | 06:46:44 | 08:47:39 |
| Elapsed including cleanup (seconds) | 7,223.25 | 7,223.30 |
| Successful operations | 4,252,126 | 4,238,611 |
| Errors | 0 | 0 |
| Operations / configured mixed-load second | 590.57 | 588.70 |
| Aggregate p50 / p95 / p99 (ms) | 44 / 111 / 134 | 44 / 113 / 139 |
| Unary / server-stream / client-stream / bidi counts | 1,063,033 / 1,063,044 / 1,063,022 / 1,063,027 | 1,059,655 / 1,059,661 / 1,059,646 / 1,059,649 |
| Tunnels, baseline → recovered | 0 → 0 | 0 → 0 |
| Goroutines, baseline → recovered | 6 → 6 | 6 → 6 |
| Allocated heap bytes, baseline → recovered | 459,064 → 2,126,248 | 448,584 → 1,111,352 |
| RSS bytes, baseline → recovered | 8,687,616 → 15,396,864 | 8,548,352 → 15,212,544 |
| Cgroup socket bytes, baseline → recovered | 0 → 0 | 0 → 0 |
| Cgroup kernel bytes, baseline → recovered | 573,440 → 1,622,016 | 524,288 → 1,568,768 |

All configured thresholds passed without changes: zero errors, aggregate p99
≤ 5 seconds, no remaining tunnels, and recovered growth ≤ 20 goroutines,
8 MiB allocated heap and 16 MiB RSS. Kernel accounting did **not** return to
baseline in either short recovery window and is not a gated recovery field.
These are broad regression limits, not production SLOs. Throughput differed by
0.32%; two repetitions do not establish statistical confidence or saturation.
Counts include one separate large-message operation, but exclude ramp probes
and churn RPCs; the denominator is configured mixed-load time, not total elapsed.

Fixed-stage analysis discards the initial 10% of samples within
each 40-minute concurrency stage. These are descriptive OLS slopes, not leak
proof or an extrapolated capacity limit:

| Run / workers | RSS slope (MiB/hour) | Heap slope (MiB/hour) | RSS first → last quartile mean (MiB) | Heap first → last quartile mean (MiB) |
| --- | ---: | ---: | ---: | ---: |
| 1 / 1 | +0.852 | +0.165 | 13.525 → 13.921 | 2.882 → 2.971 |
| 1 / 16 | +0.491 | +0.048 | 14.511 → 14.734 | 3.033 → 3.055 |
| 1 / 64 | +0.236 | +0.097 | 15.168 → 15.279 | 3.102 → 3.160 |
| 2 / 1 | +0.993 | +0.185 | 13.345 → 13.777 | 2.866 → 2.968 |
| 2 / 16 | +0.584 | +0.178 | 15.926 → 16.180 | 3.036 → 3.113 |
| 2 / 64 | −0.572 | +0.111 | 16.329 → 16.125 | 3.117 → 3.165 |

Goroutines remained exactly 102 in every retained fixed-stage sample (947–978
samples over approximately 36 minutes per trimmed stage). Heap continued cycling
with GC; RSS retained memory above baseline after disconnect. Run 2 had higher
middle/final-stage RSS, but lower recovered heap/RSS than run 1. Positive heap
slopes are retained, not rounded into zero growth; the negative final RSS slope
in run 2 is not proof of permanent recovery. Longer deployment-specific windows
are needed to distinguish allocator/GC behavior from any low-rate growth.

| Run / workers | Mean / maximum sampled bridge CPU (%) | Peak sampled RSS / heap (MiB) | Peak sampled socket / kernel bytes |
| --- | ---: | ---: | ---: |
| 1 / 1 | 9.89 / 16.92 | 13.961 / 3.871 | 12,288 / 1,564,672 |
| 1 / 16 | 104.41 / 117.72 | 15.273 / 4.060 | 65,536 / 1,613,824 |
| 1 / 64 | 108.26 / 131.23 | 15.918 / 4.245 | 77,824 / 1,728,512 |
| 2 / 1 | 9.86 / 16.17 | 13.832 / 3.876 | 8,192 / 1,560,576 |
| 2 / 16 | 104.37 / 117.54 | 16.656 / 4.195 | 65,536 / 1,646,592 |
| 2 / 64 | 107.82 / 160.58 | 16.676 / 4.257 | 77,824 / 1,691,648 |

This table uses all active-stage samples, unlike the trimmed trend table. CPU
means are arithmetic sample means; Docker's 100% is roughly one logical CPU,
not the whole 12-thread host. Sparse samples can miss peaks. Socket/kernel
accounting is not additive to RSS or to each other. This workload also includes
the Node driver and Python demo backend, whose limits were not profiled as
independent bottlenecks; observed operations/second is not a bridge capacity ceiling.

The [clean evidence archive](https://github.com/dunkymole/grpc-bridge/releases/tag/benchmark-clean-evidence-2026-10-19)
contains both final JSON/Markdown reports, all raw operations/resource JSONL,
`soak-comparison.json`, host/runtime manifest, clean TLS output and a standalone
post-run integrity checker. That checker verified all 8,490,737 operation records
against every shape's counts/min/max/mean/percentiles, all 6,411 raw samples
against the reports, identical source/environment/workload/thresholds, full
stage duration and recovery gates. Its output is retained as `evidence-integrity.json`.
The 72,339,423-byte ZIP has SHA-256
`72505d4a93f7fa97aa14657999e9839fc8aee92caafbfde4fe5967b9fa2b6679`.
The same prerelease separately retains the green post-fix CI artifacts; it is
an evidence archive, not an npm/package release. The exact measured source also
passed [tag CI](https://github.com/dunkymole/grpc-bridge/actions/runs/39219200694).

A pre-fix repeat was deliberately stopped after
about 15 minutes when the client bug was found; its partial data is retained as
superseded evidence, not counted as a pass. The first older attempt that lost
connections is likewise not a completed soak.

## Post-fix CI Chromium measurement (October 19)

In archived CI run 39211048798 (the source tree identified above), Chromium
153.0.8010.12 on Linux in the pinned Playwright container passed five
mixed-RPC interoperability iterations, then disconnected. Actual browser-process
RSS and cumulative CPU seconds were sampled via CDP plus `/proc`, separately
from page JS heap and the Node test driver.

| Sample | Page JS heap | Sum of reported process RSS | Cumulative process CPU |
| --- | ---: | ---: | ---: |
| Connected baseline | 3.34 MiB | 397.33 MiB | 1.07 s |
| After five iterations | 7.78 MiB | 434.79 MiB | 2.22 s |
| One second after disconnect | 8.14 MiB | 435.60 MiB | 2.25 s |

Elapsed baseline-to-final sampling time was 2.60 seconds; cumulative CPU increased
1.18 seconds. RSS totals double-count shared mappings and are not unique memory.
GC was not forced, and neither heap nor RSS returned to baseline in this short
observation. This is honest cost evidence, not a leak assertion or recovery gate.
It measures Chromium only, not Firefox/WebKit resource usage. Raw JSON is retained
in the CI ZIP on the [post-fix evidence release](https://github.com/dunkymole/grpc-bridge/releases/tag/benchmark-clean-evidence-2026-10-19).
Earlier local supplemental measurements remain in the original evidence release;
they are not pooled with this versioned CI sample.

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

Three clean-source Linux/amd64 Go 1.27.1 repetitions on an Intel i9-8950HK
compared 16 KiB verified echo round trips over warm plaintext versus WSS
connections. The source was `6479b57b8656b88f06f6f459d4bbf531c377b372`;
its Go sources and module files are identical to the post-fix soak revision.
The subsequent client fix changes TypeScript, not this Go fixture.

| Mode | Round-trip range | Aggregate two-direction MB/s | Allocated bytes/op |
| --- | ---: | ---: | ---: |
| Plaintext | 60.948–63.394 µs | 516.90–537.64 | 16,432 |
| WSS | 80.199–80.714 µs | 405.98–408.58 | 16,581–16,609 |

Median round-trip time rose about 31.5% (61.160 → 80.440 µs) in this fixture.
Earlier exploratory measurements (66.740–74.109 µs plaintext,
83.628–96.691 µs WSS) remain in the original evidence release; they are not
pooled with these clean-source repetitions. This is not a full TLS
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
deployment-specific validation beyond this baseline. The clean repeated-soak
comparison above completes this baseline, not those deployment-specific studies.

An earlier run was incomplete after connections became unavailable. Laptop
hibernation was suspected, and the one-hour default tunnel expiry was another
plausible contributor; root cause was not confirmed. The harness now stops when
the error budget is exceeded, handles slow-producer rejection immediately, and
settles concurrent tasks before writing a failure report. An intentional backend
shutdown verified a nonzero exit and complete reports without a retry flood.
