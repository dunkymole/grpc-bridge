# Configuration reference

The bridge currently reads environment variables and command-line flags, plus a
JSON destination policy. It does not read YAML or a unified JSON settings file.
Docker reads `compose.yaml` and passes the configured environment to the bridge.
Tunnel authentication can use either a static shared token or a separately
operated admission service; the two modes are mutually exclusive.

## Bridge process settings

Flags override environment values. Empty environment values use the default,
except `TUNNEL_TOKEN`, where empty disables authentication. These settings are
read at process startup; changing them requires restarting/recreating the bridge.

| Environment variable | Flag               | Binary default          | Meaning                                                                                                                                                   |
| -------------------- | ------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LISTEN`             | `-listen`          | `127.0.0.1:8080`        | HTTP listener. Image sets `0.0.0.0:8080`; Compose publishes only host loopback.                                                                           |
| `HEALTH_LISTEN`      | `-health-listen`   | `127.0.0.1:8082`        | Private plaintext HTTP listener for health probes. Keep it on loopback or a private network; it is not published by Compose.                              |
| `DRAIN_GRACE_PERIOD` | `-drain-grace-period` | `30s`                | Maximum time to finish active tunnels after the first shutdown signal; must be nonnegative and at most 10 minutes. A second signal forces immediate closure. |
| `UPSTREAM`           | `-upstream`        | `127.0.0.1:50051`       | Default, implicitly allowed destination. Compose sets `backend:50051`.                                                                                    |
| `TARGETS_FILE`       | `-targets-file`    | empty                   | JSON destination policy path. Compose sets `/config/targets.json`.                                                                                        |
| `ALLOWED_ORIGIN`     | `-origin`          | `http://localhost:8080` | Exact permitted browser Origin, including scheme and port. Native clients may omit Origin.                                                                |
| `TUNNEL_TOKEN`       | none               | empty                   | Optional shared token. Only letters, digits, `_`, and `-` are accepted. Never log or commit it.                                                           |
| none                 | `-max-connections` | `256`                   | Maximum concurrent tunnels, including connection establishment; must be positive.                                                                         |
| `ADMISSION_URL`       | `-admission-url`   | empty                   | Fixed admission endpoint. Must be HTTPS, or HTTP on loopback for local development. Mutually exclusive with `TUNNEL_TOKEN`.                               |
| `MAX_CONNECTIONS_PER_PRINCIPAL` | `-max-connections-per-principal` | `8` | Concurrent tunnel limit per admission subject (or per static/anonymous identity). Process-local, in-flight attempts included. Must be positive. |
| `MAX_ADMISSION_GRANT_LIFETIME` | `-max-grant-lifetime` | `15m` | Maximum lifetime accepted from an admission response; Go duration, positive and at most 24h. |
| `MAX_TUNNEL_LIFETIME` | `-max-tunnel-lifetime` | `1h` | Maximum time any tunnel may remain open, even if its admission grant lasts longer; Go duration, positive and at most 24h. |
| `TLS_CERT`           | `-tls-cert`        | empty                   | PEM certificate file enabling HTTPS/WSS.                                                                                                                  |
| `TLS_KEY`            | `-tls-key`         | empty                   | Corresponding PEM private key file. Required when a certificate is supplied.                                                                              |
| `UPSTREAM_TLS`       | `-upstream-tls`    | `false`                 | Environment enables TLS only for literal `true`; verifies default backend certificate and requires `h2` ALPN.                                             |
| `ASSETS`             | `-assets`          | `web/dist`              | Demo asset directory. Image sets `/web`.                                                                                                                  |
| none                 | `-healthcheck`     | `false`                 | Probe `http://HEALTH_LISTEN/readyz` with a two-second timeout and exit. Uses the configured private health listener, including when the public listener uses TLS. |
| none                 | `-h`, `-help`      | n/a                     | Print Go flag help.                                                                                                                                       |

The stock Compose file passes only the environment variables shown in its
`environment` section. To customize other settings in containers, add the relevant
environment entry or command flags to Compose. Merely adding an arbitrary name to
`.env` does not pass it into the container. `TUNNEL_TOKEN` is explicitly interpolated
from the shell or `.env`; the shell takes precedence.

### External admission and the reference verifier

When `ADMISSION_URL` is set, the bridge still resolves the requested destination
through its static destination policy first. It then posts a bounded JSON request
containing the opaque browser credential and the already-approved `target` to
that fixed URL. HTTPS is required except for loopback development. Redirects are
not followed, requests have a two-second timeout, credentials are limited to 4 KiB,
and responses are limited to 16 KiB. The request and successful response are:

```json
{"version":1,"credential":"<opaque bearer credential>","target":"service.internal:443"}
```

```json
{"version":1,"subject":"user-123","target":"service.internal:443","expires_at":1790000000}
```

The bridge requires exactly one JSON object with `version: 1`, a bounded `subject`,
the exact same `target`, and a future Unix-second `expires_at` within
`MAX_ADMISSION_GRANT_LIFETIME`. Malformed, stale, mismatched, or unavailable
verifier responses fail closed. The bridge never takes a destination or TLS policy
from the grant.

The browser sends its credential as the `auth.<credential>` WebSocket subprotocol
beside `grpc-tunnel.v1`. A successful bridge handshake selects only
`grpc-tunnel.v1`, so the credential is not echoed. Do not enable HTTP between
different hosts: the credential is a bearer secret. The bridge does not parse
the credential or impose application claim semantics.

`examples/admission` is a separately deployed reference verifier. It accepts an
RS256 JWT with required `iss`, `aud`, `sub`, `nbf`, and `exp` claims and a bounded
`targets` string array. The requested destination must match a target exactly.
The verifier loads keys only from its configured JWKS URL; token-provided `jku`
and `x5u` URLs and unsupported `crit` headers are rejected. JWKS keys with a
declared `use` must say `sig`; declared `key_ops` must include `verify`. Its JWKS
client uses a two-second timeout, a 1 MiB response limit, no redirects, five-minute
refresh, and a rate-limited unknown-key refresh. Previously cached keys remain
usable during a JWKS outage; keys not already in that cache fail closed until
refresh succeeds. Operators should keep old and new signing keys published through
the rotation window and monitor verifier availability. This is an example service; deploy it behind an appropriately
restricted private network or authenticated proxy and supply issuer, audience,
and JWKS URL from trusted operator configuration.

The global cap bounds admission requests. After a successful grant identifies a
subject, the per-principal in-memory counter covers dialing and active tunnels and
is released on every handler exit. It is local to one bridge process, is not shared
across replicas, and does not provide a fleet-wide quota. Existing grants are not
revoked immediately when a JWT is revoked or removed from the issuer; an open
tunnel closes at the earlier of grant expiry and `MAX_TUNNEL_LIFETIME`.

## Destination policy (live)

```json
{
  "targets": {
    "python-demo:50051": { "tls": false },
    "service.internal:443": { "tls": true }
  }
}
```

- `targets`: map of exact client-selectable `host:port` addresses. IPv6 addresses
  use brackets, for example `[::1]:50051`.
- `tls`: boolean, default `false` if omitted. When true, verifies the backend
  certificate/hostname and requires HTTP/2 ALPN. The client cannot override it.

The bridge rereads the file for each new non-default destination selection.
Unknown fields, malformed JSON, or files larger than 64 KiB are rejected. Use
atomic file replacement to avoid partially written snapshots. Compose mounts
`./config` as `/config:ro`, allowing host-side updates without redeployment.
Removing a destination blocks new connections but does not close existing ones.
`UPSTREAM` remains implicitly allowed independently of this file.

## TypeScript connection options

`createBridgeConnection()`, `openBridgeConnection()`, and
`createSharedBridgeConnection()` accept the same `BridgeConnectionOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | Required | Public `ws://` or `wss://` tunnel endpoint. |
| `target` | Omitted | Exact backend `host:port`; omission uses the bridge's default upstream. |
| `tunnelToken` | Omitted | Static string or sync/async provider for the outer tunnel credential. |
| `backendBearerToken` | Omitted | Static string or sync/async provider for default inner RPC authorization. |
| `authority` | `target`, then `backend` | HTTP/2 `:authority`; does not change the TCP destination. |
| `scheme` | `http` | HTTP/2 `:scheme`, either `http` or `https`; does not enable upstream TLS. |
| `interceptors` | Empty | Readonly list of standard Connect interceptors, once per logical RPC. |
| `retry` | Transparent retries only | Optional policies, replay budgets, and throttling; see the [retry reference](../web/RETRIES.md#configure-retries). |
| `onStateChange` | Omitted | Listener for `connecting`, `open`, `transient_failure`, and `closed`, with optional reason/error. |

Token providers are resolved before each new physical connection, not before each
RPC. Use a per-call or interceptor header for credentials that must change on
every RPC. A shared handle captures its configuration when constructed; create a
new handle for a new destination or identity. See the
[lifecycle and cleanup guide](../web/README.md#lifecycle-and-cleanup).

For client-specific behavior, pass `interceptors` to
`connection.client(contract, { interceptors })`. The contract is a generated
`ContractDefinition` that binds the service descriptor, API identity, version,
and schema fingerprint. Client interceptors run before connection-level
interceptors and the final contract guard; later `header.set()` calls take
precedence before the guard replaces the reserved contract header. Both chains
remain outside retries. See the [examples and precedence rules](../web/README.md#connect-interceptors).

## Client authentication and forwarding

`openBridgeConnection({ url, target, tunnelToken })` controls the outer tunnel.
An omitted or empty `target` uses the default backend. `tunnelToken` can be a
string or an async provider. It is resolved before each transport connection
attempt, including automatic reconnection, and is
offered as `auth.<token>` in the WebSocket subprotocol list, never in the URL.

`backendBearerToken` optionally adds
`authorization: Bearer <token>` to each RPC, for every RPC shape. Omitted or empty
values send no default authorization. An `authorization` header left by a call or
interceptor takes precedence (header names are case-insensitive). This option can
carry a separate backend credential; it does not change tunnel authentication.

To forward the same token used for tunnel access:

```ts
import { openBridgeConnection } from "@dunkymole/grpc-bridge";
import { contract as DemoContract } from "./gen/demo_contract.js";

// Supply the public URL, allowed target, and current token from your application.
const connection = await openBridgeConnection({
  url: bridgeUrl,
  target,
  tunnelToken: token,
  backendBearerToken: token,
});
const client = connection.client(DemoContract);

try {
  await client.echo({ text: "hello" });
} finally {
  await connection.close();
}
```

The reusable example offers the same choice:

```ts
const { client, close } = await connectDemo(
  bridgeUrl,
  token,
  "python-demo:50051",
  { forwardToken: true },
);
```

Forwarding defaults to **off**. The browser demo's checkbox applies when connecting;
reconnect after changing it or the token. Forward only to trusted backends: a
shared tunnel token also grants bridge access. Use WSS and backend TLS when those
network legs are not trusted. The bridge does not inspect, inject, or validate RPC
authorization metadata. The demo Python service does not enforce authentication.
Forwarding a JWT as backend metadata does not add JWT verification to the bridge.

## Client recovery and RPC retry settings

Managed client channels automatically reconnect with a 1-second initial delay,
a 1.6 multiplier, a 30-second cap, and ±20% jitter applied after the cap. These
backoff values are fixed. `waitForReady` is a per-RPC Connect context option, off
by default; RPC `timeoutMs` and `signal` cover both waiting and execution.
See the [client recovery guide](../web/README.md#lifecycle-and-cleanup).

RPC retry settings are separate from connection backoff. `BridgeConnectionOptions.retry`
accepts `policy`, `methods`, `perRpcBufferBytes`, `bufferBytes`, and `throttling`.
The [complete retry settings table and example](../web/RETRIES.md#configure-retries)
document their defaults and constraints. These are client options, not bridge
environment variables; the Go relay does not decode RPCs or implement retries.

## Example runner environment

| Variable               | Default                      | Meaning                                                          |
| ---------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `TUNNEL_URL`           | `ws://localhost:8080/tunnel` | Public bridge endpoint.                                          |
| `TUNNEL_TOKEN`         | empty                        | Outer tunnel credential.                                         |
| `BACKEND_TARGET`       | `python-demo:50051`          | Backend destination.                                             |
| `FORWARD_TUNNEL_TOKEN` | `false`                      | Literal `true` forwards the tunnel token as RPC bearer metadata. |

These are client settings for `cd web && npm run example`, not bridge settings.
The runner executes the RPC examples and then the independent-client interceptor
example. `FORWARD_TUNNEL_TOKEN` applies to the RPC examples; the interceptor example
uses the outer tunnel credential but sends only its own non-authentication metadata.

## Runtime and demo deployment settings

- `GOMEMLIMIT=48MiB`: Go runtime soft memory target in Compose, not a hard cap.
- Compose bridge memory limit: `64m`; backend: `192m`. Both have `pids_limit: 128`.
- Both containers run as user/group `65532`, with read-only roots, all capabilities
  dropped, and `no-new-privileges`. Only bridge port 8080 is published on loopback.
- `GRPC_LISTEN`: Python backend listener; binary script default `127.0.0.1:50051`,
  container default `0.0.0.0:50051`.
- Python image sets `PYTHONDONTWRITEBYTECODE=1` and `PYTHONUNBUFFERED=1`.
- Image health checks run every 10 seconds with a three-second Docker timeout.
  `-healthcheck` probes private `/readyz`; `/livez` stays successful during drain,
  while `/readyz` returns 503 after shutdown begins. Public HTTP/TLS also serves these
  endpoints. `/healthz` tests only the default backend's TCP reachability, with a
  one-second dial timeout. `/metrics` exposes [connection, traffic, failure, dial,
  and drain metrics](METRICS.md). Metrics are always enabled on the public listener,
  without tunnel-token authentication. The private health listener defaults to port
  8082, separate from the reference admission service's default port 8081.

Go also supports its standard runtime environment variables; the project only
sets `GOMEMLIMIT`. These do not replace container memory limits.

## Fixed implementation limits (not configurable)

| Limit                                            | Value                                                   |
| ------------------------------------------------ | ------------------------------------------------------- |
| Relay payload buffers                            | Two 16 KiB buffers per tunnel                           |
| Maximum WebSocket frame payload                  | 1 MiB                                                   |
| Backend dial/TLS establishment timeout           | 5 seconds                                               |
| WebSocket ping interval / pong read deadline     | 20 / 60 seconds                                         |
| Relay write deadline                             | 30 seconds                                              |
| WebSocket upgrade response write deadline        | 10 seconds                                              |
| HTTP header read / idle timeout                  | 5 / 30 seconds                                          |
| HTTP `MaxHeaderBytes` setting                    | 8,192 bytes (Go server adds internal parsing allowance) |
| Graceful tunnel drain                            | 30 seconds by default; configurable up to 10 minutes    |
| Final HTTP server shutdown                       | 5 seconds after a graceful tunnel drain                 |
| Destination string / policy file limit           | 320 bytes / 64 KiB                                      |
| Browser handshake / stalled send timeout         | 5 / 30 seconds                                          |
| Browser receive queue / outgoing chunk           | 1 MiB / 16 KiB                                          |
| Browser send buffering threshold                 | Wait while `bufferedAmount` exceeds 64 KiB              |
| Client HTTP/2 stream / connection receive window | 65,535 / 262,144 bytes                                  |
| Client gRPC message limit                        | 1 MiB                                                   |
| Demo backend send / receive message limit        | 1 MiB each                                              |
| Demo backend concurrent HTTP/2 streams           | 64 per connection                                       |

The client defaults HTTP/2 `:authority` to the selected target, or `backend` when
the default destination is used. It defaults `:scheme` to `http`. Set `authority`
and `scheme` in `openBridgeConnection()` when upstream virtual hosting needs other
values. These are HTTP/2 metadata; upstream TLS remains a bridge policy choice.
