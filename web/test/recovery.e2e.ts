import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Code,
  ConnectError,
  createClient,
  createContextValues,
} from "@connectrpc/connect";
import { createSharedBridgeConnection, waitForReady } from "../src/index.js";
import { DemoService } from "../src/gen/demo_pb.js";

test(
  "shared leases and existing clients survive a broken WebSocket without replaying streams",
  { timeout: 15000 },
  async () => {
    const NativeWebSocket = globalThis.WebSocket;
    const sockets: WebSocket[] = [];
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
    let shared: ReturnType<typeof createSharedBridgeConnection> | undefined;
    let tokens = 0;
    try {
      const options = {
        url: process.env.TUNNEL_URL ?? "ws://localhost:8080/tunnel",
        tunnelToken: async () => {
          tokens++;
          return process.env.TUNNEL_TOKEN ?? "";
        },
      };
      shared = createSharedBridgeConnection(options);
      const first = await shared.acquire();
      const second = await shared.acquire();
      const client = createClient(DemoService, first.transport);
      const stream = client
        .count({ number: 100, delayMs: 100 })
        [Symbol.asyncIterator]();
      assert.equal((await stream.next()).done, false);
      const failed = assert.rejects(
        stream.next(),
        (e: unknown) =>
          e instanceof ConnectError && e.code === Code.Unavailable,
      );
      sockets[0]!.close();
      await failed;
      const third = await shared.acquire();
      assert.strictEqual(first.transport, third.transport);
      await first.release();
      const reply = await client.echo(
        { text: "same client recovered" },
        {
          timeoutMs: 8000,
          contextValues: createContextValues().set(waitForReady, true),
        },
      );
      assert.equal(reply.text, "same client recovered");
      assert.equal(tokens, 2);
      assert.equal(sockets.length, 2);
      assert.equal(second.state, "open");
      await second.release();
      assert.equal(third.state, "open");
      await third.release();
      await third.closed;
      assert.equal(third.state, "closed");
    } finally {
      await shared?.dispose();
      globalThis.WebSocket = NativeWebSocket;
    }
  },
);
