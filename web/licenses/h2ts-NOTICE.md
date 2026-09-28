h2ts by Debdatta Basu is used under its MIT license (h2ts-LICENSE-MIT).

Source: https://github.com/debdattabasu/h2ts
Pinned source commit: 3c51e07bf0035c3228af8c72a58072d778cae395
Upstream package version: 0.1.2

gRPC Bridge includes an adapted HTTP/2/HPACK engine. Local changes expose positive
retry evidence, initial HEADERS END_STREAM, and GOAWAY draining; they also close
drained sessions and improve stream admission/cancellation cleanup. Upstream
pool and WebSocket adapters are omitted. The source lives in web/src/h2 in the
gRPC Bridge repository, with its provenance and local change list.
