# @dunkymole/grpc-bridge

Typed gRPC over a WebSocket tunnel from browsers and Node 24+. The package runs
HTTP/2 in the client, exposes a standard Connect `Transport`, and works with
generated Protobuf-ES service descriptors. The bridge forwards the resulting byte
stream without decoding HTTP/2, gRPC, or protobuf.

The package follows Semantic Versioning. During `0.x`, a minor release can contain
breaking API changes; patch releases remain backward-compatible within that minor.

## Install

The package is not yet published to npm. Build a local tarball with `npm pack`
from this directory and install that `.tgz` in a consuming project. The command
below is the registry installation form for a future published release.

```sh
npm install @dunkymole/grpc-bridge \
  @connectrpc/connect @bufbuild/protobuf
```

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
const reply = await client.sayHello({ name: "Ada" });
console.log(reply.message);

await connection.close();
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

const contractVersion: Interceptor = (next) => async (request) => {
  request.header.set("x-proto-contract", "demo.echo@1.0.0");
  return next(request);
};

const connection = await openBridgeConnection({
  url: "wss://bridge.example.com/tunnel",
  target: "echo-service:50051",
  interceptors: [contractVersion],
});
```

`createBridgeConnection()`, `openBridgeConnection()`, and
`createSharedBridgeConnection()` accept `interceptors?: readonly Interceptor[]`.
The list is captured when the connection or shared handle is created. Interceptors
apply to all four RPC shapes in Connect order: requests enter the first listed
interceptor first, and responses pass back through the chain in reverse order.
They run once per logical RPC; transparent and configured retries, including
connection replacement, happen inside the chain and retain its request metadata.
Interceptors can wrap request/response messages, inspect headers and trailers,
use call context values, or reject a call. The call signal includes its deadline.
Omitting the list or passing an empty list preserves the existing transport.

The interceptor request URL identifies the logical backend using `scheme`,
`authority` (falling back to `target`, then `backend`), and the RPC path.
Changing interceptor metadata does not change destination selection or the outer
WebSocket handshake. `backendBearerToken` remains an independent default;
an `authorization` header supplied by a call or interceptor takes precedence.
The bridge does not inspect application metadata or interpret contract versions.

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

Advanced users can import `openChannel()`, `createTunnelTransport()`, `inputQueue()`,
and the `grpc-tunnel.v1` `PROFILE` constant. `createTunnelTransport()` accepts
`bearerToken`, `authority`, and `scheme`. The managed API is preferred because it
owns cleanup and lifecycle reporting.

## Compatibility

| Package | Wire profile     | Connect / Protobuf            | Runtime                                                                        |
| ------- | ---------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| `0.1.x` | `grpc-tunnel.v1` | Connect 2.x / Protobuf-ES 2.x | Current Chromium, Firefox, and WebKit with WebSocket and Web Streams; Node 24+ |

The browser matrix describes intended API availability; automated cross-browser
certification is tracked separately. Server push is disabled. Each connection has
a 1 MiB receive queue and sends in 16 KiB chunks.

The package is ESM-only and side-effect free. It ships JavaScript, TypeScript
declarations, declaration maps, source maps with embedded sources, the MIT license,
and third-party notices. A production browser bundle including runtime dependencies
is approximately 73.4 kB minified and 23.1 kB gzip. Run `npm run size` to reproduce the bundle
measurement. Demo UI and generated demo protobuf code are excluded.

## Examples

- `src/demo.ts` is the browser example built into the repository's live lab.
- `examples/client.ts` contains all four typed RPC patterns.
- `examples/run.ts` runs those examples under Node 24+.

See the [project repository](https://github.com/dunkymole/grpc-bridge) for the Go
bridge, Python test backend, complete configuration, protocol design, and security
scope.
