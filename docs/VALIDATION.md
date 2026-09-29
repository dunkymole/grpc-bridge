# Prototype validation

## Current automated coverage

The [CI workflow](../.github/workflows/ci.yml) runs on pushes and pull requests:

| Check | Coverage |
| --- | --- |
| `go test -race ./...` and `go vet ./...` | Relay, handshake, routing, metrics, shutdown, and concurrency checks. |
| `go test ./cmd/bridge -fuzz=FuzzRelay -fuzztime=10s` | Short WebSocket parser fuzz run. |
| `npm ci && npm run build && npm test` in `web/` | Strict TypeScript compilation, package exports, framing, shared ownership, recovery, retries, and interceptors. |
| `docker compose up --build -d --wait` | Build the bridge and Python backend and wait for health checks. |
| `npm run test:e2e && npm run example` in `web/` | All RPC shapes through the actual WebSocket relay, live routing changes, metadata, shared leases, recovery, and runnable examples. |

CI repeats the integration suite and examples after enabling tunnel-token
authentication. Locally, two rejection tests skip when `TUNNEL_TOKEN` is empty.
Run tests against a Compose stack started from the same checkout: routing tests
edit that checkout's `config/targets.json`, which must be the mounted policy file.

Retry tests use a real Node HTTP/2 server to inject refusals, GOAWAY, socket loss,
and retryable statuses. Five cases compare behavior with `@grpc/grpc-js`. See the
[retry validation scope](../web/RETRIES.md#validation-and-scope). Interceptor tests
cover all four RPC shapes, concurrent metadata isolation, ordering, deadlines,
shared leases, and invocation counts across retry/replacement attempts.

## Browser checks

After starting Compose, open `http://localhost:8080`, connect, and run the page's
interoperability checks. These are manual browser checks, separate from Node CI.
On 28 September 2026, the same core checks also passed in headless Edge using two
concurrent per-client interceptor wrappers over one shared connection, including
deadlines, cancellation, trailers, and large messages. This is not a cross-browser
support certification.

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

No Autobahn conformance run, comprehensive HTTP/2 audit, long-duration memory
stress, production load benchmark, multi-browser support certification, or
external security review has been completed. Optional WSS/upstream TLS modes
still need deployment-level interoperability coverage. See the roadmap.
