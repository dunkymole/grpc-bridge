# Roadmap

## v0.1 — working reference prototype

- [x] Standard-library-only Go bridge and scratch image.
- [x] Separate Python gRPC service container.
- [x] Standard generated Protobuf types and Connect typed facade.
- [x] All four RPC shapes, real duplex, multiplexing, trailers, half-close.
- [x] Cancellation, deadlines, connection loss, explicit reconnect.
- [x] Versioned channel profile, optional auth, origin checks, fixed memory buffers.
- [x] Repeatable unit, fuzz, and Python interoperability tests.

- [x] Runnable TypeScript examples and client-selected, live-allowlisted destinations.
- [x] Versioned TypeScript package with lifecycle events, token providers, and explicit connection reuse.

## v0.2 — protocol hardening

- Run Autobahn WebSocket conformance tests and retain regression cases.
- Extend independent HTTP/2 conformance testing: HPACK, malformed peers,
  GOAWAY, RST_STREAM codes, slow consumers, and many concurrent streams.
- Harden iterator cancellation when user-provided input waits indefinitely.
- Implement detailed HTTP fallback status mapping and typed binary metadata.
- Exercise upstream TLS, WSS, certificate rotation, and endpoint liveness policy
  across several backend implementations.
- Add long-running heap/latency/throughput benchmarks and realistic connection churn.

## v0.3 — reusable library and community release

- Establish browser support matrix and headless browser CI.
- Add a .NET backend interoperability fixture.
- Add scoped identity integration and deployment examples.
- Obtain independent protocol/security review; define a stable wire-profile policy.

Compression, transparent resumption, per-RPC routing in the bridge, and a bespoke
RPC code generator are not prerequisites. Changes must preserve the opaque relay.
