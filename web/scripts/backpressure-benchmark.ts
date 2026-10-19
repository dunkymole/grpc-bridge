import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { create, toBinary } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { openChannel } from "../src/channel.js";
import { createTunnelTransport } from "../src/transport.js";
import { DemoService, MessageSchema } from "../src/gen/demo_pb.js";
import { frame } from "../src/framing.js";
import { parsePrometheus } from "./load-benchmark-lib.js";

const exec = promisify(execFile);
const prefix = `bridge-pressure-${randomUUID().slice(0, 8)}`;
const containers: string[] = [];
const results: object[] = [];
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function docker(...args: string[]) {
  return (await exec("docker", args, { timeout: 60_000 })).stdout.trim();
}
async function launch(name: string, ...args: string[]) {
  const id = await docker("run", "-d", "--name", `${prefix}-${name}`, ...args);
  containers.push(id);
  return id;
}
const blockedBackend = `
const http2=require('node:http2');
const server=http2.createServer({settings:{initialWindowSize:16384}});
server.on('stream',(stream,headers)=>{
  stream.on('error',()=>{});
  if(headers[':path'].endsWith('/Chat')) {
    stream.pause();
    stream.respond({':status':200,'content-type':'application/grpc'});
    return;
  }
  const chunks=[];
  stream.on('data',chunk=>chunks.push(chunk));
  stream.on('end',()=>{
    stream.respond({':status':200,'content-type':'application/grpc'},{waitForTrailers:true});
    stream.on('wantTrailers',()=>stream.sendTrailers({'grpc-status':'0'}));
    stream.end(Buffer.concat(chunks));
  });
});
server.listen(50051,'0.0.0.0',()=>console.log('READY'));
`;
async function main() {
  const bridgeImage = await docker("compose", "images", "-q", "bridge");
  const backendId = await docker("compose", "ps", "-q", "backend");
  assert(bridgeImage && backendId, "start Compose first");
  const network = Object.keys(
    JSON.parse(await docker("inspect", backendId))[0].NetworkSettings.Networks,
  )[0]!;
  const backendName = JSON.parse(
    await docker("inspect", backendId),
  )[0].Name.slice(1) as string;
  for (const mode of ["reader", "writer"] as const) {
    let upstream = backendName;
    if (mode === "writer") {
      upstream = `${prefix}-blocked-backend`;
      const mock = await launch(
        "blocked-backend",
        "--network",
        network,
        "node:24.14.0-alpine",
        "node",
        "-e",
        blockedBackend,
      );
      for (
        let attempt = 0;
        !(await docker("logs", mock)).includes("READY");
        attempt++
      ) {
        assert(attempt < 100);
        await sleep(25);
      }
    }
    const bridge = await launch(
      mode,
      "--network",
      network,
      "-p",
      "127.0.0.1::8080",
      "-e",
      `UPSTREAM=${upstream}:50051`,
      bridgeImage,
    );
    const port = (await docker("port", bridge, "8080/tcp")).split(":").at(-1)!;
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await fetch(`${base}/readyz`)).ok) break;
      } catch {}
      assert(attempt < 100);
      await sleep(25);
    }
    const metrics = async () =>
      parsePrometheus(await fetch(`${base}/metrics`).then((r) => r.text()));
    const channel = await openChannel(`${base.replace("http", "ws")}/tunnel`);
    const client = createClient(DemoService, createTunnelTransport(channel));
    const controller = new AbortController();
    let producedBytes = 0;
    const message =
      mode === "reader"
        ? frame(
            toBinary(
              MessageSchema,
              create(MessageSchema, { text: "x".repeat(900_000) }),
            ),
          )
        : new Uint8Array(16_384);
    let chunks = 0;
    const baseline = await metrics();
    try {
      const response = await channel.request({
        method: "POST",
        path: `/${DemoService.typeName}/Chat`,
        authority: "backend",
        headers: { "content-type": "application/grpc", te: "trailers" },
        signal: controller.signal,
        body: new ReadableStream<Uint8Array>({
          pull(stream) {
            if (chunks++ >= (mode === "reader" ? 4 : 256)) {
              stream.close();
              return;
            }
            producedBytes += message.length;
            stream.enqueue(message);
          },
        }),
      });
      assert.equal(response.status, 200);
      // Never consume this response. The real gRPC backend exhausts the client's
      // 65,535-byte channel stream window; the mock peer exhausts its 16 KiB request
      // receive window by never reading the request. A sibling must still work.
      await sleep(750);
      const full = await metrics();
      const producedAtPause = producedBytes;
      await sleep(250);
      const stable = await metrics();
      if (mode === "reader") {
        const key = 'bridge_bytes_forwarded_total{direction="to_client"}';
        const forwarded = stable.get(key)! - baseline.get(key)!;
        assert(
          forwarded >= 65_535 && forwarded < 80_000,
          `reader did not fill and respect its window: ${forwarded}`,
        );
        assert(
          stable.get(key)! - full.get(key)! < 8_192,
          "unconsumed stream continued receiving unbounded data",
        );
      } else {
        assert.equal(
          producedBytes,
          producedAtPause,
          "producer did not stall on peer stream window",
        );
        assert(
          producedBytes > 0 && producedBytes <= 131_072,
          `writer buffered too far ahead: ${producedBytes}`,
        );
      }
      assert.equal(
        (
          await client.echo(
            { text: "healthy while blocked" },
            { timeoutMs: 2_000 },
          )
        ).text,
        "healthy while blocked",
      );
      controller.abort();
      await response.body.cancel().catch(() => {});
      assert.equal(
        (
          await client.echo(
            { text: "healthy after reset" },
            { timeoutMs: 2_000 },
          )
        ).text,
        "healthy after reset",
      );
      results.push({
        mode,
        producedBytes,
        metrics: Object.fromEntries(stable),
        result: "PASS",
      });
      console.log(`PASS non-consuming ${mode}`);
    } finally {
      controller.abort();
      await channel.close();
    }
    let recovered = await metrics();
    for (
      let attempt = 0;
      recovered.get("bridge_established_tunnels") !== 0;
      attempt++
    ) {
      assert(attempt < 100, "blocked stream tunnel did not clean up");
      await sleep(25);
      recovered = await metrics();
    }
    assert(
      recovered.get("bridge_process_goroutines")! <=
        baseline.get("bridge_process_goroutines")! + 4,
      "blocked stream goroutines did not recover",
    );
    assert(
      recovered.get("bridge_process_heap_alloc_bytes")! <=
        baseline.get("bridge_process_heap_alloc_bytes")! + 8 * 1_048_576,
      "blocked stream heap exceeded recovery budget",
    );
    results.push({ mode, recovered: Object.fromEntries(recovered) });
  }
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
    "test-results/load/backpressure.json",
    JSON.stringify({ results, failure }, null, 2),
  );
  for (const id of containers.reverse())
    await docker("rm", "-f", id).catch(() => {});
}
if (failure) console.error(failure);
