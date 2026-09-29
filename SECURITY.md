# Security

This is an early prototype. The default Compose deployment is local-only.
Before exposing it beyond loopback, configure TLS, an exact allowed origin,
authentication, upstream network restrictions, and deployment resource limits.

The bridge does not authorize individual RPC methods. Enforce application
authorization in the gRPC service. Browser Origin filtering does not authenticate
native clients. Do not put sensitive production data into the demo service.

The optional static tunnel token grants access to all allowed destinations; it
does not provide per-user or per-method authorization. Alternatively, configure a
fixed external admission service to authorize an opaque credential against the
already statically allowed target. The bridge fails closed on verifier errors,
validates the bounded grant response, caps concurrent tunnels by principal within
one process after admission identifies the subject, and closes tunnels at grant
expiry or the configured maximum tunnel lifetime. The global connection cap also
bounds pending admission requests. Grants do not change destination or TLS policy. The bridge does not
interpret JWT claims or authorize individual RPC methods; enforce those in the
verifier and gRPC service respectively.

Per-principal quotas are process-local and are not coordinated across replicas.
Revoking a credential at its issuer does not instantly terminate existing tunnels;
they remain open until grant expiry or the configured maximum tunnel lifetime.
The reference verifier under `examples/admission` uses a fixed operator-configured
JWKS URL with bounded fetches and cached keys. Cached keys remain usable during a
JWKS outage; keys that are not cached fail closed until a refresh succeeds. It
accepts only RS256 signatures, rejects unsupported critical JOSE headers, and
requires declared JWK purpose metadata to permit signature verification. Key
rotation should overlap old and new public keys for at least the cache refresh
interval and maximum token lifetime. Restrict
the verifier endpoint to the bridge over a private network or authenticated proxy.
See [the admission configuration and protocol](docs/CONFIGURATION.md#external-admission-and-the-reference-verifier).

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
