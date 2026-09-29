# @dunkymole/grpc-bridge

Typed gRPC clients over a WebSocket tunnel from browsers and Node 24+. The
bridge forwards bytes without decoding HTTP/2, gRPC, or Protobuf. The default
TypeScript API requires a generated contract artifact before it can create a
client.

## Install

This change is an intentional pre-1.0 breaking release: package version `0.2.0`
makes contract-bound clients the main entry point. Build a local tarball from
`web/` with `npm ci && npm pack`, then install it alongside Connect 2.x and
Protobuf-ES 2.15:

```sh
npm install /path/to/dunkymole-grpc-bridge-0.2.0.tgz @connectrpc/connect@2.2.0 @bufbuild/protobuf@2.15.0
```

Generate Protobuf-ES descriptors and a contract artifact from the same locked
descriptor input with `proto-contract`. The generator validates the complete
lock against that exact input, then emits the runtime graph described in
[`contracts/runtime-graph-v1.md`](contracts/runtime-graph-v1.md). A standalone
generation command must receive validated descriptor input to produce a strict
artifact; a lock file alone is not treated as schema validation. The checked-in
`src/gen/demo_contract.ts` demonstrates the artifact shape for the repository
demo; application code should use the coordinated generator.

## Create a client

```ts
import { openBridgeConnection } from "@dunkymole/grpc-bridge";
import { OrdersContract } from "./gen/orders_contract.js";

const connection = await openBridgeConnection({
  url: "wss://bridge.example.com/tunnel",
  target: "orders.internal:443",
  tunnelToken: async () => session.accessToken,
  backendBearerToken: async () => session.backendToken,
});
const orders = connection.client(OrdersContract);
try {
  const order = await orders.getOrder({ id: "order-123" });
  console.log(order);
} finally {
  await connection.close();
}
```

The inferred client contains only methods from the generated service. The
artifact binds its Protobuf-ES service descriptor, canonical API/version, full
lock fingerprint, and expected runtime graph. Runtime factory registration
rejects plain objects from JavaScript, and a graph mismatch fails during module
initialization. Deliberate `any` or type assertions can bypass TypeScript, so
the runtime still verifies the artifact and each actual method before sending.
This is a safety boundary against accidental API misuse, not a sandbox against
code that deliberately imports `/raw` or tampers with JavaScript internals.

The strict connection and shared lease expose `client(contract)`, lifecycle
state, subscriptions, and close/release operations. They do not expose a raw
Connect `Transport`. Unary, server-streaming, client-streaming, and
bidirectional-streaming methods are inferred from the generated descriptor.

## Interceptors and contract stamping

Connection-level hooks go in `BridgeConnectionOptions.interceptors`. Hooks for
one generated client go in `client(contract, { interceptors })`:

```ts
import type { Interceptor } from "@connectrpc/connect";
import { openBridgeConnection } from "@dunkymole/grpc-bridge";
import { OrdersContract } from "./gen/orders_contract.js";

const trace: Interceptor = (next) => async (request) => {
  request.header.set("x-request-id", crypto.randomUUID());
  return next(request);
};
const clientLabel: Interceptor = (next) => async (request) => {
  request.header.set("x-client-name", "orders-dashboard");
  return next(request);
};
const connection = await openBridgeConnection({
  url: "wss://bridge.example.com/tunnel",
  target: "orders.internal:443",
  interceptors: [trace],
});
const orders = connection.client(OrdersContract, {
  interceptors: [clientLabel],
});
```

Per-client hooks run first, then connection hooks, then the mandatory method
guard and contract stamp, then the retrying transport. Each ordinary hook chain
runs once per logical RPC. The final boundary confirms that the actual method
descriptor belongs to the bound service, copies the final application headers,
and sets `x-proto-contract: API@MAJOR.MINOR.PATCH`. Application hooks cannot
replace the reserved value; the copied headers remain stable if a hook mutates
its own headers after calling `next()`. Retries preserve the stamped value.
The stamp is metadata for compatible server runtimes; the client does not
negotiate versions over the network, and the bridge relay does not inspect it.

## Share a connection

```ts
import { createSharedBridgeConnection } from "@dunkymole/grpc-bridge";
import { OrdersContract } from "./gen/orders_contract.js";

const shared = createSharedBridgeConnection({
  url: "wss://bridge.example.com/tunnel",
  target: "orders.internal:443",
}); // Opens lazily when acquired.

const lease = await shared.acquire();
try {
  const orders = lease.client(OrdersContract);
  console.log(await orders.getOrder({ id: "order-123" }));
} finally {
  await lease.release();
  await shared.dispose();
}
```

Concurrent leases share one connection and retain it through recovery. The last
release closes it; `dispose()` permanently rejects acquisitions and closes any
active leases. Stop using a lease before releasing it. State values are
`connecting`, `open`, `transient_failure`, and `closed`.

`createBridgeConnection()` returns immediately and recovers through initial
outages. `openBridgeConnection()` waits for the first connection attempt and
closes on failure. Both accept `url`, optional `target`, `tunnelToken`,
`backendBearerToken`, `authority`, `scheme`, `interceptors`, `retry`, and
`onStateChange`. Token providers run before each new physical connection. See
[`RETRIES.md`](RETRIES.md) for retry evidence, retry policies, and request
buffer limits.

## Runtime graph and generated artifacts

The versioned runtime projection includes reachable services, methods, fields,
presence/defaults, JSON and JavaScript names, UTF-8 validation, oneofs, scalar,
message, enum, list, and map shapes, and enum alias declaration order. The
runtime freezes the reachable Protobuf-ES descriptor surfaces after graph
validation so a generated client cannot become stale through later descriptor
mutation. The compiler's full lock fingerprint remains on the local artifact;
the runtime graph intentionally covers only descriptor semantics retained by
Protobuf-ES. See the spec and cross-language input/JSON fixture in
[`contracts/`](contracts/runtime-graph-v1.md).

Generated code imports `defineContract` and `RuntimeGraph` from the explicit
`@dunkymole/grpc-bridge/codegen` entry. Do not hand-author this artifact for
application contracts. The generator's full-lock validation and the runtime's
descriptor projection are complementary checks.

## Migration from 0.1.x

The main entry no longer exports `connection.transport`, `createTunnelTransport`,
`interceptTransport`, or generic `createClient` setup. Replace:

```ts
const client = createClient(OrdersService, connection.transport);
```

with a generated contract and:

```ts
const client = connection.client(OrdersContract);
```

Move per-client hooks into `client(OrdersContract, { interceptors })`. Move code
that intentionally manages a generic Connect transport to the explicit
`@dunkymole/grpc-bridge/raw` entry. `/raw` retains the previous connection,
lease, channel, transport, and interceptor helpers; it is an intentional unsafe
escape hatch and does not provide contract validation or mandatory stamping.

## Security and deployment

The default Compose deployment is local-only. Before exposing it beyond loopback,
configure TLS, exact allowed origins, authentication, upstream network
restrictions, and deployment resource limits. Contract metadata does not
authorize methods or authenticate the outer WebSocket; enforce application
authorization in the gRPC service. See [configuration](../docs/CONFIGURATION.md)
and [SECURITY](../SECURITY.md).
