# TypeScript clients and destination routing

The client sends a logical backend label in the outer WebSocket handshake. The
bridge checks its server-owned policy, resolves the mapped address on its own
network, and opens that backend connection before accepting the tunnel. All RPCs
on that connection use the selected backend. One WebSocket selects one backend;
the bridge remains an opaque byte relay and does not inspect gRPC metadata or
application messages.

```ts
import { createClient } from "@connectrpc/connect";
import { openBridgeConnection } from "@dunkymole/grpc-bridge";
import { DemoService } from "./gen/demo_pb.js";

const connection = await openBridgeConnection({
  url: "ws://localhost:8080/tunnel", // Public bridge address
  tunnelToken: "", // Optional tunnel token
  target: "demo", // Resolved by the bridge
});
const client = createClient(DemoService, connection.transport);
try {
  console.log((await client.echo({ text: "hello" })).text);
} finally {
  await connection.close();
}
```

`openBridgeConnection({ url, target, tunnelToken })` awaits initial establishment;
`createBridgeConnection(options)` returns immediately and can recover from an
initial outage. Both expose a stable Connect transport with automatic session
recovery and explicit cleanup. RPC replay follows the [retry contract](../web/RETRIES.md).
The lower-level API remains `openChannel(url, token, { target: "demo" })`.
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
[interceptors.ts](../web/examples/interceptors.ts) demonstrates independent client
labels and shared metadata defaults on one connection.
[run.ts](../web/examples/run.ts) accepts `TUNNEL_URL`, `TUNNEL_TOKEN`, and
`BACKEND_TARGET` environment variables, plus optional `FORWARD_TUNNEL_TOKEN` for
the RPC examples. See [runner settings](CONFIGURATION.md#example-runner-environment).
Node 24+ supplies WebSocket and Web Streams; the shared client module also works
in a browser build.

## Add a backend without restarting the bridge

Make the service reachable from the bridge, then add a logical label and its
physical address to
[config/targets.json](../config/targets.json):

```json
{
  "targets": {
    "demo": { "address": "python-demo:50051", "tls": false },
    "agent": { "address": "agent-service.internal:50051", "tls": true },
    "orders": { "address": "orders.internal:443", "tls": true }
  }
}
```

Pass `agent` as the client's target. Labels must match
`^[a-z][a-z0-9_-]{0,62}$`; raw addresses are invalid targets. The bridge reads a
new policy snapshot on every new tunnel, including one using the default label.
No rebuild, redeployment, or bridge restart is needed. Compose mounts the
containing directory read-only into the container; operators can atomically
replace the file on the host.

TLS policy belongs to the server. With `tls: true`, the bridge validates the
backend certificate and hostname using its trust store and requires HTTP/2 ALPN.
The client cannot override this policy. DNS resolution happens inside the bridge,
so the browser does not need access to private DNS.

Removal blocks new connections using that label. Remapping affects new and
reconnected tunnels; existing tunnels retain their connections until closed.
An omitted target uses the configured `DEFAULT_TARGET` label (`demo` by default).
The default must exist in the policy. The shared tunnel token grants access to all
configured labels. With `ADMISSION_URL`, the admission service instead authorizes
the requested logical label for each connection; it never receives or authorizes
the physical backend address. See [admission configuration](CONFIGURATION.md#external-admission-and-the-reference-verifier).
Configure only destinations under operator control; the bridge is not an
unrestricted proxy.

## What goes over the wire

```http
GET /tunnel?target=demo HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Protocol: grpc-tunnel.v1
```

This excerpt omits ordinary WebSocket key/version headers. Authentication, when
enabled, adds an offered `auth.<token>` subprotocol, never a URL credential.
Destination selection adds bytes only during connection setup, with no extra
per-message routing header. One WebSocket carries one HTTP/2 connection. Other
tunnel protocol profiles and a new subchannel multiplexing layer are out of scope.

At the bridge protocol boundary, an explicitly empty or malformed label returns
HTTP 400; an unknown label returns 403; an unreadable or malformed policy returns
503; and failed backend connections return 502 before upgrade. The TypeScript
client validates labels locally and throws `TypeError` before opening a socket for
an invalid label. The policy file is bounded to 64 KiB. A broken policy file does
not affect existing tunnels.

## Why this is separate from gRPC metadata

RPC metadata such as `x-request-id` stays inside HTTP/2 and reaches the backend.
The bridge forwards these bytes without parsing them. An `x-target-host` RPC
header would not change the selected destination.

Likewise HTTP/2 `:authority` is separate from the TCP destination. The managed API
defaults it to the selected label, or `backend` when target is omitted, and accepts
an explicit `authority` for upstream virtual hosting. To reach another backend,
open another connection. Each connection
can still multiplex many RPCs.

Standard Connect interceptors can attach this metadata at either connection or
per-client scope. `interceptTransport(lease.transport, { baseUrl, interceptors })`
creates an independent client chain while retaining the same connection and lease
lifetime. Interceptor `baseUrl` is descriptive; it cannot change the selected
destination. See [client examples and header precedence](../web/README.md#connect-interceptors).

## Forwarding authentication to the backend

Set `backendBearerToken` to send a token as RPC bearer metadata. It accepts a
static value or async provider and can use the same value as `tunnelToken` when
that is intentional. Forwarding is off by default. See the
[configuration reference](CONFIGURATION.md#client-authentication-and-forwarding)
for precedence, security considerations, and runner environment variables.

## Reusing a channel

One channel already multiplexes many RPCs to one backend. Configure a
`SharedBridgeConnection` once with `createSharedBridgeConnection(options)`
and pass that handle to consumers. Its parameterless `acquire()` lazily opens
the connection and returns a lease. Concurrent leases share it; the last
`release()` closes it. `dispose()` permanently shuts down the handle, including
active leases and pending acquisitions. Separate destinations or identities
use separate handles; no per-acquisition credentials or destination matching is involved.
See the [package guide](../web/README.md#explicit-connection-reuse).
