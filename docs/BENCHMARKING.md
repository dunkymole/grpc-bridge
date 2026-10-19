# Load, resource, and recovery benchmarks

## Non-consuming reader/writer regression

Run `npm run benchmark:backpressure` from `web` after starting Compose with the
same project name. The reader case offers four 900 KB gRPC Chat messages, never
reads the response body, and verifies bridge-to-client bytes fill and then stall
at the channel's configured 65,535-byte per-stream window (with bounded framing
overhead). A separate HTTP/2 peer never reads request DATA and advertises a 16 KiB
stream window; the writer case verifies producer advancement stalls with at most
128 KiB pulled ahead. Both check a healthy sibling before and after cancel/reset,
then verify tunnel/goroutine/heap recovery. Dedicated containers are cleaned up;
JSON evidence is retained at `test-results/load/backpressure.json` in CI.

These bounded scenarios complement synthetic protocol over-credit/queue-limit
tests; they do not claim to exhaust every operating-system socket buffer or prove
long-term leak freedom.

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

Clean up from the repository root:

```sh
docker compose --project-name grpc-bridge-benchmark \
  -f compose.yaml -f compose.benchmark.yaml down --remove-orphans
```
