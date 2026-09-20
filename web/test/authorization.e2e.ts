import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@connectrpc/connect";
import { openChannel } from "../src/channel.js";
import { createTunnelTransport } from "../src/transport.js";
import { DemoService } from "../src/gen/demo_pb.js";
import { runChecks } from "../src/verify.js";

test(
  "optional bearer metadata covers every RPC shape without overriding per-call authorization",
  { timeout: 30000 },
  async () => {
    const connection = await openChannel(
      process.env.TUNNEL_URL ?? "ws://localhost:8080/tunnel",
      process.env.TUNNEL_TOKEN ?? "",
    );
    const originalRequest = connection.request.bind(connection);
    const observed: Array<{
      authorization: string | undefined;
      authority: string | undefined;
      scheme: string | undefined;
    }> = [];
    connection.request = (request) => {
      observed.push({
        authorization: (request.headers as Record<string, string> | undefined)
          ?.authorization,
        authority: request.authority,
        scheme: request.scheme,
      });
      return originalRequest(request);
    };
    try {
      const defaults = createClient(
        DemoService,
        createTunnelTransport(connection),
      );
      await defaults.echo({ text: "no implicit credential" });
      assert.equal(observed.pop()?.authorization, undefined);
      const client = createClient(
        DemoService,
        createTunnelTransport(connection, {
          bearerToken: "test-only-token",
          authority: "demo.internal",
          scheme: "https",
        }),
      );
      await runChecks(client, () => {});
      assert.ok(observed.length >= 4);
      assert.ok(
        observed.every(
          ({ authorization, authority, scheme }) =>
            authorization === "Bearer test-only-token" &&
            authority === "demo.internal" &&
            scheme === "https",
        ),
      );
      await client.echo(
        {},
        { headers: { Authorization: "Bearer per-call-token" } },
      );
      assert.equal(observed.pop()?.authorization, "Bearer per-call-token");
      const empty = createClient(
        DemoService,
        createTunnelTransport(connection, { bearerToken: "" }),
      );
      await empty.echo({});
      assert.equal(observed.pop()?.authorization, undefined);
    } finally {
      connection.close();
    }
  },
);
