import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createClient } from "@connectrpc/connect";
import { openChannel } from "../src/channel.js";
import { createTunnelTransport } from "../src/transport.js";
import { DemoService } from "../src/gen/demo_pb.js";

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 20000 }).trim();
test(
  "onboard, remap, and revoke a target label without restarting the bridge",
  { timeout: 60000 },
  async () => {
    const root = new URL("../../", import.meta.url);
    const compose = (...args: string[]) =>
      execFileSync("docker", ["compose", ...args], {
        cwd: root,
        encoding: "utf8",
        timeout: 20000,
      }).trim();
    const bridge = compose("ps", "-q", "bridge");
    const backend = compose("ps", "-q", "backend");
    const network = Object.keys(
      JSON.parse(
        docker(
          "inspect",
          bridge,
          "--format",
          "{{json .NetworkSettings.Networks}}",
        ),
      ),
    )[0];
    const image = docker("inspect", backend, "--format", "{{.Image}}");
    const firstName = `grpc-bridge-onboarding-${process.pid}`;
    const secondName = `grpc-bridge-remap-${process.pid}`;
    const target = `onboard-${process.pid}`;
    const policyFile = new URL("config/targets.json", root);
    const original = await readFile(policyFile, "utf8");
    const url = process.env.TUNNEL_URL ?? "ws://localhost:8080/tunnel";
    const token = process.env.TUNNEL_TOKEN ?? "";
    const existing = await openChannel(url, token);
    let first: Awaited<ReturnType<typeof openChannel>> | undefined;
    let second: Awaited<ReturnType<typeof openChannel>> | undefined;
    const created: string[] = [];
    try {
      const remappedServer = [
        "import asyncio",
        "import server",
        "class Remapped(server.Demo):",
        "    async def Echo(self, request, context):",
        "        response = await super().Echo(request, context)",
        "        response.text = 'remapped:' + response.text",
        "        return response",
        "server.Demo = Remapped",
        "asyncio.run(server.main())",
      ].join("\n");
      for (const name of [firstName, secondName]) {
        docker(
          "run",
          "-d",
          "--name",
          name,
          "--network",
          network,
          image,
          ...(name === secondName ? ["python", "-c", remappedServer] : []),
        );
        created.push(name);
        docker(
          "exec",
          name,
          "python",
          "-c",
          "import grpc; grpc.channel_ready_future(grpc.insecure_channel('localhost:50051')).result(timeout=10)",
        );
      }
      await assert.rejects(openChannel(url, token, { target }));
      const policy = JSON.parse(original);
      policy.targets[target] = { address: `${firstName}:50051`, tls: false };
      await writeFile(policyFile, JSON.stringify(policy));
      first = await openChannel(url, token, { target });
      const firstClient = createClient(
        DemoService,
        createTunnelTransport(first),
      );
      assert.equal(
        (await firstClient.echo({ text: "new backend" })).text,
        "new backend",
      );
      policy.targets[target] = { address: `${secondName}:50051`, tls: false };
      await writeFile(policyFile, JSON.stringify(policy));
      second = await openChannel(url, token, { target });
      const secondClient = createClient(
        DemoService,
        createTunnelTransport(second),
      );
      assert.equal(
        (await secondClient.echo({ text: "remapped backend" })).text,
        "remapped:remapped backend",
      );
      assert.equal(
        (await firstClient.echo({ text: "first tunnel survives remap" })).text,
        "first tunnel survives remap",
      );
      assert.equal(
        compose("ps", "-q", "bridge"),
        bridge,
        "bridge was restarted",
      );
      await writeFile(policyFile, original);
      await assert.rejects(openChannel(url, token, { target }));
      assert.equal(
        (await firstClient.echo({ text: "first tunnel survives revoke" })).text,
        "first tunnel survives revoke",
      );
      assert.equal(
        (await secondClient.echo({ text: "second tunnel survives revoke" }))
          .text,
        "remapped:second tunnel survives revoke",
      );
      assert.equal(
        (
          await createClient(DemoService, createTunnelTransport(existing)).echo(
            { text: "original connection" },
          )
        ).text,
        "original connection",
      );
    } finally {
      await Promise.all([first?.close(), second?.close(), existing.close()]);
      await writeFile(policyFile, original);
      for (const name of created) docker("rm", "-f", name);
    }
  },
);
