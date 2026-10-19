import { execFile, spawnSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { createClient, type Client } from "@connectrpc/connect";
import { openChannel } from "../src/channel.js";
import { createTunnelTransport } from "../src/transport.js";
import { DemoService } from "../src/gen/demo_pb.js";
import type { H2Connection } from "../src/h2/connection.js";
import {
  distribution,
  LatencyHistogram,
  envInteger,
  parsePrometheus,
  recoveryFailures,
  type RecoverySnapshot,
  type SmokeThresholds,
} from "./load-benchmark-lib.js";

type DemoClient = Client<typeof DemoService>;
type OperationKind = "unary" | "server_stream" | "client_stream" | "bidi";

interface Profile {
  tunnels: number;
  idleTunnels: number;
  concurrency: number;
  durationSeconds: number;
  churnCycles: number;
  largeMessageBytes: number;
  slowConsumerHoldMs: number;
  recoverySeconds: number;
}

interface ResourceSample extends RecoverySnapshot {
  cgroupSocketBytes?: number;
  cgroupKernelBytes?: number;
  label: string;
  elapsedSeconds: number;
  heapInuseBytes: number;
  containerCPUPercent?: number;
  processThreads?: number;
  bytesToBackend: number;
  bytesToClient: number;
}

interface OperationRecord {
  kind: OperationKind;
  durationMs: number;
  error?: string;
}

const smoke: Profile = {
  tunnels: 4,
  idleTunnels: 1,
  concurrency: 8,
  durationSeconds: 5,
  churnCycles: 12,
  largeMessageBytes: 180_000,
  slowConsumerHoldMs: 300,
  recoverySeconds: 10,
};

const soak: Profile = {
  tunnels: 32,
  idleTunnels: 8,
  concurrency: 64,
  durationSeconds: 14_400,
  churnCycles: 2_000,
  largeMessageBytes: 900_000,
  slowConsumerHoldMs: 5_000,
  recoverySeconds: 60,
};

const profileName = process.argv[2] ?? process.env.BENCH_PROFILE ?? "smoke";
if (profileName !== "smoke" && profileName !== "soak") {
  throw new Error("BENCH_PROFILE must be smoke or soak");
}
const defaults = profileName === "smoke" ? smoke : soak;
const config: Profile = {
  tunnels: envInteger(
    process.env.BENCH_TUNNELS,
    defaults.tunnels,
    "BENCH_TUNNELS",
  ),
  idleTunnels: envInteger(
    process.env.BENCH_IDLE_TUNNELS,
    defaults.idleTunnels,
    "BENCH_IDLE_TUNNELS",
    0,
  ),
  concurrency: envInteger(
    process.env.BENCH_CONCURRENCY,
    defaults.concurrency,
    "BENCH_CONCURRENCY",
  ),
  durationSeconds: envInteger(
    process.env.BENCH_DURATION_SECONDS,
    defaults.durationSeconds,
    "BENCH_DURATION_SECONDS",
  ),
  churnCycles: envInteger(
    process.env.BENCH_CHURN_CYCLES,
    defaults.churnCycles,
    "BENCH_CHURN_CYCLES",
    0,
  ),
  largeMessageBytes: envInteger(
    process.env.BENCH_LARGE_MESSAGE_BYTES,
    defaults.largeMessageBytes,
    "BENCH_LARGE_MESSAGE_BYTES",
  ),
  slowConsumerHoldMs: envInteger(
    process.env.BENCH_SLOW_CONSUMER_HOLD_MS,
    defaults.slowConsumerHoldMs,
    "BENCH_SLOW_CONSUMER_HOLD_MS",
  ),
  recoverySeconds: envInteger(
    process.env.BENCH_RECOVERY_SECONDS,
    defaults.recoverySeconds,
    "BENCH_RECOVERY_SECONDS",
  ),
};
if (config.idleTunnels >= config.tunnels) {
  throw new Error("BENCH_IDLE_TUNNELS must be smaller than BENCH_TUNNELS");
}

const thresholds: SmokeThresholds = {
  maxErrors: envInteger(process.env.BENCH_MAX_ERRORS, 0, "BENCH_MAX_ERRORS", 0),
  maxP99Ms: envInteger(process.env.BENCH_MAX_P99_MS, 5_000, "BENCH_MAX_P99_MS"),
  maxGoroutineGrowth: envInteger(
    process.env.BENCH_MAX_GOROUTINE_GROWTH,
    20,
    "BENCH_MAX_GOROUTINE_GROWTH",
    0,
  ),
  maxHeapGrowthBytes: envInteger(
    process.env.BENCH_MAX_HEAP_GROWTH_BYTES,
    8 * 1024 * 1024,
    "BENCH_MAX_HEAP_GROWTH_BYTES",
    0,
  ),
  maxRSSGrowthBytes: envInteger(
    process.env.BENCH_MAX_RSS_GROWTH_BYTES,
    16 * 1024 * 1024,
    "BENCH_MAX_RSS_GROWTH_BYTES",
    0,
  ),
};

const tunnelURL = process.env.TUNNEL_URL ?? "ws://localhost:8080/tunnel";
const metricsURL = process.env.METRICS_URL ?? "http://localhost:8080/metrics";
const target = process.env.BENCH_TARGET;
const token = process.env.TUNNEL_TOKEN ?? "";
const outputPath = resolve(
  process.env.BENCH_OUTPUT ?? `test-results/load/${profileName}.json`,
);
if (!outputPath.endsWith(".json")) {
  throw new Error("BENCH_OUTPUT must end in .json");
}
const samplePath = outputPath.replace(/\.json$/u, ".samples.jsonl");
const operationPath = outputPath.replace(/\.json$/u, ".operations.jsonl");
const startedAt = new Date();
const started = performance.now();
const records: OperationRecord[] = [];
const latencies = new LatencyHistogram();
const shapeLatencies = {
  unary: new LatencyHistogram(),
  server_stream: new LatencyHistogram(),
  client_stream: new LatencyHistogram(),
  bidi: new LatencyHistogram(),
};
let errorCount = 0;
let operationWrite = Promise.resolve();

async function flushOperations(): Promise<void> {
  const batch = records.splice(0);
  if (batch.length > 0) {
    operationWrite = operationWrite.then(() =>
      appendFile(
        operationPath,
        batch.map((record) => JSON.stringify(record)).join("\n") + "\n",
      ),
    );
  }
  await operationWrite;
}

async function recordOperation(record: OperationRecord): Promise<void> {
  if (record.error === undefined) {
    latencies.observe(record.durationMs);
    shapeLatencies[record.kind].observe(record.durationMs);
  } else {
    errorCount++;
  }
  records.push(record);
  if (records.length >= 1_024) await flushOperations();
}
const samples: ResourceSample[] = [];
const channels: H2Connection[] = [];
let workloadStopped = false;
let bridgeContainer = "";
let helperImage = "";
let rssDiagnostic = "";
const execFileAsync = promisify(execFile);

function command(commandName: string, args: readonly string[]): string {
  const result = spawnSync(commandName, args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

async function commandAsync(
  commandName: string,
  args: readonly string[],
): Promise<string> {
  try {
    const result = await execFileAsync(commandName, [...args], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

function requiredMetric(values: Map<string, number>, name: string): number {
  const value = values.get(name);
  if (value === undefined) throw new Error(`metrics response omitted ${name}`);
  return value;
}

async function containerResource(): Promise<{
  cgroupSocketBytes?: number;
  cgroupKernelBytes?: number;
  rssBytes?: number;
  processThreads?: number;
  containerCPUPercent?: number;
}> {
  const resource: {
    cgroupSocketBytes?: number;
    cgroupKernelBytes?: number;
    rssBytes?: number;
    processThreads?: number;
    containerCPUPercent?: number;
  } = {};
  if (bridgeContainer === "") {
    [bridgeContainer, helperImage] = await Promise.all([
      commandAsync("docker", ["compose", "ps", "-q", "bridge"]),
      commandAsync("docker", ["compose", "images", "-q", "backend"]),
    ]);
  }
  if (bridgeContainer === "") {
    rssDiagnostic = "docker compose did not return a bridge container";
    return resource;
  }
  if (helperImage === "") {
    rssDiagnostic = "docker compose did not return a backend helper image";
    return resource;
  }
  const program = `import json
s={x.split(':',1)[0]:x.split(':',1)[1].strip() for x in open('/proc/1/status') if ':' in x}
r={'rssBytes':int(s['VmRSS'].split()[0])*1024,'processThreads':int(s['Threads'])}
try:
    c=dict(line.split() for line in open('/proc/1/root/sys/fs/cgroup/memory.stat'))
    if 'sock' in c: r['cgroupSocketBytes']=int(c['sock'])
    if 'kernel' in c: r['cgroupKernelBytes']=int(c['kernel'])
except OSError: pass
print(json.dumps(r))`;
  const [stats, output] = await Promise.all([
    commandAsync("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.CPUPerc}}",
      bridgeContainer,
    ]),
    commandAsync("docker", [
      "run",
      "--rm",
      "--pid",
      `container:${bridgeContainer}`,
      "--entrypoint",
      "python",
      helperImage,
      "-c",
      program,
    ]),
  ]);
  const cpu = Number(stats.replace("%", ""));
  if (stats !== "" && Number.isFinite(cpu)) resource.containerCPUPercent = cpu;
  if (output === "") {
    rssDiagnostic = "helper container could not read /proc/1/status";
    return resource;
  }
  try {
    return { ...resource, ...(JSON.parse(output) as object) };
  } catch {
    rssDiagnostic = `invalid helper output: ${output.slice(0, 120)}`;
    return resource;
  }
}

async function sample(label: string): Promise<ResourceSample> {
  const response = await fetch(metricsURL, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`metrics returned HTTP ${response.status}`);
  const values = parsePrometheus(await response.text());
  const external = await containerResource();
  const result: ResourceSample = {
    label,
    elapsedSeconds: (performance.now() - started) / 1_000,
    activeTunnels: requiredMetric(values, "bridge_active_tunnels"),
    establishedTunnels: requiredMetric(values, "bridge_established_tunnels"),
    goroutines: requiredMetric(values, "bridge_process_goroutines"),
    heapAllocBytes: requiredMetric(values, "bridge_process_heap_alloc_bytes"),
    heapInuseBytes: requiredMetric(values, "bridge_process_heap_inuse_bytes"),
    bytesToBackend: requiredMetric(
      values,
      'bridge_bytes_forwarded_total{direction="to_backend"}',
    ),
    bytesToClient: requiredMetric(
      values,
      'bridge_bytes_forwarded_total{direction="to_client"}',
    ),
    ...external,
  };
  samples.push(result);
  await appendFile(samplePath, `${JSON.stringify(result)}\n`);
  console.log(
    `${label}: tunnels=${result.establishedTunnels} heap=${formatBytes(result.heapAllocBytes)} rss=${result.rssBytes === undefined ? "n/a" : formatBytes(result.rssBytes)}`,
  );
  return result;
}

async function openClient(): Promise<DemoClient> {
  const channel = await openChannel(tunnelURL, token, { target });
  channels.push(channel);
  return createClient(DemoService, createTunnelTransport(channel));
}

async function closeAll(): Promise<void> {
  const closing = channels.splice(0).map((channel) => channel.close());
  await Promise.allSettled(closing);
}

async function operation(
  client: DemoClient,
  kind: OperationKind,
): Promise<void> {
  switch (kind) {
    case "unary": {
      const response = await client.echo(
        { text: "benchmark", number: 7 },
        { timeoutMs: 10_000 },
      );
      if (response.number !== 7) throw new Error("unary response mismatch");
      return;
    }
    case "server_stream": {
      let total = 0;
      for await (const message of client.count(
        { number: 3, delayMs: 1 },
        { timeoutMs: 10_000 },
      )) {
        total += message.number;
      }
      if (total !== 6) throw new Error("server stream response mismatch");
      return;
    }
    case "client_stream": {
      const response = await client.collect(
        (async function* () {
          yield { number: 1 };
          yield { number: 2 };
          yield { number: 3 };
        })(),
        { timeoutMs: 10_000 },
      );
      if (response.number !== 6)
        throw new Error("client stream response mismatch");
      return;
    }
    case "bidi": {
      let count = 0;
      for await (const message of client.chat(
        (async function* () {
          yield { text: "one" };
          yield { text: "two" };
          yield { text: "three" };
        })(),
        { timeoutMs: 10_000 },
      )) {
        if (!message.text.startsWith("Python received:")) {
          throw new Error("bidi response mismatch");
        }
        count++;
      }
      if (count !== 3) throw new Error("bidi response count mismatch");
    }
  }
}

async function mixedLoad(
  clients: readonly DemoClient[],
  concurrency: number,
  durationSeconds: number,
): Promise<void> {
  const kinds: readonly OperationKind[] = [
    "unary",
    "server_stream",
    "client_stream",
    "bidi",
  ];
  const until = performance.now() + durationSeconds * 1_000;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, worker) => {
      let sequence = worker;
      while (!workloadStopped && performance.now() < until) {
        const kind = kinds[sequence % kinds.length] ?? "unary";
        const client = clients[worker % clients.length];
        if (!client) throw new Error("no workload client");
        const before = performance.now();
        let error: string | undefined;
        try {
          await operation(client, kind);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        await recordOperation({
          kind,
          durationMs: performance.now() - before,
          error,
        });
        if (error !== undefined && errorCount > thresholds.maxErrors) {
          workloadStopped = true;
          throw new Error(`operation error budget exceeded: ${error}`);
        }
        sequence++;
      }
    }),
  );
}

async function exerciseLargeMessage(client: DemoClient): Promise<void> {
  const text = "x".repeat(config.largeMessageBytes);
  const before = performance.now();
  const response = await client.echo({ text }, { timeoutMs: 30_000 });
  if (response.text.length !== text.length)
    throw new Error("large response mismatch");
  await recordOperation({
    kind: "unary",
    durationMs: performance.now() - before,
  });
}

async function exerciseCancellationAndSibling(
  client: DemoClient,
): Promise<void> {
  const controller = new AbortController();
  const pending = client.echo(
    { text: "cancel", delayMs: 2_000 },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 25);
  try {
    await pending;
    throw new Error("canceled call completed successfully");
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
  const sibling = await client.echo(
    { text: "healthy sibling" },
    { timeoutMs: 10_000 },
  );
  if (sibling.text !== "healthy sibling") throw new Error("sibling RPC failed");
}

async function exerciseSlowConsumer(client: DemoClient): Promise<void> {
  const controller = new AbortController();
  const iterator = client
    .count({ number: 1_000, delayMs: 1 }, { signal: controller.signal })
    [Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error("slow-consumer stream ended early");
  await new Promise((resolveDelay) =>
    setTimeout(resolveDelay, config.slowConsumerHoldMs),
  );
  const sibling = await client.echo(
    { text: "slow-consumer sibling" },
    { timeoutMs: 10_000 },
  );
  if (sibling.text !== "slow-consumer sibling") {
    throw new Error("slow-consumer blocked sibling stream");
  }
  controller.abort();
  try {
    await iterator.next();
  } catch {
    // Cancellation is the expected terminal state.
  }
}

async function exerciseSlowProducer(client: DemoClient): Promise<void> {
  // Attach rejection handling immediately: the RPC may fail while we are
  // awaiting the sibling, before we reach the final await.
  const pending = client
    .collect(
      (async function* () {
        yield { number: 1 };
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, config.slowConsumerHoldMs),
        );
        yield { number: 2 };
      })(),
      { timeoutMs: config.slowConsumerHoldMs + 10_000 },
    )
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  try {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    const sibling = await client.echo(
      { text: "slow-producer sibling" },
      { timeoutMs: 10_000 },
    );
    if (sibling.text !== "slow-producer sibling") {
      throw new Error("slow producer blocked sibling stream");
    }
    const collected = await pending;
    if ("error" in collected) throw collected.error;
    if (collected.value.number !== 3)
      throw new Error("slow producer response mismatch");
  } finally {
    await pending;
  }
}

async function churn(): Promise<void> {
  const workers = Math.min(4, Math.max(1, config.churnCycles));
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const cycle = next++;
        if (cycle >= config.churnCycles) return;
        const channel = await openChannel(tunnelURL, token, { target });
        try {
          const client = createClient(
            DemoService,
            createTunnelTransport(channel),
          );
          const response = await client.echo(
            { number: cycle },
            { timeoutMs: 10_000 },
          );
          if (response.number !== cycle)
            throw new Error("churn response mismatch");
        } finally {
          await channel.close();
        }
      }
    }),
  );
}

async function recover(): Promise<ResourceSample> {
  const deadline = performance.now() + config.recoverySeconds * 1_000;
  let result = await sample("recovery-0s");
  while (
    performance.now() < deadline &&
    recoveryFailures(samples[0]!, result, 0, 0, thresholds).length > 0
  ) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    result = await sample("recovery-poll");
  }
  if (performance.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  return sample("recovered");
}

async function sampledLoad(
  clients: readonly DemoClient[],
  concurrency: number,
  durationSeconds: number,
): Promise<void> {
  let finished = false;
  const load = mixedLoad(clients, concurrency, durationSeconds).finally(() => {
    finished = true;
  });
  // Keep a time series during a soak, rather than just a peak sample.
  const monitor = (async () => {
    while (!finished) {
      await sample(`rpc-concurrency-${concurrency}-active`);
      if (!finished) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
      }
    }
  })();
  const outcomes = await Promise.allSettled([load, monitor]);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") throw outcome.reason;
  }
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

function reportMarkdown(result: BenchmarkResult): string {
  const lines = [
    `# gRPC Bridge ${result.profile} benchmark`,
    "",
    `- Started: ${result.startedAt}`,
    `- Revision: \`${result.environment.gitRevision}\``,
    `- Working tree: ${result.environment.gitStatus ? "contains local changes (see JSON gitStatus)" : "clean"}`,
    `- Duration: ${result.elapsedSeconds.toFixed(1)} seconds`,
    `- Operations: ${result.summary.all.count} (${result.summary.errors} errors)`,
    `- Throughput: ${result.summary.operationsPerSecond.toFixed(1)} operations/second`,
    `- Latency p50/p95/p99: ${result.summary.all.p50Ms.toFixed(1)} / ${result.summary.all.p95Ms.toFixed(1)} / ${result.summary.all.p99Ms.toFixed(1)} ms`,
    `- Result: ${result.failures.length === 0 ? "PASS" : "FAIL"}`,
    "",
    "## Operation distributions",
    "",
    "| Shape | Count | Mean ms | p50 ms | p95 ms | p99 ms | Max ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const kind of [
    "unary",
    "server_stream",
    "client_stream",
    "bidi",
  ] as const) {
    const item = result.summary.byKind[kind];
    lines.push(
      `| ${kind} | ${item.count} | ${item.meanMs.toFixed(1)} | ${item.p50Ms.toFixed(1)} | ${item.p95Ms.toFixed(1)} | ${item.p99Ms.toFixed(1)} | ${item.maxMs.toFixed(1)} |`,
    );
  }
  lines.push(
    "",
    "## Resource samples",
    "",
    "| Stage | Tunnels | Goroutines | Heap | RSS | CPU |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const item of result.samples) {
    lines.push(
      `| ${item.label} | ${item.establishedTunnels} | ${item.goroutines} | ${formatBytes(item.heapAllocBytes)} | ${item.rssBytes === undefined ? "n/a" : formatBytes(item.rssBytes)} | ${item.containerCPUPercent === undefined ? "n/a" : `${item.containerCPUPercent.toFixed(1)}%`} |`,
    );
  }
  if (result.failures.length > 0) {
    lines.push("", "## Threshold failures", "");
    for (const failure of result.failures) lines.push(`- ${failure}`);
  }
  if (result.rssDiagnostic !== "") {
    lines.push("", `RSS diagnostic: ${result.rssDiagnostic}`);
  }
  lines.push("");
  return lines.join("\n");
}

interface BenchmarkResult {
  schemaVersion: 2;
  profile: string;
  startedAt: string;
  elapsedSeconds: number;
  environment: {
    gitRevision: string;
    gitStatus: string;
    node: string;
    os: string;
    cpuCount: number;
    cpuModel: string;
    architecture: string;
    hostMemoryBytes: number;
    bridgeImage: string;
    backendImage: string;
    docker: string;
  };
  config: Profile;
  thresholds: SmokeThresholds;
  summary: {
    errors: number;
    operationsPerSecond: number;
    all: ReturnType<typeof distribution>;
    byKind: Record<OperationKind, ReturnType<typeof distribution>>;
  };
  operationFile: string;
  latencyResolutionMs: 1;
  samples: ResourceSample[];
  failures: string[];
  rssDiagnostic: string;
}

async function main(): Promise<void> {
  const gitRevision = command("git", ["rev-parse", "HEAD"]);
  const gitStatus = command("git", ["status", "--short"]);
  if (process.env.BENCH_REQUIRE_CLEAN === "1" && gitStatus !== "") {
    throw new Error("BENCH_REQUIRE_CLEAN requires a clean source checkout");
  }
  console.log(`Starting ${profileName} profile with ${config.tunnels} tunnels`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(samplePath, "");
  await writeFile(operationPath, "");
  const baseline = await sample("baseline");
  const workloadFailures: string[] = [];
  try {
    const clients: DemoClient[] = [];
    const tunnelLevels = [
      1,
      Math.max(1, Math.ceil(config.tunnels / 2)),
      config.tunnels,
    ].filter((value, index, values) => values.indexOf(value) === index);
    for (const level of tunnelLevels) {
      while (clients.length < level) clients.push(await openClient());
      await Promise.all(
        clients.map((client) =>
          client.echo({ text: "ramp" }, { timeoutMs: 10_000 }),
        ),
      );
      await sample(`tunnel-ramp-${level}`);
    }
    const workloadClients = clients.slice(config.idleTunnels);
    const concurrencyLevels = [
      1,
      Math.max(1, Math.ceil(config.concurrency / 4)),
      config.concurrency,
    ].filter((value, index, values) => values.indexOf(value) === index);
    const stageSeconds = config.durationSeconds / concurrencyLevels.length;
    for (const concurrency of concurrencyLevels) {
      const stageOutcomes = await Promise.allSettled(
        [
          sampledLoad(workloadClients, concurrency, stageSeconds),
          concurrency === config.concurrency
            ? exerciseSlowConsumer(workloadClients[0] as DemoClient)
            : Promise.resolve(),
          concurrency === config.concurrency
            ? exerciseCancellationAndSibling(
                workloadClients[1] ?? (workloadClients[0] as DemoClient),
              )
            : Promise.resolve(),
          concurrency === config.concurrency
            ? exerciseLargeMessage(
                workloadClients[2] ?? (workloadClients[0] as DemoClient),
              )
            : Promise.resolve(),
          concurrency === config.concurrency
            ? exerciseSlowProducer(
                workloadClients[3] ?? (workloadClients[0] as DemoClient),
              )
            : Promise.resolve(),
        ].map(async (task) => {
          try {
            await task;
          } catch (error) {
            workloadStopped = true;
            throw error;
          }
        }),
      );
      for (const outcome of stageOutcomes) {
        if (outcome.status === "rejected") throw outcome.reason;
      }
      await sample(`rpc-concurrency-${concurrency}`);
    }
    await closeAll();
    await churn();
  } catch (cause) {
    workloadFailures.push(
      `workload failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    await closeAll();
  }
  let recovered = samples[samples.length - 1] ?? baseline;
  try {
    recovered = await recover();
  } catch (cause) {
    workloadFailures.push(
      `recovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const elapsedSeconds = (performance.now() - started) / 1_000;
  await flushOperations();
  const errors = errorCount;
  const all = latencies.distribution();
  const byKind = Object.fromEntries(
    (["unary", "server_stream", "client_stream", "bidi"] as const).map(
      (kind) => [kind, shapeLatencies[kind].distribution()],
    ),
  ) as Record<OperationKind, ReturnType<typeof distribution>>;
  const failures = recoveryFailures(
    baseline,
    recovered,
    errors,
    all.p99Ms,
    thresholds,
  );
  failures.push(...workloadFailures);
  if (baseline.rssBytes === undefined || recovered.rssBytes === undefined) {
    failures.push(
      "RSS recovery was not measured; resource verification is incomplete",
    );
  }
  for (const [kind, stats] of Object.entries(byKind)) {
    if (stats.count === 0) failures.push(`no successful ${kind} operations`);
  }
  const result: BenchmarkResult = {
    schemaVersion: 2,
    profile: profileName,
    startedAt: startedAt.toISOString(),
    elapsedSeconds,
    environment: {
      gitRevision,
      gitStatus,
      node: process.version,
      os: `${platform()} ${release()}`,
      cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model ?? "unavailable",
      architecture: arch(),
      hostMemoryBytes: totalmem(),
      bridgeImage: command("docker", [
        "inspect",
        "--format",
        "{{.Image}}",
        bridgeContainer,
      ]),
      backendImage: helperImage,
      docker: command("docker", ["version", "--format", "{{.Server.Version}}"]),
    },
    config,
    thresholds,
    summary: {
      errors,
      operationsPerSecond: all.count / config.durationSeconds,
      all,
      byKind,
    },
    operationFile: operationPath,
    latencyResolutionMs: 1,
    samples,
    failures,
    rssDiagnostic,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(
    outputPath.replace(/\.json$/u, ".md"),
    reportMarkdown(result),
  );
  console.log(reportMarkdown(result));
  console.log(`Wrote ${outputPath}`);
  if (failures.length > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  await closeAll();
}
