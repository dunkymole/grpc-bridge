# Load, resource, and recovery benchmarks

## Browser process resource sampling

The Chromium/Linux browser gate includes `browser-tests/resources.spec.ts`:
five repetitions of all four RPC shapes, concurrent calls, a large message,
cancellation and deadlines, followed by disconnect. CDP supplies OS process IDs
and cumulative CPU seconds; `/proc/<pid>/status` supplies actual browser/renderer,
GPU and network-service RSS. Page JS heap is sampled separately. This never
substitutes Node test-driver memory for browser memory. JSON is saved to
`test-results/load/browser-resources.json` and attached to the Playwright result.
Other engines are explicitly skipped for this measurement only; their interop
tests remain enabled. Summed RSS includes shared mappings, not unique memory.
Normal GC is not forced and one-second recovery does not prove leak freedom.

## Mixed-RPC admission and shutdown lifecycle

After starting Compose, run `npm run benchmark:lifecycle` from `web`, with the
same `COMPOSE_PROJECT_NAME` used for the stack. This isolated test creates its
own bridge/verifier/audited-backend containers on the Compose network and removes
only those containers afterward. Existing stack containers are not signaled.

All four RPC shapes run concurrently. It tests admission quota/outage rejection
and short-grant expiry while a healthy sibling survives; graceful shutdown rejects
new tunnels while existing calls finish; a 500 ms drain deadline cuts off long
unary and response-committed server streams. A separate backend invocation log
requires every expected call identifier exactly once, detecting loss or replay
for the exercised calls. The low-level channel intentionally does not reconnect.
Final JSON results/audit are retained at `test-results/load/lifecycle.json` and
uploaded by CI. The normal Go lifecycle tests complement this with quota/global
accounting cleanup and both-leg closure assertions. This bounded regression is
not a prolonged lifecycle soak or a guarantee about application-configured retries.

## Admission regression under concurrent traffic

`go test -race ./cmd/bridge -run TestAdmissionQuotaStorm -count=3` drives the
real WebSocket upgrade/relay path with eight concurrent handshake workers
(64 quota/authorization denials) alongside 100 verified sibling echo frames.
It verifies denied attempts never dial the backend, grant expiry closes the
affected tunnel, its quota can be reused, a separate principal still exchanges
data after expiry, and principal/tunnel accounting recovers after disconnect.
This is a bounded opaque-byte relay regression, not a mixed-RPC capacity test.
The regular Go CI test step includes it. Mixed-RPC retry safety and
drain/forced-close workloads still need separate coverage before completing #4.

`go test -race ./cmd/bridge -run 'TestAdmissionOutageDuringEstablishedTraffic|TestTunnelLifetimeExpiresDuringContinuousTraffic' -count=3`
adds eight concurrent verifier-failure requests (503 and request timeout) alongside
100 verified established-tunnel frames, checks fail-closed behavior without extra
backend dials, then restores admission and checks new connections and cleanup.
The lifetime case keeps exchanging data until the configured 500 ms maximum
closes each tunnel, repeats three connection cycles, and verifies accounting
recovery. These are bounded relay regressions, not prolonged mixed-RPC tests.

See the [October 2026 four-hour soak results](BENCHMARK-RESULTS.md) for retained
evidence, environment, provenance and limitations.

The benchmark drives the real Compose bridge and Python backend through the
TypeScript client. It is a capacity and leak-regression tool, not a universal
hardware-independent performance score.

It ramps tunnel counts and RPC concurrency, keeps a configured subset of tunnels
idle, mixes all four RPC shapes, sends a large message, pauses a server-streaming
consumer, cancels another call while checking a healthy sibling, churns fresh
connections, pauses a client-streaming producer while checking another healthy
RPC, and then verifies that tunnels and process resources recover toward
their baseline.

## Smoke profile

Start an isolated stack from the repository root:

```sh
docker compose --project-name grpc-bridge-benchmark \
  -f compose.yaml -f compose.benchmark.yaml up --build -d --wait
cd web
npm ci
COMPOSE_PROJECT_NAME=grpc-bridge-benchmark npm run benchmark:smoke
```

PowerShell uses the same profile with environment variables set separately:

```powershell
$env:COMPOSE_PROJECT_NAME = "grpc-bridge-benchmark"
$env:BENCH_PROFILE = "smoke"
docker compose -f compose.yaml -f compose.benchmark.yaml up --build -d --wait
Set-Location web
npm ci
npm run benchmark
```

The smoke profile runs for approximately 15–30 seconds. It fails on any mixed
workload error, p99 above 5 seconds, tunnels remaining after recovery, more than
20 additional goroutines, more than 8 MiB additional Go heap, or more than
16 MiB additional RSS. These deliberately broad thresholds detect severe
regressions in shared CI; they are not service-level objectives.

## Soak profile

The default soak holds mixed load for four hours, uses 32 tunnels and up to 64
concurrent RPCs, then performs 2,000 connection churn cycles:

The benchmark overlay sets tunnel lifetime to five hours so the default one-hour
deployment expiry does not invalidate this sustained-connection workload.
Expiry behavior remains a separate test; production defaults are unchanged.
Workers stop when the configured operation-error budget is exceeded. Concurrent
tasks settle before cleanup and report generation, including failed sibling RPCs.

```sh
COMPOSE_PROJECT_NAME=grpc-bridge-benchmark BENCH_PROFILE=soak npm run benchmark
```

Run the soak on an otherwise idle Linux Docker host. Keep the generated JSON and
Markdown report with the machine type, Docker version, revision, and raw operation
latencies. Compare multiple runs on the same host before setting tighter limits.
The helper used for exact RSS joins the bridge PID namespace but runs from the
already-built backend image; the scratch bridge image remains unchanged.

Results are written under `web/test-results/load/`, which is ignored by Git and
uploaded by CI's existing validation-artifact rule. JSON schema version 2 contains
the resolved profile, thresholds, environment, latency summaries, and resource
samples. Raw operation durations/errors are streamed to `.operations.jsonl` and
resource snapshots to `.samples.jsonl` alongside the result, so a multi-hour run
does not accumulate every operation in the driver's memory. Percentiles use
bounded one-millisecond histogram buckets. The Markdown file is the concise report.

## Configuration

All overrides are positive integers except counts explicitly allowing zero:

| Variable | Smoke default | Soak default | Meaning |
| --- | ---: | ---: | --- |
| `BENCH_TUNNELS` | 4 | 32 | Peak simultaneous tunnels. |
| `BENCH_IDLE_TUNNELS` | 1 | 8 | Open tunnels excluded from RPC work. |
| `BENCH_CONCURRENCY` | 8 | 64 | Peak concurrent RPC workers. |
| `BENCH_DURATION_SECONDS` | 5 | 14400 | Total mixed-load duration across three ramp stages. |
| `BENCH_CHURN_CYCLES` | 12 | 2000 | Fresh connect, unary RPC, and close cycles. |
| `BENCH_LARGE_MESSAGE_BYTES` | 180000 | 900000 | Large unary request/response payload. |
| `BENCH_SLOW_CONSUMER_HOLD_MS` | 300 | 5000 | Time a server stream is left unconsumed. |
| `BENCH_RECOVERY_SECONDS` | 10 | 60 | Maximum wait for tunnel cleanup. |
| `BENCH_OUTPUT` | `test-results/load/<profile>.json` | same | JSON result path. |
| `TUNNEL_URL` | `ws://localhost:8080/tunnel` | same | Public bridge endpoint. |
| `METRICS_URL` | `http://localhost:8080/metrics` | same | Bridge metrics endpoint. |
| `BENCH_TARGET` | unset | unset | Optional allowlisted backend target. |

Thresholds can be changed with `BENCH_MAX_ERRORS`, `BENCH_MAX_P99_MS`,
`BENCH_MAX_GOROUTINE_GROWTH`, `BENCH_MAX_HEAP_GROWTH_BYTES`, and
`BENCH_MAX_RSS_GROWTH_BYTES`. Never relax a threshold only to make a noisy run
green; first retain the raw report and identify host contention or a regression.

CPU is sampled from Docker and RSS from `/proc/1/status`. Go heap and goroutines
come from `/metrics`. RSS includes stacks and mapped runtime memory but not all
kernel socket memory; container limits remain the hard deployment bound. Browser
engine memory is outside this Node-driven workload and should be measured by a
separate browser-process harness before making browser capacity claims.

Where cgroup v2 is available, samples also include `cgroupSocketBytes` (`sock`)
and `cgroupKernelBytes` (`kernel`) from the bridge process's own cgroup filesystem
through `/proc/1/root/sys/fs/cgroup/memory.stat`. Missing support is omitted, not
invented as zero. These are container-level accounting, not per-RPC costs, and
must not be blindly added to RSS (or to one another). Sampling can miss short
peaks. Environment records include CPU model/architecture, host memory, exact
container image IDs and source revision/status captured before load starts.
Set `BENCH_REQUIRE_CLEAN=1` for publishable clean-source runs; a dirty checkout
is rejected before artifacts are opened.

Run `go test ./cmd/bridge -run '^$' -bench BenchmarkTunnelTLSOverhead -benchtime=1s -count=3`
to compare fixed 16 KiB warm-connection relay round trips over plaintext and WSS.
Certificate verification remains enabled. Reported MB/s counts both directions;
allocation counts cover the in-process test fixture. TLS handshakes, upstream TLS,
HTTP/2/gRPC processing, browser work and real network latency are excluded. This
microbenchmark describes one cost component, not a production throughput score.

Clean up from the repository root:

```sh
docker compose --project-name grpc-bridge-benchmark \
  -f compose.yaml -f compose.benchmark.yaml down --remove-orphans
```
