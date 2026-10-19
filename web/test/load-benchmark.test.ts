import { test } from "node:test";
import assert from "node:assert/strict";
import {
  distribution,
  LatencyHistogram,
  envInteger,
  parsePrometheus,
  recoveryFailures,
} from "../scripts/load-benchmark-lib.js";

test("bounded latency histogram preserves counts and bounds percentile error", () => {
  const histogram = new LatencyHistogram();
  assert.equal(histogram.distribution().count, 0);
  for (const value of [0.1, 1.2, 2.3, 3.4]) histogram.observe(value);
  const result = histogram.distribution();
  assert.equal(result.count, 4);
  assert.equal(result.p50Ms, 2);
  assert.equal(result.minMs, 0.1);
  assert.equal(result.maxMs, 3.4);
  histogram.observe(90_000);
  assert.equal(histogram.distribution().p99Ms, 90_000);
  assert.throws(() => histogram.observe(NaN));
  assert.throws(() => histogram.observe(-1));
});

test("benchmark distribution uses nearest-rank percentiles", () => {
  assert.deepEqual(distribution([10, 30, 20, 40]), {
    count: 4,
    minMs: 10,
    p50Ms: 20,
    p95Ms: 40,
    p99Ms: 40,
    maxMs: 40,
    meanMs: 25,
  });
  assert.equal(distribution([]).count, 0);
});

test("Prometheus parser retains labeled and unlabeled series", () => {
  const parsed = parsePrometheus(`# HELP example ignored
bridge_active_tunnels 3
bridge_bytes_forwarded_total{direction="to_client"} 42
invalid
`);
  assert.equal(parsed.get("bridge_active_tunnels"), 3);
  assert.equal(
    parsed.get('bridge_bytes_forwarded_total{direction="to_client"}'),
    42,
  );
});

test("integer environment parsing rejects ambiguous values", () => {
  assert.equal(envInteger(undefined, 8, "COUNT"), 8);
  assert.equal(envInteger("0", 8, "COUNT", 0), 0);
  assert.throws(() => envInteger("1.5", 8, "COUNT"), /COUNT/u);
  assert.throws(() => envInteger("many", 8, "COUNT"), /COUNT/u);
});

test("recovery checks report resource and tunnel regressions", () => {
  const failures = recoveryFailures(
    {
      activeTunnels: 0,
      establishedTunnels: 0,
      goroutines: 10,
      heapAllocBytes: 1_000,
      rssBytes: 10_000,
    },
    {
      activeTunnels: 1,
      establishedTunnels: 1,
      goroutines: 25,
      heapAllocBytes: 5_000,
      rssBytes: 20_000,
    },
    2,
    900,
    {
      maxErrors: 0,
      maxP99Ms: 500,
      maxGoroutineGrowth: 5,
      maxHeapGrowthBytes: 2_000,
      maxRSSGrowthBytes: 5_000,
    },
  );
  assert.equal(failures.length, 6);
  assert.deepEqual(
    recoveryFailures(
      {
        activeTunnels: 0,
        establishedTunnels: 0,
        goroutines: 10,
        heapAllocBytes: 1_000,
      },
      {
        activeTunnels: 0,
        establishedTunnels: 0,
        goroutines: 11,
        heapAllocBytes: 1_100,
      },
      0,
      100,
      {
        maxErrors: 0,
        maxP99Ms: 500,
        maxGoroutineGrowth: 5,
        maxHeapGrowthBytes: 2_000,
        maxRSSGrowthBytes: 5_000,
      },
    ),
    [],
  );
});
