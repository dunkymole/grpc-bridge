# Design: native gRPC for the browser

## Mission and invariants

Enable full-duplex, typed gRPC in browsers while retaining real HTTP/2 semantics.
The only connection protocol this project defines is a thin tunnel profile.
The bridge must remain application-blind and memory-bounded: it never sees
service descriptors, decodes protobufs, parses HTTP/2, or remaps stream IDs.

## Layering

1. `.proto` describes all four RPC shapes. Standard generators produce Python
   server stubs and Protobuf-ES TypeScript service/message descriptors.
2. Connect's typed client calls our transport adapter. The adapter owns gRPC
   records, deadlines, cancellation, metadata, and status validation.
3. The vendored h2ts engine implements browser HTTP/2 and HPACK. It provides stream IDs,
   DATA/HEADERS/trailers, flow-control windows, RST_STREAM, PING, and GOAWAY.
4. Our bounded WebSocket adapter carries that byte stream over one channel.
5. The Go bridge removes/adds WebSocket framing and relays opaque bytes over one
   selected TCP or verified TLS connection to the backend.

HTTP/2 DATA frames and WebSocket messages are not gRPC message boundaries.
Fragments can divide any HTTP/2 or gRPC header or payload.

## Tunnel Channel Protocol v1

The WebSocket HTTP upgrade performs all channel negotiation; there is no second
JSON handshake or custom per-RPC framing.

- Endpoint: `GET /tunnel`, RFC 6455 version 13.
- Required selected subprotocol: `grpc-tunnel.v1`. Unknown profiles fail before
  upgrade. The literal profile binds v1 to opaque HTTP/2 prior-knowledge bytes.
- Optional credential: an additional offered protocol `auth.<base64url-safe-token>`.
  Only the profile is selected/echoed. Constant-time credential comparison.
- Browser Origin must exactly match the configured scheme/host/port; missing
  Origin is permitted for native clients. Never use Origin as authentication.
- The client selects `host:port` through the outer `target` query parameter.
  A bounded JSON allowlist is reread for each non-default selection. The bridge
  resolves the allowed address and connects before sending 101. Missing targets
  use `UPSTREAM`. See [routing](CLIENT-AND-ROUTING.md). Dial
  failure returns 502; connection capacity returns 503; authentication returns
  401; invalid framing/profile returns 400; denied origin returns 403.
- After upgrade, binary and continuation payloads form a continuous byte stream.
  Text frames, extensions/RSV bits, unmasked clients, malformed controls, invalid
  close payloads, and oversized frames terminate the channel.
- Every frame is capped at 1 MiB, and payloads are relayed in 16 KiB chunks.
  Fragmented messages need no aggregate buffer. A later invalid fragment may
  terminate a connection after earlier bytes were forwarded.
- WebSocket ping is sent every 20 seconds. A matching pong renews a 60-second
  read deadline. Browser WebSocket implementations answer pings automatically.
  Upstream writes and downstream writes have 30-second deadlines. Backend EOF
  closes the channel with 1011, even if the backend had already sent GOAWAY.
- WebSocket controls are never forwarded to TCP. Inner HTTP/2 PING frames are
  preserved without inspection. gRPC deadlines remain endpoint-owned.

State: `connecting → open → closed`. Establishment has a 5-second bound. There is
no wire-level resume operation. Fatal transport failure closes both legs and
fails active RPCs; retry is an explicit application choice.

## Memory and flow control

The Go data path has no message queues. Backpressure is socket-write blocking,
with fixed buffers and finite write deadlines. At most 256 tunnels are admitted
by default, independent of the number of RPCs inside them. OS socket buffers and
Go runtime memory are additional to the 32 KiB relay payload buffers.

The browser advertises 65,535 bytes per stream and a 262,144-byte connection
receive window. The WebSocket adapter caps its receive queue at 1 MiB, and drains
outgoing `bufferedAmount` before sending more 16 KiB chunks. Violating the receive
bound closes the connection rather than dropping arbitrary inner bytes. gRPC
records are decoded incrementally with a 1 MiB message cap.

The awaitable producer interface bounds accepted input, provided the caller
awaits each send. Application-created arrays, outstanding promises, and retained
response objects are outside the transport's memory ownership. The browser's
native WebSocket implementation also has implementation-owned buffers.

## RPC behavior

- The same session multiplexes all RPC shapes.
- Finishing request input closes HTTP/2's request direction, not the socket.
- Cancellation aborts one HTTP/2 stream; sibling RPCs remain usable.
- A local deadline sends cancellation and reports DEADLINE_EXCEEDED. A native
  `grpc-timeout` header also communicates the deadline to Python.
- Successful HTTP status without `grpc-status` is UNKNOWN, never success.
- Protobuf response records may be split across any number of DATA frames.
- Native error status and text are preserved. Response trailers are available
  through Connect's `onTrailer` callback.
- No retry or replay is performed, including after response headers arrive.

## Security and deployment

The demo binds the published port to loopback and does not publish Python's port.
WSS can terminate in the Go standard-library HTTPS server using mounted PEM
files. Backend TLS verifies its certificate against the bundled trust store and
requires h2 ALPN. h2c is a trusted-network deployment choice, not end-to-end TLS.

One connection selects one backend. Horizontal scaling distributes tunnels,
not individual RPCs inside a tunnel. Affinity exists for the connection lifetime.
Application session persistence and logical units of work belong in backend
services; the bridge has no replay log or shared session database.

## Deliberate prototype limits

The HTTP/2 dependency is pinned and exercised against Python gRPC; this is not a
complete independent HTTP/2/security audit. Compression, binary metadata
ergonomics, rich status details, interception support, nuanced HTTP→gRPC error
mapping, exhaustive HTTP/2 conformance, and high-concurrency browser memory
testing remain hardening work. Consume or cancel all returned streams.

Managed client channels handle GOAWAY draining, transparent retries, and optional
configured retries. [The retry contract](../web/RETRIES.md) documents commitment,
replay budgets, configuration, and fault-injection/native-client comparisons.

The relay has explicit limits and tests, but a handwritten RFC 6455 parser needs
an external conformance suite and sustained fuzzing before internet deployment.
The initial health probe verifies TCP reachability rather than gRPC service health.

## References

- [RFC 6455: WebSocket](https://www.rfc-editor.org/rfc/rfc6455)
- [RFC 9113: HTTP/2](https://www.rfc-editor.org/rfc/rfc9113)
- [gRPC over HTTP/2 protocol](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md)
- [Connect TypeScript](https://github.com/connectrpc/connect-es)
- [Protobuf-ES](https://github.com/bufbuild/protobuf-es)
- [h2ts](https://github.com/debdattabasu/h2ts)
