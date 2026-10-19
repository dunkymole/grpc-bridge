import { test } from "node:test";
import assert from "node:assert/strict";
import { resourceTrend } from "../scripts/soak-analysis-lib.js";
test("resource trend distinguishes flat and growing constant-load series", () => {
  const points = Array.from({ length: 10 }, (_, n) => ({
    seconds: n * 360,
    value: n + 100,
  }));
  assert.equal(resourceTrend(points).slopePerHour, 10);
  assert.equal(
    resourceTrend(points.map((p) => ({ ...p, value: 100 }))).slopePerHour,
    0,
  );
  assert(
    resourceTrend(points).lastQuarterMean >
      resourceTrend(points).firstQuarterMean,
  );
  assert.throws(() => resourceTrend([]));
  assert.throws(() =>
    resourceTrend([
      { seconds: 1, value: 1 },
      { seconds: 1, value: 2 },
    ]),
  );
  assert.throws(() =>
    resourceTrend([
      { seconds: 1, value: NaN },
      { seconds: 2, value: 2 },
    ]),
  );
});
