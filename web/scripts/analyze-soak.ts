import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resourceTrend } from "./soak-analysis-lib.js";

const paths = process.argv.slice(2);
if (paths.length === 0)
  throw new Error("supply one or more final soak JSON reports");
type Sample = {
  label: string;
  elapsedSeconds: number;
  [key: string]: number | string;
};
const reports: object[] = [];
for (const path of paths) {
  const report = JSON.parse(await readFile(path, "utf8"));
  const samples = report.samples as Sample[];
  const stages = [
    ...new Set(
      samples
        .filter((s) => /^rpc-concurrency-\d+-active$/.test(s.label))
        .map((s) => s.label),
    ),
  ];
  const trends: object[] = [];
  for (const stage of stages) {
    const all = samples.filter((s) => s.label === stage);
    // Discard the first 10% of each fixed-concurrency stage, not samples across
    // ramp boundaries. Do not hide observed growth behind a single peak value.
    const steady = all.slice(Math.floor(all.length * 0.1));
    if (steady.length < 2) continue;
    const fields = [
      "rssBytes",
      "heapAllocBytes",
      "goroutines",
      "cgroupSocketBytes",
      "cgroupKernelBytes",
    ];
    for (const field of fields) {
      const points = steady
        .filter((s) => typeof s[field] === "number")
        .map((s) => ({ seconds: s.elapsedSeconds, value: s[field] as number }));
      if (points.length >= 2)
        trends.push({ stage, field, ...resourceTrend(points) });
    }
  }
  reports.push({
    path,
    startedAt: report.startedAt,
    environment: report.environment,
    config: report.config,
    summary: report.summary,
    failures: report.failures,
    baseline: samples[0],
    recovered: samples.at(-1),
    trends,
  });
}
await mkdir("test-results/load", { recursive: true });
await writeFile(
  "test-results/load/soak-comparison.json",
  JSON.stringify(
    {
      reports,
      interpretation:
        "OLS slopes and quartile means are descriptive, not proof of a leak. Compare repeated same-host/source/configuration runs and account for GC, allocator retention and host contention. No thresholds have been relaxed.",
    },
    null,
    2,
  ),
);
console.log("Wrote test-results/load/soak-comparison.json");
