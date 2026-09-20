# @dunkymole/grpc-bridge

Typed gRPC over a WebSocket tunnel from browsers and Node 24+. The package runs
HTTP/2 in the client, exposes a standard Connect `Transport`, and works with
generated Protobuf-ES service descriptors. The bridge forwards the resulting byte
stream without decoding HTTP/2, gRPC, or protobuf.

The package follows Semantic Versioning. During `0.x`, a minor release can contain
breaking API changes; patch releases remain backward-compatible within that minor.

## Install

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

Token providers are awaited once before each new channel. A provider is called
again only when the application explicitly opens another connection. The package
does not reconnect, retry, resume, or replay RPCs.

The outer tunnel token authenticates the WebSocket. `backendBearerToken` becomes
`authorization: Bearer <token>` inside each gRPC request. The bridge does not
inspect or validate that backend metadata. Pass only credentials intended for the
selected backend.

## Explicit connection reuse

One connection already multiplexes many RPCs to one backend. A pool can explicitly
share that connection between separately created clients:

```ts
import { createClient } from "@connectrpc/connect";
import { createBridgeConnectionPool } from "@dunkymole/grpc-bridge";
import { Greeter } from "./gen/greeter_pb.js";

const pool = createBridgeConnectionPool();
const options = {
  url: "wss://bridge.example.com/tunnel",
  target: "greeter.internal:443",
  authority: "greeter.internal",
  tunnelToken: () => session.accessToken,
  authenticationContext: `user:${session.userId}`,
};

const first = await pool.acquire(options);
const second = await pool.acquire(options);
const firstClient = createClient(Greeter, first.transport);
const secondClient = createClient(Greeter, second.transport);

await first.release();
await second.release(); // Last release closes the channel.
await pool.close();
```

Reuse requires an exact match of bridge URL, target, HTTP/2 authority, scheme, and
`authenticationContext`. The context is a caller-supplied, non-secret identity for
the credential boundary. Never use the same value for callers who must be isolated.
Tokens themselves are deliberately excluded from the pool key and are never logged.
Idle connections are closed rather than cached.

## Lifecycle and cleanup

States are `connecting`, `open`, and `closed`. Pass `onStateChange` to observe the
complete opening lifecycle. `connection.subscribe()` immediately reports the
current state and returns an unsubscribe function. A closed event reports `local`,
`remote`, or `error` where it is known.

Always call `connection.close()`, release every pool lease, or close the pool. A
dropped channel fails active RPCs with a transport error. The application decides
whether an operation is safe to retry.

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
is 63.9 kB minified and 20.2 kB gzip. Run `npm run size` to reproduce the bundle
measurement. Demo UI and generated demo protobuf code are excluded.

## Examples

- `src/demo.ts` is the browser example built into the repository's live lab.
- `examples/client.ts` contains all four typed RPC patterns.
- `examples/run.ts` runs those examples under Node 24+.

See the [project repository](https://github.com/dunkymole/grpc-bridge) for the Go
bridge, Python test backend, complete configuration, protocol design, and security
scope.
