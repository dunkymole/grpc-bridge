# Configuration reference

The bridge currently reads environment variables and command-line flags, plus a
JSON destination policy. It does not read YAML or a unified JSON settings file.
Docker reads `compose.yaml` and passes the configured environment to the bridge.
JWT validation and key discovery are not implemented; tunnel authentication still
uses an optional static shared token.

## Bridge process settings

Flags override environment values. Empty environment values use the default,
except `TUNNEL_TOKEN`, where empty disables authentication. These settings are
read at process startup; changing them requires restarting/recreating the bridge.

| Environment variable | Flag               | Binary default          | Meaning                                                                                                                                                   |
| -------------------- | ------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LISTEN`             | `-listen`          | `127.0.0.1:8080`        | HTTP listener. Image sets `0.0.0.0:8080`; Compose publishes only host loopback.                                                                           |
| `UPSTREAM`           | `-upstream`        | `127.0.0.1:50051`       | Default, implicitly allowed destination. Compose sets `backend:50051`.                                                                                    |
| `TARGETS_FILE`       | `-targets-file`    | empty                   | JSON destination policy path. Compose sets `/config/targets.json`.                                                                                        |
| `ALLOWED_ORIGIN`     | `-origin`          | `http://localhost:8080` | Exact permitted browser Origin, including scheme and port. Native clients may omit Origin.                                                                |
| `TUNNEL_TOKEN`       | none               | empty                   | Optional shared token. Only letters, digits, `_`, and `-` are accepted. Never log or commit it.                                                           |
| none                 | `-max-connections` | `256`                   | Maximum concurrent tunnels, including connection establishment; must be positive.                                                                         |
| `TLS_CERT`           | `-tls-cert`        | empty                   | PEM certificate file enabling HTTPS/WSS.                                                                                                                  |
| `TLS_KEY`            | `-tls-key`         | empty                   | Corresponding PEM private key file. Required when a certificate is supplied.                                                                              |
| `UPSTREAM_TLS`       | `-upstream-tls`    | `false`                 | Environment enables TLS only for literal `true`; verifies default backend certificate and requires `h2` ALPN.                                             |
| `ASSETS`             | `-assets`          | `web/dist`              | Demo asset directory. Image sets `/web`.                                                                                                                  |
| none                 | `-healthcheck`     | `false`                 | Probe `http://127.0.0.1:8080/healthz` with a two-second timeout and exit. This address is fixed; override Docker's check for other ports or direct HTTPS. |
| none                 | `-h`, `-help`      | n/a                     | Print Go flag help.                                                                                                                                       |

The stock Compose file passes only the environment variables shown in its
`environment` section. To customize other settings in containers, add the relevant
environment entry or command flags to Compose. Merely adding an arbitrary name to
`.env` does not pass it into the container. `TUNNEL_TOKEN` is explicitly interpolated
from the shell or `.env`; the shell takes precedence.

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

## Client authentication and forwarding

`openBridgeConnection({ url, target, tunnelToken })` controls the outer tunnel.
An omitted or empty `target` uses the default backend. `tunnelToken` can be a
string or an async provider. It is resolved once for each new connection and is
offered as `auth.<token>` in the WebSocket subprotocol list, never in the URL.

`backendBearerToken` optionally adds
`authorization: Bearer <token>` to each RPC, for every RPC shape. Omitted or empty
values send no default authorization. Explicit per-call `authorization`
metadata takes precedence (header names are case-insensitive). This option can
carry a separate backend credential; it does not change tunnel authentication.

To forward the same token used for tunnel access:

```ts
import { createClient } from "@connectrpc/connect";
import { openBridgeConnection } from "@dunkymole/grpc-bridge";

const connection = await openBridgeConnection({
  url: bridgeUrl,
  target,
  tunnelToken: token,
  backendBearerToken: token,
});
const client = createClient(DemoService, connection.transport);

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

## Example runner environment

| Variable               | Default                      | Meaning                                                          |
| ---------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `TUNNEL_URL`           | `ws://localhost:8080/tunnel` | Public bridge endpoint.                                          |
| `TUNNEL_TOKEN`         | empty                        | Outer tunnel credential.                                         |
| `BACKEND_TARGET`       | `python-demo:50051`          | Backend destination.                                             |
| `FORWARD_TUNNEL_TOKEN` | `false`                      | Literal `true` forwards the tunnel token as RPC bearer metadata. |

These are client settings for `cd web && npm run example`, not bridge settings.

## Runtime and demo deployment settings

- `GOMEMLIMIT=48MiB`: Go runtime soft memory target in Compose, not a hard cap.
- Compose bridge memory limit: `64m`; backend: `192m`. Both have `pids_limit: 128`.
- Both containers run as user/group `65532`, with read-only roots, all capabilities
  dropped, and `no-new-privileges`. Only bridge port 8080 is published on loopback.
- `GRPC_LISTEN`: Python backend listener; binary script default `127.0.0.1:50051`,
  container default `0.0.0.0:50051`.
- Python image sets `PYTHONDONTWRITEBYTECODE=1` and `PYTHONUNBUFFERED=1`.
- Image health checks run every 10 seconds with a three-second Docker timeout.
  `/healthz` tests only the default backend's TCP reachability, with a one-second dial
  timeout. `/metrics` exposes [connection, traffic, failure, and dial metrics](METRICS.md).
  Metrics are always enabled on the same listener, without tunnel-token authentication.

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
| Graceful HTTP shutdown timeout                   | 5 seconds; active tunnels are closed immediately        |
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
