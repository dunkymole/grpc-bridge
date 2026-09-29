# Security

This is an early prototype. The default Compose deployment is local-only.
Before exposing it beyond loopback, configure TLS, an exact allowed origin,
authentication, upstream network restrictions, and deployment resource limits.

The bridge does not authorize individual RPC methods. Enforce application
authorization in the gRPC service. Browser Origin filtering does not authenticate
native clients. Do not put sensitive production data into the demo service.

The optional static tunnel token grants access to all allowed destinations; it
does not provide per-user or per-method authorization. Destination policy changes
apply to new tunnels, not existing ones. JWT validation and token expiry checks
are not implemented in the bridge.

Backend bearer tokens and interceptor headers are ordinary inner RPC metadata.
They do not authenticate the outer WebSocket or change its destination. Use
credentials intended for the selected backend and enforce them in that service.
TLS for the browser-to-bridge and bridge-to-backend legs is configured separately;
setting client `scheme: "https"` alone does not enable backend TLS.

`/healthz`, `/metrics`, and demo assets are not protected by `TUNNEL_TOKEN`.
Restrict access through the deployment's network or reverse proxy when exposing
the listener. See [configuration](docs/CONFIGURATION.md) and
[metrics access](docs/METRICS.md#example-queries).

For potential vulnerabilities, avoid posting credentials, exploit targets, or
private data in public issues. Use GitHub's private vulnerability reporting
facility if enabled on this repository. If it is unavailable, open a public issue
requesting a private contact channel without disclosing the vulnerability.

No production support or response-time commitment is currently offered.
