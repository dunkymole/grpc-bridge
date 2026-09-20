# TypeScript clients and destination routing

The client sends the final backend's `host:port` in the outer WebSocket handshake.
The bridge checks its allowlist, resolves that host on its own network, and opens
its backend connection before accepting the tunnel. All RPCs on that connection
use the selected backend.

```ts
import { createClient } from "@connectrpc/connect";
import { openBridgeConnection } from "@dunkymole/grpc-bridge";
import { DemoService } from "./gen/demo_pb.js";

const connection = await openBridgeConnection({
  url: "ws://localhost:8080/tunnel", // Public bridge address
  tunnelToken: "", // Optional tunnel token
  target: "python-demo:50051", // Resolved by the bridge
});
const client = createClient(DemoService, connection.transport);
try {
  console.log((await client.echo({ text: "hello" })).text);
} finally {
  await connection.close();
}
```

The managed package API is `openBridgeConnection({ url, target, tunnelToken })`.
It exposes a standard Connect transport and explicit lifecycle/cleanup. The
lower-level API remains `openChannel(url, token, { target: "host:port" })`.
For deployment use `wss://` with TLS and the configured browser Origin.

## Run the examples

Start `docker compose up --build -d`, then:

```sh
cd web
npm ci
npm run example
```

[client.ts](../web/examples/client.ts) demonstrates all four RPC shapes,
concurrent calls, metadata/trailers, and cancellation with connection reuse.
[run.ts](../web/examples/run.ts) accepts `TUNNEL_URL`, `TUNNEL_TOKEN`, and
`BACKEND_TARGET` environment variables. Node 24+ supplies WebSocket and Web Streams;
the shared client module also works in a browser build.

## Add a backend without restarting the bridge

Make the service reachable from the bridge, then add its exact address to
[config/targets.json](../config/targets.json):

```json
{
  "targets": {
    "python-demo:50051": { "tls": false },
    "agent-service.internal:50051": { "tls": true }
  }
}
```

Pass `agent-service.internal:50051` as the client's target. The bridge reads a new
policy snapshot on every new non-default destination selection. No rebuild,
redeployment, or bridge restart is needed. Compose mounts the containing directory
read-only into the container; operators can atomically replace the file on the host.

TLS policy belongs to the server. With `tls: true`, the bridge validates the
backend certificate and hostname using its trust store and requires HTTP/2 ALPN.
The client cannot override this policy. DNS resolution happens inside the bridge,
so the browser does not need access to private DNS.

Removal blocks new connections to that target. Existing tunnels retain their
connections until closed. An omitted target uses `UPSTREAM`, which is implicitly
allowed and uses `UPSTREAM_TLS`; changing that fallback requires a process restart.
The shared tunnel token grants access to all allowed targets. Per-user target
authorization remains future work. Allowlist exact destinations under operator
control; the bridge is not an unrestricted Internet proxy.

## What goes over the wire

```http
GET /tunnel?target=python-demo%3A50051 HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Protocol: grpc-tunnel.v1
```

This excerpt omits ordinary WebSocket key/version headers. Authentication, when
enabled, adds an offered `auth.<token>` subprotocol, never a URL credential.
Destination selection adds bytes only during connection setup, with no extra
per-message routing header. One WebSocket carries one HTTP/2 connection. Other
tunnel protocol profiles and a new subchannel multiplexing layer are out of scope.

Malformed destinations return HTTP 400, disallowed targets 403, unavailable or
invalid policy files 503, and failed backend connections 502 before upgrade.
The policy file is bounded to 64 KiB. A broken policy file does not affect existing
tunnels or the configured default upstream.

## Why this is separate from gRPC metadata

RPC metadata such as `x-request-id` stays inside HTTP/2 and reaches the backend.
The bridge forwards these bytes without parsing them. An `x-target-host` RPC
header would not change the selected destination.

Likewise HTTP/2 `:authority` is separate from the TCP destination. The managed API
defaults it to the selected target and accepts an explicit `authority` for upstream
virtual hosting. To reach another backend, open another connection. Each connection
can still multiplex many RPCs.

## Forwarding authentication to the backend

Set `backendBearerToken` to send a token as RPC bearer metadata. It accepts a
static value or async provider and can use the same value as `tunnelToken` when
that is intentional. Forwarding is off by default. See the
[configuration reference](CONFIGURATION.md#client-authentication-and-forwarding)
for precedence, security considerations, and runner environment variables.

## Reusing a channel

One channel already multiplexes many RPCs to one backend. The package's
`BridgeConnectionPool` can explicitly share it between clients when bridge URL,
target, HTTP/2 authority, scheme, and a caller-supplied `authenticationContext`
match. Leases are reference-counted; releasing the last lease closes the channel.
See the [package guide](../web/README.md#explicit-connection-reuse).
