# HTTP/2 engine provenance

Vendored from `typescript/client/src` in
[debdattabasu/h2ts](https://github.com/debdattabasu/h2ts/tree/3c51e07bf0035c3228af8c72a58072d778cae395/typescript/client/src),
commit `3c51e07bf0035c3228af8c72a58072d778cae395` (package version 0.1.2).
Used under the MIT license; see `web/licenses/h2ts-LICENSE-MIT`.
The upstream pool and WebSocket adapters are omitted; gRPC Bridge owns those layers.

Local changes expose positive retry evidence on stream refusal and unsent requests,
the initial HEADERS END_STREAM flag, and a GOAWAY draining notification. They close
drained sessions, wake/cancel queued stream admissions, and cancel upload reads on
stream failure. Request admission checks connection state again after async waits.
These hooks let the gRPC layer make retry decisions without parsing error strings
or reaching into private HTTP/2 state.

Keep upstream attribution and this change list when updating the engine. The wire
fault tests in `web/test/retry.test.ts` and Python interoperability tests cover its
integration. This is maintained source, not a patch applied to `node_modules`.
