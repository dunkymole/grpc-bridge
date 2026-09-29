# Reference admission verifier

This small service is an optional companion to the bridge. It verifies a signed
access token and returns a short-lived grant for the exact destination the bridge
has already selected from its static allowlist. The bridge itself stays
standard-library-only and does not parse JWTs.

Run the verifier with trusted operator configuration:

```sh
cd examples/admission
JWT_ISSUER=https://issuer.example \
JWT_AUDIENCE=grpc-bridge \
JWKS_URL=https://issuer.example/.well-known/jwks.json \
ADMISSION_LISTEN=127.0.0.1:8081 \
go run .
```

Configure the bridge with `ADMISSION_URL=http://127.0.0.1:8081/v1/admit` for a
same-host development setup, or an HTTPS URL for a remote verifier. Unset
`TUNNEL_TOKEN`; static-token and admission modes cannot be combined. The verifier
is not included in the default Compose stack. Restrict its listener to the bridge
using a private network or an authenticated proxy, and protect the issuer/JWKS
configuration as deployment credentials.

The verifier accepts only RS256 JWTs with the configured exact `iss` and `aud`, a
bounded `sub`, required `nbf` and `exp`, and a `targets` array of up to 128 exact
`host:port` destinations. The requested destination must be present in that
array. It rejects `crit`, `jku`, and `x5u` headers. JWKS keys may omit `use` and
`key_ops`; if present, `use` must be `sig` and `key_ops` must include `verify`.

JWKS is fetched only from the configured URL. Fetches use a two-second timeout,
are capped at 1 MiB, do not follow redirects, refresh every five minutes, and
rate-limit unknown-key refresh. Cached keys remain usable during an outage;
unknown keys fail closed until refresh succeeds. Keep both old and new signing
keys published across the cache refresh interval and token lifetime during
rotation. Revoking a JWT does not close an already-open bridge tunnel immediately;
the bridge closes it at grant expiry or its configured maximum tunnel lifetime.

Run this module's tests with:

```sh
go test ./...
go vet ./...
```
