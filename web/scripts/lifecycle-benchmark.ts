import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createClient, Code, ConnectError } from "@connectrpc/connect";
import { openChannel } from "../src/channel.js";
import { createTunnelTransport } from "../src/transport.js";
import { DemoService } from "../src/gen/demo_pb.js";

const exec = promisify(execFile);
const prefix = `bridge-lifecycle-${randomUUID().slice(0, 8)}`;
const containers: string[] = [];
const results: object[] = [];
const expectedCalls: string[] = [];
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function docker(...args: string[]) {
  return (
    await exec("docker", args, { timeout: 60_000, maxBuffer: 4 << 20 })
  ).stdout.trim();
}
async function launch(name: string, args: string[]) {
  const id = await docker("run", "-d", "--name", `${prefix}-${name}`, ...args);
  containers.push(id);
  return id;
}
async function until(check: () => Promise<boolean>, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error("lifecycle condition did not become true before deadline");
}

// Independent audit records every server invocation before it performs work.
const backendProgram = `
import asyncio,json,os,grpc
from server import Demo
import demo_pb2_grpc as rpc
def audit(context):
    print(json.dumps({'call':dict(context.invocation_metadata()).get('x-case-id')}),flush=True)
class Audited(Demo):
    async def Echo(self,r,c):
        audit(c)
        return await super().Echo(r,c)
    async def Count(self,r,c):
        audit(c)
        async for value in super().Count(r,c): yield value
    async def Collect(self,r,c):
        audit(c)
        return await super().Collect(r,c)
    async def Chat(self,r,c):
        audit(c)
        async for value in super().Chat(r,c): yield value
async def main():
    s=grpc.aio.server()
    rpc.add_DemoServiceServicer_to_server(Audited(),s)
    s.add_insecure_port('0.0.0.0:50051')
    await s.start()
    print('READY',flush=True)
    await s.wait_for_termination()
asyncio.run(main())
`;
const admissionProgram = `
import http.server,json,time
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        r=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if r['credential']=='outage':
            self.send_error(503);return
        ttl=3 if r['credential']=='short' else 120
        body=json.dumps({'version':1,'subject':r['credential'],'target':r['target'],'expires_at':int(time.time())+ttl}).encode()
        self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
print('READY',flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1',8081),Handler).serve_forever()
`;

function header(id: string) {
  expectedCalls.push(id);
  return { headers: { "x-case-id": id }, timeoutMs: 10_000 };
}
async function unavailable(pending: Promise<unknown>) {
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof ConnectError && error.code === Code.Unavailable,
  );
}

async function main() {
  const bridgeImage = await docker("compose", "images", "-q", "bridge");
  const backendImage = await docker("compose", "images", "-q", "backend");
  const existingBackend = await docker("compose", "ps", "-q", "backend");
  assert(
    bridgeImage && backendImage && existingBackend,
    "start the Compose stack first",
  );
  const inspect = JSON.parse(await docker("inspect", existingBackend));
  const network = Object.keys(inspect[0].NetworkSettings.Networks)[0]!;
  const backendName = `${prefix}-backend`;
  const backend = await launch("backend", [
    "--network",
    network,
    backendImage,
    "python",
    "-u",
    "-c",
    backendProgram,
  ]);
  await until(async () => (await docker("logs", backend)).includes("READY"));

  for (const scenario of ["admission", "graceful", "forced"] as const) {
    const started = Date.now();
    const bridge = await launch(scenario, [
      "--network",
      network,
      "-p",
      "127.0.0.1::8080",
      "-e",
      `UPSTREAM=${backendName}:50051`,
      "-e",
      "MAX_CONNECTIONS_PER_PRINCIPAL=2",
      "-e",
      `DRAIN_GRACE_PERIOD=${scenario === "forced" ? "500ms" : "5s"}`,
      ...(scenario === "admission"
        ? ["-e", "ADMISSION_URL=http://127.0.0.1:8081/admit"]
        : []),
      bridgeImage,
    ]);
    const port = (await docker("port", bridge, "8080/tcp")).split(":").at(-1)!;
    const base = `http://127.0.0.1:${port}`;
    const url = `${base.replace("http", "ws")}/tunnel`;
    await until(async () => {
      try {
        return (await fetch(`${base}/readyz`)).ok;
      } catch {
        return false;
      }
    });
    if (scenario === "admission") {
      const verifier = await launch("verifier", [
        "--network",
        `container:${bridge}`,
        backendImage,
        "python",
        "-u",
        "-c",
        admissionProgram,
      ]);
      await until(async () =>
        (await docker("logs", verifier)).includes("READY"),
      );
    }
    const channels = [];
    try {
      const channel = await openChannel(
        url,
        scenario === "admission" ? "healthy" : "",
      );
      channels.push(channel);
      const client = createClient(DemoService, createTunnelTransport(channel));
      const tag = `${scenario}-`;
      // All four shapes are in flight together. Chat is response-header committed
      // before drain/expiry; the backend audit catches any unexpected replay.
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const chat = client
        .chat(
          (async function* () {
            yield { text: "committed" };
            await hold;
            yield { text: "finish" };
          })(),
          header(`${tag}chat`),
        )
        [Symbol.asyncIterator]();
      assert.equal(
        (await chat.next()).value?.text,
        "Python received: committed",
      );
      const echo = client.echo(
        {
          text: "non-idempotent-audit",
          delayMs: scenario === "forced" ? 5_000 : 250,
        },
        header(`${tag}echo`),
      );
      let markCountCommitted!: () => void;
      const countCommitted = new Promise<void>((resolve) => {
        markCountCommitted = resolve;
      });
      const count = (async () => {
        let seen = 0;
        for await (const _ of client.count(
          { number: scenario === "forced" ? 500 : 5, delayMs: 20 },
          header(`${tag}count`),
        )) {
          seen++;
          markCountCommitted();
        }
        return seen;
      })();
      const collect = client.collect(
        (async function* () {
          yield { number: 1 };
          await hold;
          yield { number: 2 };
        })(),
        header(`${tag}collect`),
      );
      // Handle every rejection immediately, including failures before we await it.
      const settled = Promise.allSettled([echo, count, collect]);
      await Promise.race([
        countCommitted,
        count.then(() => {
          throw new Error("count ended before first response");
        }),
      ]);
      await until(async () => {
        const audit = await docker("logs", backend);
        return ["echo", "count", "collect", "chat"].every((shape) =>
          audit.includes(`"call": "${tag}${shape}"`),
        );
      });
      if (scenario === "admission") {
        const second = await openChannel(url, "healthy");
        channels.push(second);
        await assert.rejects(openChannel(url, "healthy"));
        await assert.rejects(openChannel(url, "outage"));
        const expiring = await openChannel(url, "short");
        channels.push(expiring);
        const expiringClient = createClient(
          DemoService,
          createTunnelTransport(expiring),
        );
        const expired = unavailable(
          expiringClient.echo({ delayMs: 5_000 }, header("expired-echo")),
        );
        await expired;
        assert.equal(
          (
            await client.echo(
              { text: "sibling-after-expiry" },
              header("sibling-after-expiry"),
            )
          ).text,
          "sibling-after-expiry",
        );
      } else {
        await docker("kill", "--signal", "TERM", bridge);
        await until(async () => (await fetch(`${base}/readyz`)).status === 503);
        await assert.rejects(openChannel(url));
      }
      release();
      const outcomes = await settled;
      if (scenario === "forced") {
        for (const result of outcomes) {
          // Collect may finish within grace after release. Echo and Count must fail.
          if (result.status === "rejected")
            assert(result.reason instanceof ConnectError);
        }
        assert.equal(outcomes[0]?.status, "rejected");
        assert.equal(outcomes[1]?.status, "rejected");
        try {
          while (!(await chat.next()).done) {}
        } catch (error) {
          assert(error instanceof ConnectError);
        }
      } else {
        for (const result of outcomes)
          assert.equal(result.status, "fulfilled", JSON.stringify(result));
        assert.equal(
          (await chat.next()).value?.text,
          "Python received: finish",
        );
        assert.equal((await chat.next()).done, true);
      }
      await Promise.allSettled(channels.map((entry) => entry.close()));
      if (scenario === "admission") {
        await until(async () =>
          (await fetch(`${base}/metrics`).then((r) => r.text())).includes(
            "bridge_established_tunnels 0\n",
          ),
        );
      } else {
        await until(
          async () =>
            (await docker("inspect", "-f", "{{.State.Running}}", bridge)) ===
            "false",
        );
        assert.equal(
          await docker("inspect", "-f", "{{.State.ExitCode}}", bridge),
          "0",
        );
      }
      results.push({
        scenario,
        elapsedMs: Date.now() - started,
        result: "PASS",
      });
      console.log(`PASS ${scenario}`);
    } finally {
      await Promise.allSettled(channels.map((channel) => channel.close()));
    }
  }
  const calls = (await docker("logs", backend))
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line).call as string);
  for (const id of expectedCalls)
    assert.equal(
      calls.filter((call) => call === id).length,
      1,
      `${id} was lost or replayed`,
    );
  results.push({ backendCalls: calls, expectedCalls, replayAudit: "PASS" });
}

let failure: string | undefined;
try {
  await main();
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await mkdir("test-results/load", { recursive: true });
  await writeFile(
    "test-results/load/lifecycle.json",
    JSON.stringify({ results, failure }, null, 2),
  );
  for (const id of containers.reverse())
    await docker("rm", "-f", id).catch(() => {});
}
if (failure) console.error(failure);
