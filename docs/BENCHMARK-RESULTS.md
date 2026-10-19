# Four-hour soak: October 18–19, 2026

Result: **PASS** for this workload and host, not a production capacity guarantee.

## Workload and environment

- Started 2026-10-18 19:35:58 UTC; elapsed 14,426.2 seconds (four hours plus cleanup).
- Windows 10.0.22631, 12 logical CPUs, Docker Engine 29.8.1, Node 24.19.0.
- Base revision `910e7bd21572e089b6ec6699df9abb888b7d4dd2` with local changes.
  The run included this benchmark implementation and separate, uncommitted
  configuration/diagnostics changes. Those unrelated changes are not included in
  this PR. The raw JSON records working-tree status; this is not evidence from an
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

## Results

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

[Download the compressed reports and raw JSONL evidence](https://github.com/dunkymole/grpc-bridge/releases/tag/benchmark-evidence-2026-10-19).
The bundle contains the final JSON and Markdown reports, raw operation durations,
and resource time series. Large artifacts are excluded from source packages and
Docker build contexts.

This Node-driven, plaintext, single-host workload does not measure browser memory,
TLS overhead, socket/kernel memory, fleet-wide quotas, or admission expiry and
deployment drain/forced-close under load. A paused consumer of small messages is
not proof that every flow-control/resource bound is exercised. Resource recovery
passes the stated thresholds; it does not establish absence of all leaks or
hardware-independent capacity. Issue #4 remains open for those coverage gaps.

An earlier run was incomplete after connections became unavailable. Laptop
hibernation was suspected, and the one-hour default tunnel expiry was another
plausible contributor; root cause was not confirmed. The harness now stops when
the error budget is exceeded, handles slow-producer rejection immediately, and
settles concurrent tasks before writing a failure report. An intentional backend
shutdown verified a nonzero exit and complete reports without a retry flood.
