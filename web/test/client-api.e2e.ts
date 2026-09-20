import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@connectrpc/connect";
import {
  createBridgeConnectionPool,
  openBridgeConnection,
  type BridgeConnectionEvent,
} from "../src/index.js";
import { DemoService } from "../src/gen/demo_pb.js";

const url = process.env.TUNNEL_URL ?? "ws://localhost:8080/tunnel";
const token = process.env.TUNNEL_TOKEN ?? "";

test(
  "managed connection resolves providers and reports lifecycle without replay",
  { timeout: 10000 },
  async () => {
    let tunnelProviderCalls = 0;
    let backendProviderCalls = 0;
    const events: BridgeConnectionEvent[] = [];
    const connection = await openBridgeConnection({
      url,
      tunnelToken: async () => {
        tunnelProviderCalls++;
        return token;
      },
      backendBearerToken: async () => {
        backendProviderCalls++;
        return "backend-test-token";
      },
      authority: "demo.internal",
      onStateChange: (event) => events.push(event),
    });
    assert.equal(connection.state, "open");
    assert.deepEqual(
      events.map((event) => event.state),
      ["connecting", "open"],
    );
    assert.equal(
      (
        await createClient(DemoService, connection.transport).echo({
          text: "managed",
        })
      ).text,
      "managed",
    );
    assert.equal(tunnelProviderCalls, 1);
    assert.equal(backendProviderCalls, 1);
    await connection.close();
    assert.equal(connection.state, "closed");
    assert.deepEqual(
      events.map((event) => event.state),
      ["connecting", "open", "closed"],
    );
    assert.equal(events.at(-1)?.reason, "local");
  },
);

test(
  "pool reuses only an explicitly matching route and authentication context",
  { timeout: 10000 },
  async () => {
    const pool = createBridgeConnectionPool();
    let providerCalls = 0;
    const options = {
      url,
      tunnelToken: async () => {
        providerCalls++;
        return token;
      },
      target: "python-demo:50051",
      authority: "python-demo",
      authenticationContext: "integration-user",
    } as const;
    const first = await pool.acquire(options);
    const second = await pool.acquire(options);
    assert.strictEqual(first.transport, second.transport);
    assert.equal(providerCalls, 1);
    await first.release();
    assert.equal(second.state, "open");
    assert.equal(
      (
        await createClient(DemoService, second.transport).echo({
          text: "shared",
        })
      ).text,
      "shared",
    );
    await second.release();
    await second.closed;
    assert.equal(second.state, "closed");

    const isolated = await pool.acquire({
      ...options,
      authenticationContext: "another-user",
    });
    assert.notStrictEqual(isolated.transport, first.transport);
    assert.equal(providerCalls, 2);
    await isolated.release();
    await pool.close();
  },
);

test(
  "opening failure reports a closed error transition",
  { skip: !token, timeout: 10000 },
  async () => {
    const events: BridgeConnectionEvent[] = [];
    await assert.rejects(
      openBridgeConnection({
        url,
        tunnelToken: "wrong-token",
        onStateChange: (event) => events.push(event),
      }),
    );
    assert.deepEqual(
      events.map((event) => event.state),
      ["connecting", "closed"],
    );
    assert.equal(events[1]?.reason, "error");
  },
);
