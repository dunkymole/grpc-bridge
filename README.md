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
- One shared HTTP/2 connection, with concurrent streams and native trailers.
- Cancellation, deadlines, request half-close, explicit connection failure.
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

The reusable package is prepared as `@dunkymole/grpc-bridge`. See its
[API and compatibility guide](web/README.md), the
[runnable TypeScript examples](web/examples/client.ts), and the
[client addressing and routing guide](docs/CLIENT-AND-ROUTING.md). Run them with
`cd web && npm ci && npm run example` while the Compose stack is running.
The client sends the backend host and port in the WebSocket handshake. The bridge
authorizes and resolves it. Edit `config/targets.json` to onboard backends without
restarting the bridge. Destination selection is separate from gRPC metadata.

```ts
import { createClient } from "@connectrpc/connect";
import { DemoService } from "./gen/demo_pb.js";
import { openBridgeConnection, inputQueue } from "@dunkymole/grpc-bridge";

const connection = await openBridgeConnection({
  url: "ws://localhost:8080/tunnel",
  target: "python-demo:50051",
});
const client = createClient(DemoService, connection.transport);
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
code should consume or cancel every response stream. The client never reconnects,
retries, or replays RPCs automatically.

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
cancellation, connection loss, and explicit reconnect. It also adds a new backend and revokes its allowlist entry without restarting
the bridge, while existing channels keep working. The page runs the same
interoperability checks in a real browser.

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

`/healthz` probes backend TCP availability; `/metrics` exposes connection counts,
establishment failures, forwarded bytes, and backend dial duration. See the
[metrics reference](docs/METRICS.md) for definitions and Prometheus queries. Health checks cover the default upstream only. The built-in Docker healthcheck uses local HTTP; override it if enabling
direct HTTPS inside the container.

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

No automatic retry, resumption, compression, or per-RPC bridge routing is
implemented. A dropped tunnel fails its active calls. Reconnecting starts a new
HTTP/2 connection; applications decide whether an operation is safe to retry.

Licensed under [MIT](LICENSE).
