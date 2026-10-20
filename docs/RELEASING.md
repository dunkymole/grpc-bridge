# Strict TypeScript package release procedure

Green CI prepares evidence; it does **not** authorize publication. The source
candidate is `@dunkymole/grpc-bridge@0.2.0`; neither its version nor a dist-tag is
approved merely by merging this procedure. Obtain explicit owner approval before
`npm publish`, tag movement or release-policy changes. Issue #2 stays open until
ownership, approved publication and registry installation are verified. GitHub's
v0.1.0 prototype and benchmark prereleases are not npm releases.

## Tested support and compatibility

| Component | Tested boundary |
| --- | --- |
| Package | ESM-only exports `.`, `/raw`, `/codegen`; declarations, maps, physical mapped library sources and MIT/third-party notices; no CommonJS or CDN/IIFE distribution |
| Node | Engine floor `>=24`; installed-consumer gate uses Node 24.21.0/Linux; other versions/operating systems need their own validation |
| Browser | Playwright 1.63.0/Linux: Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6; not every Chrome/Safari product or older engine |
| Platform | ES2022-capable browser bundler; native WebSocket, Web Streams, TextEncoder/TextDecoder and AbortController |
| Dependencies | Exact Protobuf-ES runtime 2.15.0 and Connect 2.2.0; wider bounds require deliberate compatibility tests |
| Generation | Protoc 31.1, Protobuf-ES generator 2.15.0, TypeScript 5.9.3; proto/lock/descriptors from the same input |
| Reviewed compiler/adapters | Proto Contract source `6d028e3632e7b027f380cbc6b0449dfe4ca4b6c1`, shared with required reciprocal CI; not every separately published adapter version |
| Wire | `grpc-tunnel.v1`: native HTTP/2 prior-knowledge bytes in a binary WebSocket, not gRPC-Web or session resumption |

Package version, application contract version and tunnel profile version are
independent. `0.2.0` intentionally requires generated contracts on the default
entry; see [migration](../web/README.md#migration-from-01x),
[runtime graph](../web/contracts/runtime-graph-v1.md) and [wire design](DESIGN.md).
Contract metadata does not authenticate a tunnel or enforce server policy by
itself. The artifact fixture's ordinary Python backend does not enforce contracts;
the reciprocal native/actual-package matrix remains the strict-server gate.
Coordinate with [Proto Contract packaging](https://github.com/dunkymole/proto-contract/issues/3)
and [required pair-check policy](https://github.com/dunkymole/grpc-bridge/issues/23).

Connection recovery does not replay RPCs. Before commitment, unsent requests can
select another session; explicit REFUSED_STREAM/GOAWAY exclusion permits one
transparent retry. Unknown post-dispatch socket loss has no transparent replay.
Configured retries require application replay-safe semantics and remain bounded
by commitment/deadline/cancellation/buffer rules. They do not provide exactly-once
execution. Distribution adds no blind replay, resumable sessions, gRPC message
compression or wire negotiation. Read the full [retry contract](../web/RETRIES.md).

## Prepare and inspect one candidate

From a clean, reviewed Git checkout with Node 24+, current npm, `tar`, and
Docker/Compose as described in the [consumer guide](../packaging/README.md):

```sh
cd web
npm ci
PACKAGE_REQUIRE_CLEAN=1 npm run package:verify
npm run package:consumer
npm run package:preflight -- --revision "$(git rev-parse HEAD)"
```

In PowerShell set `$env:PACKAGE_REQUIRE_CLEAN = "1"` before auditing and pass
`--revision (git rev-parse HEAD)` to preflight. Development packing without Git
is allowed, but records unknown provenance and must fail release preflight.
Do not edit reports to bypass that failure.

The audit snapshots Git commit/tree and clean state before/after packing and
records Node/npm/TypeScript plus dependency-lock SHA-256. It checks the actual
archive inventory, maps, source closure, exports and notices. CI requires clean,
matching snapshots. This is recorded evidence, not a signed reproducible-build
or SLSA attestation. The private consumer installs the exact tarball, regenerates
its contract, compiles without source aliases and checks all RPC shapes,
deadlines/cancellation on Node and all three engines. Reports bind to its hash.

`web/test-results/package/` retains the tarball, `package-audit.json`,
`consumer-node.json`, `consumer-browsers.json` and `release-preflight.json` in
`bridge-validation-<run>-<attempt>` CI artifacts. Preflight requires the independently
selected source revision, clean provenance, matching hashes, reviewed compiler,
complete runtime checks and installed-bundle measurements. Its PASS explicitly
is **not publication authorization**. Inspect downloaded evidence using
`--directory <downloaded-package-directory>`.

A representative October 20 local 0.2.0 candidate had 143 files, 180,047 compressed
bytes and 750,884 unpacked bytes. Its complete installed public entry measured
87,685 minified bytes / 27,130 gzip bytes: esbuild 0.28.2, browser ESM/ES2022,
dependencies included, all entry exports preserved, no source map, gzip level 9.
These are observations, not budgets; each candidate's JSON is authoritative for
its exact sizes/hash/tool versions. The fixture bundle separately includes test
code and uses gzip level 6; neither measurement implies compressed HTTP serving.
`npm run size` is a quick workspace measurement, not installed-artifact evidence.

## Owner/access and explicit approval

1. Choose the version and dist-tag deliberately. `0.2.0` / `latest` is a proposal,
   not approval. Changing version, dependencies, code or packaged docs requires
   rebuilding/retesting and approval of the new artifact, not an automatic bump.
2. Use modern npm against explicit `https://registry.npmjs.org`. Sign in locally
   with npm's browser-based login, inspect `npm whoami`, and confirm personal
   scope control or the organization's appropriate package write permission.
   A public 404 proves neither ownership/availability nor absence of a private
   package. Resolve authenticated package/version checks and scope permission
   before uploading.
3. Never paste tokens/OTP codes into chat, command arguments, tracked files or
   CI artifacts. Enter challenges locally. Do not automatically change 2FA,
   create broad/long-lived tokens or configure trusted publishing; a protected
   trusted-publisher workflow requires separate owner setup/approval.
4. Select a successful **main push** CI run after merge. Independently verify its
   source commit and both required jobs (`test` and `Test this bridge revision
   with reviewed Proto Contract`), download its artifact and require preflight
   against that exact revision. Retain the tarball, SHA-256, npm SHA-512 integrity,
   name/version, proposed tag, source/tree, compiler and CI run URL.
5. Present that exact candidate and public access/tag to the owner for fresh
   explicit publication approval. No script in this workflow calls publish.

## Publish only after approval

Publish the **audited tarball**, not a source directory. Disable lifecycle scripts
so changed/missing build hooks cannot replace the tested bytes:

```sh
# STOP: substitute only the owner-approved tarball and tag after approval.
npm publish /absolute/path/to/approved.tgz --ignore-scripts --access public \
  --tag APPROVED_TAG --registry=https://registry.npmjs.org
```

Do not rebuild/repack between approval and upload. If retained CI evidence expires,
rerun the gates and seek approval for the new candidate. On an uncertain upload
outcome, first query the exact version and compare `dist.integrity`; do not
blindly retry, unpublish, overwrite, bump versions or retag. Stop for owner
direction on conflicts/mismatches. This manual path does not claim npm
trusted-publisher provenance.

## Verify npm after an approved publication

Query the approved version and dist-tag from the explicit public registry.
Require the tag to resolve to the approved version and `dist.integrity` to match
the candidate. Preserve an independent copy of the original candidate reports.
Stage copies of the approved tarball and `package-audit.json` under
`web/test-results/package/`; the consumer reads that directory and replaces its
Node/browser working reports. Do not use your sole evidence copy as that working
directory. Then run:

```sh
PACKAGE_INSTALL_SOURCE=registry npm run package:consumer
PACKAGE_INSTALL_SOURCE=registry npm run package:preflight -- --revision APPROVED_SOURCE_SHA
```

In PowerShell set `$env:PACKAGE_INSTALL_SOURCE = "registry"` and restore/remove
that override afterward. This opt-in mode fetches exact public version metadata,
validates name/version/dependencies/integrity and an HTTPS registry.npmjs.org
tarball URL, and binds npm's lock entry to that registry URL/version, **not a
local file or source checkout**. `npm ci` installs under expected integrity and
the same generated Node/browser suite runs. No install scripts/publisher execute.
404, mismatching bytes, unsupported URLs and partial results fail. Default CI
uses local mode and never requires an unpublished registry package.

Keep registry reports alongside original candidate reports. Complete issue #2
only after registry installation and tag/integrity checks succeed, then update
installation/release documentation. Other registries, adapter releases and GitHub
software tags require their own approved decisions.
