import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@connectrpc/connect";
import {
  createSharedBridgeConnection,
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
  "shared handle opens lazily, shares concurrent leases, and reopens after last release",
  { timeout: 10000 },
  async () => {
    let providerCalls = 0;
    const options = {
      url,
      tunnelToken: async () => {
        providerCalls++;
        return token;
      },
      target: "python-demo:50051",
      authority: "python-demo",
    } as const;
    const shared = createSharedBridgeConnection(options);
    assert.equal(providerCalls, 0);
    const [first, second] = await Promise.all([
      shared.acquire(),
      shared.acquire(),
    ]);
    assert.strictEqual(first.transport, second.transport);
    assert.equal(providerCalls, 1);
    const other = createSharedBridgeConnection(options);
    const otherLease = await other.acquire();
    assert.notStrictEqual(first.transport, otherLease.transport);
    await other.dispose();
    assert.equal(first.state, "open");
    assert.equal(providerCalls, 2);
    await first.release();
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

    const isolated = await shared.acquire();
    assert.notStrictEqual(isolated.transport, first.transport);
    assert.equal(providerCalls, 3);
    await shared.dispose();
    assert.equal(isolated.state, "closed");
    await isolated.release();
    await shared.dispose();
    await assert.rejects(shared.acquire(), /disposed/);
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
      ["connecting", "transient_failure", "closed"],
    );
    assert.equal(events[1]?.reason, "error");
  },
);
