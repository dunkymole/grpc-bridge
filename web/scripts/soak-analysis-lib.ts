export function resourceTrend(
  points: readonly { seconds: number; value: number }[],
) {
  if (points.length < 2)
    throw new Error("a trend requires at least two samples");
  if (
    points.some((p) => !Number.isFinite(p.seconds) || !Number.isFinite(p.value))
  )
    throw new Error("trend samples must be finite");
  const mean = (values: number[]) =>
    values.reduce((a, b) => a + b, 0) / values.length;
  const x = mean(points.map((p) => p.seconds));
  const y = mean(points.map((p) => p.value));
  const variance = points.reduce((sum, p) => sum + (p.seconds - x) ** 2, 0);
  if (variance === 0) throw new Error("trend samples require distinct times");
  const covariance = points.reduce(
    (sum, p) => sum + (p.seconds - x) * (p.value - y),
    0,
  );
  const quarter = Math.max(1, Math.floor(points.length / 4));
  return {
    count: points.length,
    spanSeconds: points.at(-1)!.seconds - points[0]!.seconds,
    slopePerHour: (covariance / variance) * 3600,
    firstQuarterMean: mean(points.slice(0, quarter).map((p) => p.value)),
    lastQuarterMean: mean(points.slice(-quarter).map((p) => p.value)),
    min: Math.min(...points.map((p) => p.value)),
    max: Math.max(...points.map((p) => p.value)),
  };
}
