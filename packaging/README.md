# Installed-artifact consumer gate

From `web/`, with Node 24+, npm, `tar` and a running Docker engine:

```sh
npm ci
npm run package:verify
npm run package:consumer
```

Use Docker Compose with additional build contexts and `!reset` support (locally
verified with Compose 5.5.1). The runner validates that the fixture publishes no
host ports, creates its own uniquely named Compose project and removes that
project in cleanup. It does not stop the default demo or other projects.

The consumer receives only the audited tarball/manifest, its private fixture,
the demo proto/lock, and a compiler built from reviewed Proto Contract revision
`6d028e3632e7b027f380cbc6b0449dfe4ca4b6c1` (also pinned by reciprocal CI).
Protoc 31.1 and Protobuf-ES 2.15.0 generate fresh descriptors and a strict contract
from the same locked input. TypeScript 5.9.3 compiles against installed package
declarations with NodeNext resolution, no source aliases and no skipLibCheck.

Before `npm ci --ignore-scripts`, the fixture verifies SHA-256 and npm SHA-512
integrity and binds that exact local-file dependency into a copy of its lockfile.
All existing external resolutions/integrities stay locked. Changed runtime
dependency bounds require an explicit fixture update, not a silent registry
resolution. Package lifecycle scripts are not executed during installation.
The fixture is private and contains no publishing command.

Node and pinned Playwright Chromium/Firefox/WebKit each exercise installed public
exports, generated strict construction, unary/trailers, all three streaming
shapes (including a bidi response before input half-close), deadlines and
cancellation. Compile-time negative checks reject a plain contract and access to
raw transport on the strict connection. A browser bundle built from installed
package modules is served by the isolated consumer, not the monorepo demo.

Reports `consumer-node.json` and `consumer-browsers.json` join the audited tarball
and inventory under `web/test-results/package/` and are retained by CI. The Node
report binds the package checksum, version, compiler revision, actual runtime,
checks and fixture browser bundle size. Fixture bundle size includes test code;
it is not a minimal library-size claim. Stale reports are removed before a run,
and missing/partial results fail the command.

The ordinary Python demo backend here does not enforce contract metadata. This
gate proves installed contract-bound clients and live wire interoperability;
the existing reciprocal native/actual-package matrix remains the separate gate
for strict server runtimes. This fixture does not replace that matrix or claim
that every operating system/browser version is supported. No npm publication
occurs; registry ownership, version/tag selection and explicit approval remain
release-time gates.

The [release procedure](../docs/RELEASING.md) adds a read-only preflight, clean
source/toolchain provenance, installed public-entry bundle measurements and an
explicit `PACKAGE_INSTALL_SOURCE=registry` post-publication verification mode.
That mode validates the public registry bytes and uses a registry URL in npm's
lock entry rather than the default local tarball; it is not a publisher.
