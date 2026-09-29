# Retry and connection recovery contract

Managed connections created with `createBridgeConnection()`, `openBridgeConnection()`,
or `createSharedBridgeConnection()` implement transparent retries and optional
configured retries. The Go bridge remains an opaque byte relay. Retry state,
buffering, and policy live in the TypeScript client.

## Connection recovery versus RPC retry

An underlying WebSocket failure starts connection recovery with exponential
backoff. Existing typed clients and shared leases retain their logical connection.
Recovery alone does not replay an RPC. A failed attempt can be retried only under
the rules below, within the original call's deadline and cancellation signal.

On HTTP/2 GOAWAY, the client immediately opens a replacement connection for new
calls. Streams accepted by the old backend connection continue on that connection;
it closes after they finish. Explicit `close()` also closes draining connections.
Repeated GOAWAY frames may exclude additional streams through `lastStreamId`.

## Transparent retries

These are enabled even without a retry policy:

| Transport evidence | Behavior before commitment |
| --- | --- |
| Request was not dispatched because the selected session was closed or draining | Retry without consuming a configured attempt |
| Peer sends `RST_STREAM REFUSED_STREAM`, or GOAWAY excludes the stream ID | One transparent retry per logical RPC |
| Socket disappears after dispatch, with no evidence that the backend refused the RPC | No transparent retry |

Transparent retries do not set or increment `grpc-previous-rpc-attempts`.
Further failures can still qualify for an explicitly configured retry policy.
Use a deadline to bound connectivity waits and repeated unsent attempts.

## Configure retries

Configure retries for operations whose application semantics permit replay.
An `Unavailable` failure can occur after the backend performed a side effect.
Retries do not provide exactly-once execution; use application idempotency keys
when needed.

```ts
import { Code, createClient } from "@connectrpc/connect";
import { createBridgeConnection } from "@dunkymole/grpc-bridge";
import { Greeter } from "./gen/greeter_pb.js";

const connection = createBridgeConnection({
  url: "wss://bridge.example.com/tunnel",
  target: "greeter.internal:443",
  retry: {
    methods: {
      "/helloworld.Greeter/SayHello": {
        maxAttempts: 3,
        initialBackoffMs: 100,
        maxBackoffMs: 1000,
        backoffMultiplier: 2,
        retryableStatusCodes: [Code.Unavailable],
      },
    },
    perRpcBufferBytes: 256 * 1024,
    bufferBytes: 4 * 1024 * 1024,
    throttling: { maxTokens: 10, tokenRatio: 0.1 },
  },
});
const client = createClient(Greeter, connection.transport);
try {
  console.log(await client.sayHello({ name: "Ada" }, { timeoutMs: 5000 }));
} finally {
  await connection.close();
}
```

Method keys must match the protobuf service's full name and wire method name.
All option values use milliseconds or bytes, not service-config duration strings.

| `retry` option | Default | Meaning |
| --- | --- | --- |
| `policy` | Absent | Default configured policy for every method |
| `methods` | Empty | Exact `/package.Service/Method` overrides; `false` disables configured retries for that method |
| `perRpcBufferBytes` | 262144 | Maximum retained serialized request bytes for one logical RPC, including five-byte message prefixes |
| `bufferBytes` | 4194304 | Maximum aggregate retained request bytes across this logical connection |
| `throttling` | Absent | Optional shared retry token budget for this connection |

| Policy field | Constraint | Meaning |
| --- | --- | --- |
| `maxAttempts` | Integer 2–5 | Original attempt plus configured attempts; transparent attempts are excluded |
| `initialBackoffMs` | Positive finite number | Initial delay, with ±20% jitter |
| `maxBackoffMs` | Finite, at least initial delay | Cap applied before jitter |
| `backoffMultiplier` | Positive finite number | Multiplier after each ordinary backoff |
| `retryableStatusCodes` | Nonempty list of non-OK `Code` values | Statuses eligible before commitment |

Both buffer sizes must be nonnegative safe integers. Invalid policy, buffer, or
throttle values throw `TypeError` when a managed connection is created (on first
acquisition for a shared handle).

`throttling.maxTokens` and `throttling.tokenRatio` must be positive and finite.
The bucket starts full. A matching failure subtracts one token; a successful RPC
adds `tokenRatio`, up to `maxTokens`. Configured retries stop when tokens are at or
below half the maximum. Transparent retries do not consume this bucket.
Each logical connection owns its budget; independent connections to the same
backend do not share throttle state. Shared leases do share it.

## Commitment, streaming, and server controls

Normal initial response headers commit the RPC, even before the first response
message. After commitment, errors reach the caller and the RPC is never replayed.
A trailers-only error response can qualify for retry. Receiving any response
message therefore rules out retry; established streams never resume.

All four RPC shapes use the same pre-commit rules. Outgoing messages are serialized
and retained within the budgets above. A retry replays those snapshots and then
continues the original input iterator. The input producer is never restarted.
Exceeding either budget commits the call, releases retained snapshots, and lets the
current attempt continue without retries. Setting a budget to zero prevents
retaining request messages. These budgets bound replay storage, not total browser
memory or the caller's own request objects.

`grpc-retry-pushback-ms` in a retryable error response overrides backoff. A
nonnegative integer specifies the delay and resets exponential backoff. A negative,
malformed, or repeated value prevents retry. The call deadline still bounds that
delay. Configured attempts send `grpc-previous-rpc-attempts: 1`, then `2`, and so on;
the client owns this metadata and replaces any caller-supplied value.

Connection-level and per-client Connect interceptor chains run once per logical
RPC, outside the retry layer. Headers they produce are copied to each attempt;
the retry layer still owns `grpc-previous-rpc-attempts`, and attempt deadlines can
reduce `grpc-timeout`. Backend bearer-token providers run on connection creation,
so a replacement session can supply a refreshed default credential when no
explicit `authorization` header was provided. See the
[interceptor guide](README.md#connect-interceptors).

The original deadline covers interceptors, connection selection, all attempts,
and retry delays.
Cancellation and explicit connection shutdown stop pending retries. A retried call
waits for connectivity; a fresh call still follows its `waitForReady` setting.
Always consume or cancel response iterators and release/close their owning connection.

## Validation and scope

`npm test` runs `test/retry.test.ts` against a real Node HTTP/2 server. It injects
REFUSED_STREAM, GOAWAY, trailers-only statuses, regular headers followed by errors,
pushback, and abrupt socket failures. Assertions cover attempt counts, metadata,
connection replacement and draining, deadlines, cancellation, streaming input
replay, pending input reads, buffer limits and release, and retry throttling.

Five scenarios also run through the pinned native `@grpc/grpc-js` client and compare
final status, attempt count, and previous-attempt metadata: refused streams,
configured retries, negative pushback, commitment, and an abrupt TCP disconnect.
This is evidence for those behaviors, not certification against every native
implementation or the entire gRPC specification. `grpc-js` is a development-only
test dependency. Container tests separately exercise the WebSocket relay with a
Python gRPC backend and authentication on and off.

The behavior follows [gRFC A6](https://github.com/grpc/proposal/blob/master/A6-client-retries.md)
and [HTTP/2 GOAWAY semantics](https://www.rfc-editor.org/rfc/rfc9113.html#section-6.8).
This API does not parse resolver-provided gRPC service-config JSON. Hedging,
load balancing, cross-connection throttle sharing, compression, and resuming
established streams are not implemented. The low-level `openChannel()` and
`createTunnelTransport()` APIs represent one attempt/session and do not manage retries.
