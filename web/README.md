# @dunkymole/grpc-bridge

Typed gRPC over a WebSocket tunnel from browsers and Node 24+. The package runs
HTTP/2 in the client, exposes a standard Connect `Transport`, and works with
generated Protobuf-ES service descriptors. The bridge forwards the resulting byte
stream without decoding HTTP/2, gRPC, or protobuf.

The package follows Semantic Versioning. During `0.x`, a minor release can contain
breaking API changes; patch releases remain backward-compatible within that minor.

## Install

The package is not yet published to npm. From the repository's `web/` directory,
install its build dependencies and create a local tarball:

```sh
npm ci
npm pack
```

Then, from your consuming project, install the emitted file (adjust the path):

```sh
npm install /path/to/dunkymole-grpc-bridge-0.1.0.tgz @connectrpc/connect@2.2.0 @bufbuild/protobuf@2.15.0
```

`npm pack` builds the package automatically. The pinned versions above match its
current runtime dependencies. Generate service descriptors from your `.proto`
files with Protobuf-ES; generated demo code is not part of the package. The examples
below use application-owned generated services. `session` denotes your application's
current credentials, not a library-provided object. For a ready-to-run local backend
and demo descriptors, use the [repository examples](https://github.com/dunkymole/grpc-bridge/tree/main/web/examples).

## Choose a connection API

| API | When to use it |
| --- | --- |
| `createBridgeConnection(options)` | Return immediately, including during an initial outage; close explicitly when finished. |
| `openBridgeConnection(options)` | Await the first connection attempt; reject and close if that attempt fails. |
| `createSharedBridgeConnection(options)` | Open lazily on `acquire()` and share reference-counted leases between consumers. |
| `interceptTransport(transport, options)` | Add client-specific interceptors to an existing transport without changing connection ownership. |

The first three accept the same `BridgeConnectionOptions`:

| Option | Default | Purpose |
| --- | --- | --- |
| `url` | Required | Public `ws://` or `wss://` bridge endpoint. |
| `target` | Omitted | Exact backend `host:port`; omission selects the bridge's configured upstream. |
| `tunnelToken` | Omitted | Outer tunnel token, as a string or sync/async provider. |
| `backendBearerToken` | Omitted | Default inner RPC bearer token, as a string or sync/async provider. |
| `authority` | `target`, then `backend` | HTTP/2 authority, independent of destination selection. |
| `scheme` | `http` | HTTP/2 scheme (`http` or `https`); upstream TLS is controlled by the bridge. |
| `interceptors` | Empty | Standard Connect interceptor list for every client on the connection. |
| `retry` | Transparent retries only | Optional configured retries and replay limits; see [retry settings](RETRIES.md#configure-retries). |
| `onStateChange` | Omitted | Lifecycle listener receiving state and optional reason/error. |

Providers may return a string, `undefined`, or a promise of either. Both providers
run before each new physical connection; they are not per-RPC callbacks. For
per-RPC credentials, use a call header or interceptor instead.

## Open a connection

```ts
import { createClient } from "@connectrpc/connect";
import { openBridgeConnection } from "@dunkymole/grpc-bridge";
import { Greeter } from "./gen/greeter_pb.js";

const connection = await openBridgeConnection({
  url: "wss://bridge.example.com/tunnel",
  target: "greeter.internal:443",
  tunnelToken: async () => session.accessToken,
  backendBearerToken: async () => session.backendToken,
  authority: "greeter.internal",
  scheme: "https",
  onStateChange: ({ state, reason }) => console.log(state, reason),
});

const client = createClient(Greeter, connection.transport);
try {
  const reply = await client.sayHello({ name: "Ada" });
  console.log(reply.message);
} finally {
  await connection.close();
}
```

The connection is a long-lived channel: existing typed clients keep working after
its underlying WebSocket/HTTP/2 session is replaced. Token providers are awaited
before every connection attempt, including automatic reconnection. Use providers
when credentials can change. Transparent retries use positive evidence that the
backend did not process the RPC; additional retries require an explicit policy.

The outer tunnel token authenticates the WebSocket. `backendBearerToken` becomes
`authorization: Bearer <token>` inside each gRPC request. The bridge does not
inspect or validate that backend metadata. Pass only credentials intended for the
selected backend.

## Connect interceptors

Use standard Connect interceptors for application metadata, tracing, or logging:

```ts
import type { Interceptor } from "@connectrpc/connect";
import { openBridgeConnection } from "@dunkymole/grpc-bridge";

const requestId: Interceptor = (next) => async (request) => {
  request.header.set("x-request-id", crypto.randomUUID());
  return next(request);
};

const connection = await openBridgeConnection({
  url: "wss://bridge.example.com/tunnel",
  target: "echo-service:50051",
  interceptors: [requestId],
});
```

`createBridgeConnection()`, `openBridgeConnection()`, and
`createSharedBridgeConnection()` accept `interceptors?: readonly Interceptor[]`.
The list is captured when the connection or shared handle is created. Interceptors
apply to all four RPC shapes in Connect order: requests enter the first listed
interceptor first, and responses pass back through the chain in reverse order.
The transport invokes them once per logical RPC; transparent and configured
retries, including connection replacement, happen inside the chain and retain
its request metadata.
Interceptors can wrap request/response messages, inspect headers and trailers,
use call context values, or reject a call. The call signal includes its deadline.
Omitting the list or passing an empty list preserves the existing transport.

The interceptor request URL identifies the logical backend using `scheme`,
`authority` (falling back to `target`, then `backend`), and the RPC path.
Changing interceptor metadata does not change destination selection or the outer
WebSocket handshake. `backendBearerToken` remains an independent default;
an `authorization` header supplied by a call or interceptor takes precedence.
The bridge does not inspect or interpret application metadata. Examples that use
`crypto.randomUUID()` require a secure browser context (HTTPS or localhost), or
Node 24+. Use your application's ID generator if needed.

### Per-client interceptors on a shared connection

Use the public `interceptTransport(transport, options)` helper when metadata belongs
to one generated client. Connection-level interceptors remain available for shared
concerns such as authentication or tracing. For example, a backend serving both
Echo and Orders can share one connection while each client sends its own label.
This example assumes your generated services provide `echo({ text })` and
`getOrder({ id })`; use the methods and messages from your own schemas:

```ts
import { createClient, type Interceptor } from "@connectrpc/connect";
import {
  createSharedBridgeConnection,
  interceptTransport,
} from "@dunkymole/grpc-bridge";
import { EchoService } from "./gen/echo_pb.js";
import { OrdersService } from "./gen/orders_pb.js";

const clientLabel = (name: string): Interceptor => (next) => async (req) => {
  req.header.set("x-client-name", name);
  return next(req);
};
const tracing: Interceptor = (next) => async (req) => {
  req.header.set("x-request-id", crypto.randomUUID());
  return next(req);
};

const shared = createSharedBridgeConnection({
  url: "wss://bridge.example.com/tunnel",
  target: "services:50051",
  interceptors: [tracing],
});
const [echoLease, ordersLease] = await Promise.all([
  shared.acquire(),
  shared.acquire(),
]);
try {
  const echo = createClient(EchoService, interceptTransport(echoLease.transport, {
    baseUrl: "http://services:50051",
    interceptors: [clientLabel("echo-widget")],
  }));
  const orders = createClient(OrdersService, interceptTransport(ordersLease.transport, {
    baseUrl: "http://services:50051",
    interceptors: [clientLabel("orders-dashboard")],
  }));
  const [reply, order] = await Promise.all([
    echo.echo({ text: "hello" }),
    orders.getOrder({ id: "order-123" }),
  ]);
  console.log(reply, order);
  // The calls share one connection and send different x-client-name values.
} finally {
  await Promise.all([echoLease.release(), ordersLease.release()]);
  await shared.dispose();
}
```

The helper accepts a standard Connect `Transport` and `InterceptorOptions` with
`baseUrl: string` and `interceptors?: readonly Interceptor[]`. It captures its
options when created. `baseUrl` supplies the logical URL visible to that client’s
interceptors; use the backend scheme and authority, without the RPC path. It does
not select a destination, open a WebSocket, or modify the wrapped transport.
An omitted or empty interceptor list returns the original transport.

Requests flow through the per-client interceptors in declaration order, then the
connection-level interceptors in declaration order, then connection selection and
retries. Responses unwind in reverse order. All four RPC shapes follow this order.
Both chains run once per logical call, even when a retry replaces the connection;
the final request metadata is retained on every attempt.
An interceptor can itself invoke `next()` more than once; such application-defined
retries are separate from the bridge's built-in retry policy.

Each call starts with a fresh copy of its headers, so concurrent clients and the
original transport do not inherit another client’s changes. For the same header,
the last `header.set()` wins: client interceptors can replace per-call values, and
connection interceptors can replace client values. To provide a shared default
that a client can override, set it only when `req.header.has(name)` is false.
`header.append()` retains the normal `Headers` append behavior. The independent
`backendBearerToken` fallback is applied only when `authorization` remains absent.

For example, this connection-level interceptor provides a default while honoring
a client-specific value. Add `clientName` to a client wrapper's interceptor list,
and `defaults` to the connection's list:

```ts
import type { Interceptor } from "@connectrpc/connect";

const defaults: Interceptor = (next) => async (req) => {
  if (!req.header.has("x-client-name")) {
    req.header.set("x-client-name", "shared-default");
  }
  return next(req);
};
const clientName: Interceptor = (next) => async (req) => {
  req.header.set("x-client-name", "orders-ui");
  return next(req);
};
// The wrapped client sends orders-ui; unwrapped clients send shared-default.
// An unconditional set() in defaults would replace the client's value instead.
```

A wrapper owns no lease and exposes no additional lifecycle. Keep its underlying
connection or lease alive while using it, and stop using it when that lease is
released. Creating a wrapper neither acquires nor releases a lease. Cancellation,
deadlines (including time in both chains), connection recovery, and the last-lease
shutdown retain their existing behavior. Wrap the managed connection or lease’s
transport to keep client interceptors outside its retry layer.

For a runnable example using the repository's generated `DemoService`, see
[`examples/interceptors.ts`](https://github.com/dunkymole/grpc-bridge/blob/main/web/examples/interceptors.ts). With the Compose stack
running, run `npm run example` from `web/`. It creates two clients with distinct
client labels, runs concurrent calls over shared leases, and releases them.
It also shows a client overriding a shared metadata default. The Python demo
echoes messages without interpreting these application headers.

## Explicit connection reuse

One connection already multiplexes many RPCs to one backend. If you own its
lifetime centrally, share `connection.transport` and call `connection.close()`
when finished. For independent consumers, configure a shared handle once:

```ts
import { createClient } from "@connectrpc/connect";
import { createSharedBridgeConnection } from "@dunkymole/grpc-bridge";
import { Greeter } from "./gen/greeter_pb.js";

const shared = createSharedBridgeConnection({
  url: "wss://bridge.example.com/tunnel",
  target: "greeter.internal:443",
  authority: "greeter.internal",
  tunnelToken: () => session.accessToken,
}); // No connection opens yet.

async function greet(name: string) {
  const lease = await shared.acquire(); // First acquisition opens the connection.
  try {
    const client = createClient(Greeter, lease.transport);
    return await client.sayHello({ name });
  } finally {
    await lease.release(); // Last release closes the connection.
  }
}

await Promise.all([greet("Ada"), greet("Grace")]); // Shares one connection.
await shared.dispose(); // Application shutdown or logout; permanently disables it.
```

`SharedBridgeConnection` represents one configured destination and authentication
policy. Pass the same handle into components that should share it. Each service
module can create its own handle using application-supplied configuration; no
central destination registry is required. Separate handles remain independent,
even when their options match. There is no automatic matching of credentials.

`acquire()` takes no options and returns a `BridgeConnectionLease` after initial
establishment. Concurrent acquisitions share that attempt. If it fails, those
acquisitions reject and clean up; a later acquisition can try again. Once
established, active leases retain the same transport across automatic recovery.

`release()` is idempotent. Stop using the lease's transport and unsubscribe its
observers before releasing it. Its `closed` promise refers to the underlying
connection's shutdown, not the release of that individual lease. A later acquisition
after the last release opens a fresh connection. Idle connections are not retained.

`dispose()` is idempotent and permanent: it closes the connection even with active
leases, cancels pending acquisition, stops recovery, and rejects future acquisitions.
On identity changes, dispose the old handle and create a new one. Token providers
can refresh credentials for the same identity on each connection attempt; they
do not replace credentials on an already-open session.

The former `BridgeConnectionPool`, `createBridgeConnectionPool()`, and
`PooledBridgeConnectionOptions` API has been removed. Move options into
`createSharedBridgeConnection(options)`, remove `authenticationContext`, use
`acquire()` without arguments, and replace the owner's `close()` with `dispose()`.
Lease `release()` is unchanged.

## Lifecycle and cleanup

States are `connecting`, `open`, `transient_failure`, and `closed`. Transport loss
enters `transient_failure`, followed by automatic connection attempts with jittered
exponential backoff (1 second initially, multiplied by 1.6, capped at 30 seconds
before ±20% jitter). Successful establishment resets backoff. `closed` is terminal
and means explicit shutdown; `connection.closed` resolves only after shutdown.
Shared leases remain attached to the same channel throughout recovery.

Pass `onStateChange` to observe the complete opening lifecycle.
`connection.subscribe()` immediately reports the current state and returns an
unsubscribe function. Observer exceptions do not interrupt channel management.

`openBridgeConnection()` waits for its first connection attempt and rejects if
that attempt fails, disposing the channel. Use `createBridgeConnection()` instead
to obtain a channel immediately that also recovers from an initial outage:

```ts
import { createClient, createContextValues } from "@connectrpc/connect";
import { createBridgeConnection, waitForReady } from "@dunkymole/grpc-bridge";
import { Greeter } from "./gen/greeter_pb.js";

const connection = createBridgeConnection({
  url: "wss://bridge.example.com/tunnel",
  target: "greeter.internal:443",
});
const client = createClient(Greeter, connection.transport);
try {
  const reply = await client.sayHello(
    { name: "Ada" },
    {
      timeoutMs: 5000,
      contextValues: createContextValues().set(waitForReady, true),
    },
  );
  console.log(reply.message);
} finally {
  await connection.close();
}
```

By default, calls wait during `connecting` but fail with `Unavailable` when the
channel enters `transient_failure`. Per-call `waitForReady` keeps an undispatched
call waiting across failed attempts. Cancellation and the original deadline apply
to both waiting and execution. Streaming inputs are not consumed while waiting.
Set a deadline to bound the wait. Closing the channel rejects waiting calls,
aborts connection establishment, and stops future reconnect attempts.

Always call `connection.close()`, release every shared lease, or dispose the shared
handle. On GOAWAY, new calls move to a replacement connection while accepted RPCs
drain on the old session. Established streams cannot resume after failure.

## RPC retries

Managed connections automatically retry requests proven unsent and allow one
transparent retry for a refused stream. An uncertain socket failure alone is not
enough to replay an RPC. Optional `retry.methods` or `retry.policy` settings enable
configured retries with bounded buffers, backoff, server pushback, and throttling.
Normal response headers or exceeding a replay budget commits the RPC and stops
retries. Cancellation and the original deadline cover every attempt.

See [retry configuration, TypeScript example, and validation](RETRIES.md) for all
settings and exact supported semantics. The low-level `openChannel()` remains a
single session. Hedging, load balancing, and established stream resumption are
not implemented.

## Low-level API

Advanced users can import `openChannel(url, token?, { target?, signal? })`,
`createTunnelTransport(channel, options?)`, `inputQueue()`, and the `grpc-tunnel.v1`
`PROFILE` constant. `createTunnelTransport()` accepts `bearerToken`, `authority`,
and `scheme`; these low-level defaults are `undefined`, `backend`, and `http`.
Unlike the managed API, it does not infer authority from the selected target.
`openChannel()` represents one physical session, with `close()`, `closed`, and
`draining` lifecycle hooks; it does not reconnect or retry. Use `interceptTransport()`
to add interceptors if composing these low-level APIs yourself. Prefer managed
connections for recovery, retry policy, lifecycle reporting, and ownership.

## Compatibility

| Package | Wire profile     | Connect / Protobuf            | Runtime                                                                        |
| ------- | ---------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| `0.1.x` | `grpc-tunnel.v1` | Connect 2.x / Protobuf-ES 2.x | Current Chromium, Firefox, and WebKit with WebSocket and Web Streams; Node 24+ |

The browser matrix describes intended API availability; automated cross-browser
certification is tracked separately. Server push is disabled. Each connection has
a 1 MiB receive queue and sends in 16 KiB chunks.

The package is ESM-only and side-effect free. It ships JavaScript, TypeScript
declarations, declaration maps, source maps with embedded sources, the MIT license,
and third-party notices. On 29 September 2026, bundling all public exports and
runtime dependencies measured 76.7 KiB minified and 24.1 KiB gzip (1 KiB = 1,024
bytes). Run `npm run size` from the source checkout to reproduce this measurement;
its output labels these values as kB. A consuming application's bundle depends on
tree shaking and its own generated messages. Demo UI and generated demo protobuf
code are excluded from the package.

## Examples

- [Browser demo](https://github.com/dunkymole/grpc-bridge/blob/main/web/src/demo.ts): the repository's interactive lab.
- [Typed RPC examples](https://github.com/dunkymole/grpc-bridge/blob/main/web/examples/client.ts): all four RPC shapes, metadata, deadlines, and cancellation.
- [Interceptor example](https://github.com/dunkymole/grpc-bridge/blob/main/web/examples/interceptors.ts): independent client labels and shared defaults.
- [Node runner](https://github.com/dunkymole/grpc-bridge/blob/main/web/examples/run.ts): runs both sets with `npm run example` from the source checkout.

Example sources are maintained in the repository and are not included in the
package tarball. Browser demos require a running bridge; the Node runner uses
`TUNNEL_URL`, `TUNNEL_TOKEN`, `BACKEND_TARGET`, and optional `FORWARD_TUNNEL_TOKEN`.

See the [project repository](https://github.com/dunkymole/grpc-bridge) for the Go
bridge, Python test backend, complete configuration, protocol design, and security
scope.
