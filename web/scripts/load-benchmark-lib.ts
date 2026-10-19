export interface Distribution {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

// One-millisecond buckets bound the driver's memory during multi-hour runs.
// The final bucket reports the observed maximum for latencies over 60 seconds.
export class LatencyHistogram {
  private readonly buckets = new Float64Array(60_001);
  private count = 0;
  private sum = 0;
  private minimum = Infinity;
  private maximum = 0;

  observe(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error("latency must be finite and nonnegative");
    }
    this.buckets[Math.min(60_000, Math.ceil(milliseconds))]++;
    this.count++;
    this.sum += milliseconds;
    this.minimum = Math.min(this.minimum, milliseconds);
    this.maximum = Math.max(this.maximum, milliseconds);
  }

  distribution(): Distribution {
    if (this.count === 0) return distribution([]);
    const rank = (fraction: number): number => {
      const target = Math.ceil(this.count * fraction);
      let accumulated = 0;
      for (let index = 0; index < this.buckets.length; index++) {
        accumulated += this.buckets[index]!;
        if (accumulated >= target) {
          return index === 60_000
            ? this.maximum
            : Math.min(index, this.maximum);
        }
      }
      return this.maximum;
    };
    return {
      count: this.count,
      minMs: this.minimum,
      maxMs: this.maximum,
      meanMs: this.sum / this.count,
      p50Ms: rank(0.5),
      p95Ms: rank(0.95),
      p99Ms: rank(0.99),
    };
  }
}

export interface RecoverySnapshot {
  activeTunnels: number;
  establishedTunnels: number;
  goroutines: number;
  heapAllocBytes: number;
  rssBytes?: number;
}

export interface SmokeThresholds {
  maxErrors: number;
  maxP99Ms: number;
  maxGoroutineGrowth: number;
  maxHeapGrowthBytes: number;
  maxRSSGrowthBytes: number;
}

export function percentile(
  sorted: readonly number[],
  fraction: number,
): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) {
    return {
      count: 0,
      minMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      meanMs: 0,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs: values.reduce((total, value) => total + value, 0) / values.length,
  };
}

export function parsePrometheus(text: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of text.split(/\r?\n/u)) {
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.lastIndexOf(" ");
    if (separator < 1) continue;
    const value = Number(line.slice(separator + 1));
    if (Number.isFinite(value)) values.set(line.slice(0, separator), value);
  }
  return values;
}

export function envInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum = 1,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

export function recoveryFailures(
  baseline: RecoverySnapshot,
  recovered: RecoverySnapshot,
  errors: number,
  p99Ms: number,
  thresholds: SmokeThresholds,
): string[] {
  const failures: string[] = [];
  if (errors > thresholds.maxErrors) {
    failures.push(`operation errors ${errors} > ${thresholds.maxErrors}`);
  }
  if (p99Ms > thresholds.maxP99Ms) {
    failures.push(
      `operation p99 ${p99Ms.toFixed(1)}ms > ${thresholds.maxP99Ms}ms`,
    );
  }
  if (recovered.activeTunnels !== 0 || recovered.establishedTunnels !== 0) {
    failures.push(
      `tunnels did not recover to zero (active=${recovered.activeTunnels}, established=${recovered.establishedTunnels})`,
    );
  }
  const goroutineGrowth = recovered.goroutines - baseline.goroutines;
  if (goroutineGrowth > thresholds.maxGoroutineGrowth) {
    failures.push(
      `goroutine growth ${goroutineGrowth} > ${thresholds.maxGoroutineGrowth}`,
    );
  }
  const heapGrowth = recovered.heapAllocBytes - baseline.heapAllocBytes;
  if (heapGrowth > thresholds.maxHeapGrowthBytes) {
    failures.push(
      `heap growth ${heapGrowth} > ${thresholds.maxHeapGrowthBytes} bytes`,
    );
  }
  if (baseline.rssBytes !== undefined && recovered.rssBytes !== undefined) {
    const rssGrowth = recovered.rssBytes - baseline.rssBytes;
    if (rssGrowth > thresholds.maxRSSGrowthBytes) {
      failures.push(
        `RSS growth ${rssGrowth} > ${thresholds.maxRSSGrowthBytes} bytes`,
      );
    }
  }
  return failures;
}
