# Contributing

Issues and pull requests are welcome. Start with the [README](README.md) and
[architecture](docs/DESIGN.md).

Documentation must be self-contained and describe the project's behavior,
architecture, and operation for readers with no prior context.

Keep the bridge standard-library-only and application-blind. It must not parse
HTTP/2, gRPC, or protobuf, or allocate a full buffer based on an untrusted frame
length. New RPC semantics belong in the browser transport or backend.

Run `go test ./...`, `go vet ./...`, and the web build/unit suite. For transport
changes also run the Compose interoperability suite and the browser's checks.
Use `gofmt` for Go. Keep generated code synchronized with `proto/demo.proto`.
Include a focused regression test for a protocol bug and explain what changed.

Every change to `main` must arrive through a pull request. The repository requires
the `test` and `Test this bridge revision with reviewed Proto Contract` checks to
pass against the latest `main`, requires resolved conversations and linear
history, and does not allow administrator bypasses, force-pushes, or branch
deletion. Use a squash or rebase merge rather than a merge commit. These rules
serialize changes without requiring a second maintainer's approval: a stale pull
request must be updated and revalidated before it can merge. The CI workflow also
supports `merge_group`, so the same checks can be retained if a merge queue is
enabled later.

Preserve the [retry contract](web/RETRIES.md): transparent retries require positive
transport evidence, and additional RPC retries require an explicit client policy.
Do not replay committed calls or resume established streams after a disconnect.
Keep application interceptors outside retry attempts and preserve their metadata.
Discuss wire-profile changes before implementation; incompatible changes require
a new profile name. Contributions are made under the repository's MIT license.

Be respectful, specific, and constructive. Critique code and ideas, not people.
