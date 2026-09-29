# gRPC Bridge

**Native gRPC in the browser, through one WebSocket and a zero-dependency Go bridge.**

The browser runs HTTP/2. The bridge unwraps WebSocket payloads and forwards the
bytes to an ordinary gRPC server. Protobuf messages, stream IDs, flow control,
trailers, cancellation, and half-close remain native gRPC/HTTP/2.

```text
Generated Protobuf types + Connect typed client
                     │
          gRPC / HTTP/2 in the browser
                     │
          one WebSocket (WSS with TLS)
                     │
           Go bridge · opaque relay
                     │
              TCP / h2c (or TLS)
                     │
           ordinary Python gRPC service
```

This is a working **v0.1 prototype**, not a claim of production conformance.
It is a general-purpose transport for connecting browser clients to standard
gRPC services.

## Run it

Install Docker with Compose v2, then:

```sh
git clone https://github.com/dunkymole/grpc-bridge.git
cd grpc-bridge
docker compose up --build -d
```

Open **http://localhost:8080**, click **Connect**, then **Run interoperability checks**.
You can also interact with all four examples independently. Start counting and
send chat messages at the same time: both RPCs share the same HTTP/2 connection.

```sh
docker compose logs -f
docker compose down
```

Only the bridge's loopback port is published. Python is reachable inside the
Compose network; it exposes no host port. No API keys or cloud services required.

## What's implemented

- Unary, server-streaming, client-streaming, and genuinely full-duplex bidi RPCs.
- Standard Protobuf-ES generated schemas and Connect's `createClient()` facade.
- Standard Connect interceptors at connection and per-client scope, with isolated
  metadata for clients sharing one connection.
- One shared HTTP/2 connection, with concurrent streams and native trailers.
- Cancellation, deadlines, request half-close, explicit connection failure.
- Managed connection recovery, GOAWAY draining, transparent retries, and opt-in
  configured RPC retries with bounded replay buffers.
- Incremental gRPC parsing; 1 MiB message limit; awaitable input producers.
- A versioned tunnel profile, exact browser-origin checking, optional token auth.
- Fixed-size relay buffers, connection admission limits, ping/pong, write deadlines.
- HTTPS/WSS and verified TLS to the backend as deployment options.
- Client-selected backend addresses with a live, server-owned destination allowlist.
- Two non-root, read-only containers. The bridge is a static binary in `scratch`.

**Zero dependencies applies to the bridge:** Go standard library only, no Go
modules beyond this repository, no libc, shell, package manager, or runtime daemon
inside its image. The browser and Python service intentionally use established
Protobuf, HTTP/2, and gRPC libraries. Building requires toolchains; TLS trust uses
the CA certificate bundle copied into the image.

## Typed client

Use `openBridgeConnection(options)` when you own the connection lifetime.
For independent consumers, create one `SharedBridgeConnection` with
`createSharedBridgeConnection(options)` and pass it to them. Consumers call
`acquire()` and `release()`; the first acquisition opens the connection and
the last release closes it. The owner calls `dispose()` at shutdown or logout.

The reusable package is prepared as `@dunkymole/grpc-bridge` but is not yet
published to npm. Follow the [local installation steps](web/README.md#install)
to use the package imports below in your own project. Generate your service
descriptors with Protobuf-ES; demo descriptors are not included in the package.
See its
[API and compatibility guide](web/README.md), the
[runnable TypeScript examples](web/examples/client.ts), and the
[client addressing and routing guide](docs/CLIENT-AND-ROUTING.md). Run them with
`cd web && npm ci && npm run example` while the Compose stack is running.
The client sends the backend host and port in the WebSocket handshake. The bridge
authorizes and resolves it. Edit `config/targets.json` to onboard backends without
restarting the bridge. Destination selection is separate from gRPC metadata.

```ts
import { contract as DemoContract } from "./gen/demo_contract.js";
import { openBridgeConnection, inputQueue } from "@dunkymole/grpc-bridge";

const connection = await openBridgeConnection({
  url: "ws://localhost:8080/tunnel",
  target: "python-demo:50051",
});
const client = connection.client(DemoContract);
const input = inputQueue<{ text: string }>();

const receiving = (async () => {
  for await (const message of client.chat(input.messages)) {
    console.log(message.text);
  }
})();
await input.send({ text: "Hello, Python" });
// Responses arrive while the request is still open.
await input.complete();
await receiving;
await connection.close();
```

Await each `send()`; do not build an unbounded array of pending sends. Application
code should consume or cancel every response stream. Managed channels reconnect
automatically for future calls. They support transparent retries, GOAWAY draining,
and opt-in configured retries with bounded request buffering.
See the [retry contract and TypeScript example](web/RETRIES.md) and
[recovery and wait-for-ready guide](web/README.md#lifecycle-and-cleanup).

### Connect interceptors

Use connection-level `interceptors` for shared concerns such as request IDs,
authentication, or logging. Pass client-specific metadata or behavior in
`connection.client(contract, { interceptors })`. Both scopes compose over the
same connection:

```ts
import type { Interceptor } from "@connectrpc/connect";
import { openBridgeConnection } from "@dunkymole/grpc-bridge";
import { contract as DemoContract } from "./gen/demo_contract.js";

const requestId: Interceptor = (next) => async (req) => {
  req.header.set("x-request-id", crypto.randomUUID());
  return next(req);
};
const connection = await openBridgeConnection({
  url: "ws://localhost:8080/tunnel",
  target: "python-demo:50051",
  interceptors: [requestId],
});
const clientFor = (name: string) => connection.client(DemoContract, {
  interceptors: [(next) => async (req) => {
    req.header.set("x-client-name", name);
    return next(req);
  }],
});
try {
  const worker = clientFor("background-worker");
  const dashboard = clientFor("dashboard");
  await Promise.all([
    worker.echo({ text: "background work" }),
    dashboard.echo({ text: "dashboard request" }),
  ]);
} finally {
  await connection.close();
}
```

The clients share one WebSocket and retain independent metadata. Client
interceptors run before connection interceptors and the mandatory contract guard;
all run once per logical RPC, outside retries, for all four RPC shapes. The bridge
does not inspect application metadata. See [ordering, header precedence, and
shared-lease examples](web/README.md#connect-interceptors) and the
[runnable interceptor demo](web/examples/interceptors.ts).

## Development and verification

Requires Go 1.25+, Node 24+, and Python 3.12+. Container builds pin Go 1.27.1.

```sh
go test ./...
go vet ./...
go test ./cmd/bridge -fuzz=FuzzRelay -fuzztime=10s
cd web
npm ci
npm run build
npm test
npm run test:e2e    # running Compose stack required
```

The end-to-end suite exercises Python through the actual bridge: all four RPC
shapes, bidi responses before request half-close, 16 concurrent calls, a 180 KB
message crossing flow-control windows, trailers, native errors, deadlines,
cancellation, connection loss, and managed recovery. It also checks interceptor
isolation on shared connections, adds a new backend, and revokes its allowlist
entry without restarting the bridge while existing tunnels keep working.
`npm test` separately exercises retry faults against a real HTTP/2 server.
The page runs the core interoperability checks in a real browser; see the
[validation guide](docs/VALIDATION.md) for automated and manual coverage.

For code generation, after installing the backend requirements and web packages:

```sh
python -m grpc_tools.protoc -I proto --python_out=backend --grpc_python_out=backend proto/demo.proto
PATH="$PWD/web/node_modules/.bin:$PATH" python -m grpc_tools.protoc -I proto --es_out=web/src/gen --es_opt=target=ts proto/demo.proto
```

On Windows, add `web/node_modules/.bin` to the process PATH for the second command.
Generated source is checked in. The Python container regenerates from the same
`.proto` during its build.

## Configuration

See the [complete configuration reference](docs/CONFIGURATION.md) for every flag,
environment variable, destination policy field, client option, and fixed limit.
Token forwarding to backend RPCs is optional and disabled by default.

| Setting                          | Default                                  | Purpose                                              |
| -------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `LISTEN` / `-listen`             | `127.0.0.1:8080` (image: `0.0.0.0:8080`) | HTTP listener                                        |
| `UPSTREAM` / `-upstream`         | `127.0.0.1:50051`                        | Default backend when the client omits a target       |
| `TARGETS_FILE` / `-targets-file` | empty (Compose: `/config/targets.json`)  | Live JSON allowlist for client-selected destinations |
| `ALLOWED_ORIGIN` / `-origin`     | `http://localhost:8080`                  | Exact allowed browser Origin                         |
| `TUNNEL_TOKEN`                   | empty                                    | Optional shared base64url-safe token                 |
| `-max-connections`               | `256`                                    | Concurrent tunnel admission limit                    |
| `TLS_CERT`, `TLS_KEY`            | empty                                    | PEM files enabling HTTPS/WSS                         |
| `UPSTREAM_TLS=true`              | false                                    | Verify backend certificate and require `h2` ALPN     |
| `ASSETS` / `-assets`             | `web/dist` (image: `/web`)               | Demo files                                           |

To try authentication locally, set `TUNNEL_TOKEN` in an ignored `.env` file,
recreate the bridge, then enter that token in the demo. Tokens are offered in a
WebSocket subprotocol, never in the URL or echoed in the server response. A shared
token is a prototype access gate, not a user identity system. Native clients may
omit Origin; authentication, not Origin, controls non-browser access.

The default demo uses loopback HTTP/WS. For external deployment configure TLS,
an appropriate origin, and authentication. Do not log WebSocket request headers
containing the token. There is no arbitrary upstream URL routing.

`/livez` reports process liveness and remains successful during shutdown drain;
`/readyz` returns 503 once the bridge starts draining. A private plaintext health
listener on `HEALTH_LISTEN` (default `127.0.0.1:8082`) serves these probes, so Docker
healthchecks work when the public listener uses HTTPS/WSS. Compose does not publish
the private port. `/healthz` probes default-backend TCP availability. `/metrics`
exposes connection, traffic, failure, dial, and drain metrics; see the
[metrics reference](docs/METRICS.md) for definitions and Prometheus queries.

On the first SIGTERM/SIGINT the bridge rejects new tunnels, keeps liveness and
readiness observable, and lets existing tunnels finish for `DRAIN_GRACE_PERIOD`
(default 30 seconds, maximum 10 minutes). At the deadline it closes both tunnel
legs. A second signal forces immediate closure. Drain state and graceful/forced
shutdown counts are exported in `/metrics`.
The bundled Compose service allows 45 seconds for termination, covering the default
30-second drain and final HTTP shutdown. Set Kubernetes `terminationGracePeriodSeconds`
to more than `DRAIN_GRACE_PERIOD` plus five seconds so the orchestrator does not kill
the process before its configured drain completes.

## Memory

The relay uses two 16 KiB payload buffers per active tunnel, plus Go, HTTP/TLS,
socket, and kernel overhead. It never allocates according to an advertised
WebSocket payload length. Compose sets a 64 MiB container limit and a 48 MiB Go
soft memory target. These are safeguards, not a throughput or capacity guarantee.
See [validation notes](docs/VALIDATION.md) for measured prototype results.

## Design, limitations, and contributing

- [Architecture and tunnel protocol](docs/DESIGN.md)
- [Roadmap](docs/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Security scope](SECURITY.md)
- [Third-party acknowledgements](NOTICE.md)

Managed clients reconnect and support the documented transparent and opt-in
configured retries. Reconnection does not resume established streams; an
uncertain failure is replayed only if the configured policy permits it before
commitment. Compression, hedging, load balancing, and per-RPC routing in the
bridge are not implemented. See the [retry contract](web/RETRIES.md) and
[design limits](docs/DESIGN.md#deliberate-prototype-limits).

Licensed under [MIT](LICENSE).
