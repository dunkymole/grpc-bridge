# Prototype validation

## Current automated coverage

The [CI workflow](../.github/workflows/ci.yml) runs on pushes and pull requests:

| Check | Coverage |
| --- | --- |
| `go test -race ./...` and `go vet ./...` | Relay, handshake, routing, metrics, shutdown, TLS trust, close-frame, and concurrency checks. |
| `go test ./cmd/bridge -fuzz=FuzzRelay -fuzztime=10s` | Short WebSocket parser fuzz run. |
| `npm ci && npm run build && npm test` in `web/` | Strict TypeScript compilation, package exports, framing, shared ownership, recovery, retries, and interceptors. |
| `npm run contracts:verify` in a pinned Node container with `protobuf` | Regenerates and verifies the strict contract descriptor fixture. |
| `go test -race ./...` and `go vet ./...` in `examples/admission/` | Nested admission verifier module, which root module tests do not include. |
| `docker compose up --build -d --wait` | Build the bridge and Python backend and wait for health checks. |
| `npm run test:e2e && npm run example` in `web/` | All RPC shapes through the actual WebSocket relay, live routing changes, metadata, shared leases, recovery, and runnable examples. |
| Pinned Playwright Compose project | Strict-contract browser clients in Chromium, Firefox, and WebKit. |
| `scripts/run-autobahn.sh` | Pinned Autobahn subset with exact case-policy and report validation. |
| Focused bridge TLS/drain Go tests | Local-CA WSS/upstream ALPN and process trust checks, plus health/shutdown cases. |

CI repeats the integration suite and examples after enabling tunnel-token
authentication. Locally, two rejection tests skip when `TUNNEL_TOKEN` is empty.
Run tests against a Compose stack started from the same checkout: routing tests
edit that checkout's `config/targets.json`, which must be the mounted policy file.

Retry tests use a real Node HTTP/2 server to inject refusals, GOAWAY, socket loss,
and retryable statuses. Five cases compare behavior with `@grpc/grpc-js`. See the
[retry validation scope](../web/RETRIES.md#validation-and-scope). Interceptor tests
cover all four RPC shapes, concurrent metadata isolation, ordering, deadlines,
shared leases, and invocation counts across retry/replacement attempts.

## Real-browser checks

The Playwright suite runs the demo in Chromium, Firefox, and WebKit from the
version-matched `mcr.microsoft.com/playwright:v1.63.0-noble` image, pinned by
manifest digest. The npm Playwright dependency is pinned to `1.63.0`; the image
provides Chromium `153.0.8010.12`, Firefox `155.0`, and WebKit `26.6`.
The suite is sequential and records a JSON report plus traces on failure. It runs
the page's four RPC shapes, 16 concurrent calls, a 180 KB message, error status,
deadline, cancellation, and connection loss followed by a fresh healthy call.
The loss case checks that an in-flight operation fails and recovery does not replay
it. This is an automated compatibility smoke matrix for those pinned engines, not
a certification of every browser version or operating system.

Run the suite in an isolated Compose project and host port so it does not share a
local bridge stack:

```sh
BRIDGE_PORT=18081 \
  docker compose --project-name grpc-bridge-browser-gates \
  -f compose.yaml -f compose.browser.yaml \
  up --build --abort-on-container-exit --exit-code-from browser-test
docker compose --project-name grpc-bridge-browser-gates \
  -f compose.yaml -f compose.browser.yaml down --remove-orphans
```

Reports are written under `web/test-results/`. The same core checks passed in
headless Edge on 28 September 2026 using two concurrent per-client interceptor
wrappers over one shared connection, including deadlines, cancellation, trailers,
and large messages.

The strict-contract client path passed all six checks in the pinned Chromium,
Firefox, and WebKit images on 29 September 2026.

CI runs the browser and Autobahn projects separately from the ordinary bridge
Compose project. It always removes each named test project and uploads
`web/test-results/` and `test-results/autobahn/` as the
`bridge-validation-<run>-<attempt>` artifact, including reports and failure
traces when present. The browser job has a 1 GiB shared-memory allocation and
uses the pinned Playwright image; Autobahn is limited to the checked-in 57-case
selection and may report the explicit diagnostic outcomes documented below.

## WebSocket conformance checks

`scripts/run-autobahn.sh` runs the pinned AutobahnTestsuite `25.10.1` against the
actual Go WebSocket parser and relay, connected to a small raw TCP echo service.
The image is pinned by digest, the run gets a unique report directory and Compose
project, and the checker validates the suite's `index.json` and every per-case
JSON file. Empty, incomplete, stale, malformed, or non-passing outcomes fail.
The checked-in per-case policy pins the exact `behavior` and `behaviorClose`
outcomes; broad status allowlists cannot turn a regression green. The latest run
had 48 asserted `OK`/`OK` cases, six `NON-STRICT`/`OK` diagnostics, and three
`INFORMATIONAL`/`INFORMATIONAL` diagnostics. The six non-strict cases send text
before malformed data, so the bridge's intentional early rejection does not
assert the later malformed-frame behavior. `7.1.6` is likewise text-first; `7.13.1`
and `7.13.2` use undefined close codes and remain informational diagnostics.
These diagnostic cases are reported separately and are not counted as passing
conformance assertions.

The selected cases cover server control frames, fragmentation, payload validation,
and close-frame behavior. Cases `7.1.1`, `7.1.4`, and `7.1.5` are explicitly
excluded because they require the server to echo text data messages; this tunnel
profile accepts binary data frames only. Separate Go regressions put malformed
RSV bits and unsupported opcodes on binary frames so text-profile rejection
cannot mask those parser checks. Compression and performance/load suites are
outside this focused correctness run. This subset is not a claim of full Autobahn
certification. `python -m unittest discover -s scripts -p 'test_*.py'` verifies
that the report checker rejects missing, empty, stale, incomplete, duplicate-key,
and failing reports, and enforces the diagnostic policy.

## TLS and slow-peer checks

Go tests create a local CA and verify WSS through the production gateway and
upstream TLS with HTTP/2 ALPN. They cover trusted certificates, unknown roots,
wrong hostnames, and a trusted upstream without ALPN; certificate verification
remains enabled. A subprocess test builds and runs the production binary with
`SSL_CERT_FILE` set to the test CA, then verifies WSS and the upstream application
echo, so this also exercises Go's normal process trust configuration.

`TestRelayBackpressuresSlowUpstreamWithinOneChunk` stalls the upstream side of a
real `net.Pipe`, sends a 1 MiB binary WebSocket frame, and checks that the relay
reads only its current chunk plus bounded reader lookahead before blocking. It
then closes both legs and verifies that the relay and producer goroutines exit.
The HTTP/2 response-queue and HPACK tests cover their corresponding receive
budgets. These focused tests do not measure process RSS or certify sustained
slow-peer load.

## Initial baseline: 14–15 September 2026

Observed in Linux containers under Docker Desktop/WSL2, with Go 1.27.1,
Python 3.12, grpcio 1.84.0, Node 24.19.0, and Chrome. This historical run predates
managed recovery, RPC retry policies, and interceptor support.

- Both Compose containers built and became healthy.
- Go unit/integration tests, Linux race detection, and `go vet` passed.
- A three-second parser fuzz run completed 122,421 executions without a failure.
  This is a smoke test, not sustained fuzzing or conformance certification.
- TypeScript strict compilation and gRPC framing/status unit tests passed.
- The Python interoperability suite passed through the containerized bridge.
- The same nine interoperability checks passed in Chrome's actual WebSocket and
  browser HTTP/2 client; the page displayed `ALL CHECKS PASSED`.
- The connection-loss test rejected an in-flight call and successfully created a
  fresh session without replaying the old operation.
- A separate token-authenticated bridge passed the same suite and rejected an
  incorrect token before upgrading the connection.

The interoperability checks cover all four RPC patterns, responses before bidi
request completion, native trailers, 16 concurrent RPCs on one connection, a
180 KB message across flow-control windows, native error status, deadline, and
stream cancellation while preserving the shared connection.

## Historical memory sample

This baseline was captured before live destination selection was added.
Linux `/proc/1/status` of the bridge process reported:

| Situation | Resident memory (RSS) | Threads |
| --- | ---: | ---: |
| Warm process before connection sample | 8,896 KiB (8.69 MiB) | 8 |
| 100 open HTTP/2 tunnels, each after a completed echo | 13,640 KiB (13.32 MiB) | 12 |

The observed RSS increase was 4,744 KiB, approximately 47 KiB per additional
tunnel in this particular small-message sample. This is not a per-connection
maximum or throughput benchmark. TLS, slow peers, concurrent traffic, Go GC,
kernel socket memory, and a different platform change the result. RSS excludes
some kernel memory. Docker's older statistics endpoint returned zeros on this
host, so the measurement used the process's own Linux status file instead.

The scratch image with the demo assets and license notices was 7,867,236 bytes.
Later rebuilds can change that slightly. The Go binary has
no third-party modules and is built with `CGO_ENABLED=0`.

To reproduce the connection sample, run from the repository root. The measurement
script expects the `grpc-bridge-bridge-1` container and the legacy image alias
`grpc-bridge_backend`; create that alias from the Compose backend image:

```sh
docker compose -p grpc-bridge up --build -d --wait
docker tag $(docker compose -p grpc-bridge images -q backend) grpc-bridge_backend
cd web
npm ci
npx tsx scripts/measure-memory.ts
```

The script opens 100 real HTTP/2 channels, exercises each against Python, reads
RSS from the target container's PID namespace, and closes the channels. It uses
the existing Python image only as a temporary inspection tool.

## Not yet claimed

No comprehensive HTTP/2 audit, long-duration memory stress, production load
benchmark, multi-browser support certification, or external security review has
been completed. The Autobahn selection is partial. The TLS checks use local test
certificates and do not certify a production certificate/deployment topology.
See the roadmap.
