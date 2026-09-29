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

The receive path enforces each advertised stream window and the connection window
on the full DATA payload, including a Pad Length byte and padding. Padding and
discarded DATA return connection credit promptly; application bytes return credit
as the body is read. Defaults bound unread response data to 1 MiB per stream and
64 MiB across the connection. Decoded response header lists are limited to 64 KiB
and 256 fields while HPACK continues through the complete block to preserve the
connection compression table. A rejected field list resets its stream; malformed
HPACK remains a connection error. The compressed header block remains capped at
1 MiB.

Keep upstream attribution and this change list when updating the engine. The wire
fault tests in `web/test/retry.test.ts` and Python interoperability tests cover its
integration. This is maintained source, not a patch applied to `node_modules`.
