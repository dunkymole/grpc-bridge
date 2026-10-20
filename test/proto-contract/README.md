# Pinned Proto Contract fixture adapter

The `proposed-contract-pair` CI job tests this bridge revision against Proto Contract commit `6d028e3632e7b027f380cbc6b0449dfe4ca4b6c1`. That reviewed commit still selects bridge targets by address. The job applies `labels.patch` to its fetched checkout so the existing matrix and rollout tests exercise this revision's label policy without changing the pinned peer source or its RPC assertions.

This patch is temporary. Remove it when the reviewed Proto Contract pin includes equivalent fixture changes.
