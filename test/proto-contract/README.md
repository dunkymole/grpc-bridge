# Pinned Proto Contract fixture adapter

The `proposed-contract-pair` CI job tests this bridge revision against Proto Contract commit `6d028e3632e7b027f380cbc6b0449dfe4ca4b6c1`. That reviewed commit still selects bridge targets by address. The job applies `labels.patch` to its fetched checkout so the existing matrix and rollout tests exercise this revision's label policy without changing the pinned peer source or its RPC assertions.

This patch is temporary. Remove it when the reviewed Proto Contract pin includes equivalent fixture changes.

## Local verification — 20 October 2026

Both peer scripts passed against bridge commit `4136d1596825988744525e702432f4bd5071a7de`, based on current `main` at `042de143905c29fe403965a9a8b218cafa9f6c36`:

- `pwsh ./scripts/test-all.ps1`: all 20 combinations passed, covering Python, Go, Java, .NET, and TypeScript bridge clients against Go, Java, .NET, and Python servers. The actual packed bridge package, generated contract bindings, and negative contract checks also passed during the build.
- `pwsh ./scripts/test-rollout.ps1`: v1.0 → v1.1 → v2.0 routing, pinned tunnel and bidi stream behavior, incompatible contract rejection, and rollback passed.

The run used a disposable checkout of the exact reviewed peer commit with `labels.patch` applied. For local verification, its bridge source-fetch stage was replaced with a BuildKit named context pointing to this bridge working tree, and both Compose files supplied that context. This exercised the local Go binary and locally packed TypeScript package rather than fetching an older published revision. No RPC assertions were changed. Each script removed its test containers and network after completion.
