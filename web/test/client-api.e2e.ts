import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, type Interceptor } from "@connectrpc/connect";
import {
  createSharedBridgeConnection,
  createBridgeConnection,
  openBridgeConnection,
  interceptTransport,
  type BridgeConnectionEvent,
} from "../src/index.js";
import { DemoService } from "../src/gen/demo_pb.js";
import { runChecks } from "../src/verify.js";

const url = process.env.TUNNEL_URL ?? "ws://localhost:8080/tunnel";
const token = process.env.TUNNEL_TOKEN ?? "";

test(
  "client wrappers share leases without changing lifecycle, deadlines, or cancellation",
  { timeout: 15000 },
  async () => {
    let opens = 0;
    const observed = new Map<string, Set<string>>();
    const shared = createSharedBridgeConnection({
      url,
      tunnelToken: () => {
        opens++;
        return token;
      },
      interceptors: [
        (next) => async (req) => {
          const contract = req.header.get("x-proto-contract")!;
          const methods = observed.get(contract) ?? new Set<string>();
          methods.add(req.method.name);
          observed.set(contract, methods);
          return next(req);
        },
      ],
    });
    try {
      const [first, second] = await Promise.all([
        shared.acquire(),
        shared.acquire(),
      ]);
      const wrap = (transport: typeof first.transport, contract: string) =>
        createClient(
          DemoService,
          interceptTransport(transport, {
            baseUrl: "http://backend",
            interceptors: [
              (next) => async (req) => {
                req.header.set("x-proto-contract", contract);
                return next(req);
              },
            ],
          }),
        );
      const echo = wrap(first.transport, "demo.echo@1.0.0");
      const orders = wrap(second.transport, "example.orders@2.3.0");
      assert.strictEqual(first.transport, second.transport);
      assert.equal(opens, 1);
      // The interoperability checks include all shapes, deadlines, cancellation,
      // concurrent RPCs, trailers, and a large message on both client wrappers.
      await Promise.all([
        runChecks(echo, () => {}),
        runChecks(orders, () => {}),
      ]);
      assert.deepEqual([...observed.keys()].sort(), [
        "demo.echo@1.0.0",
        "example.orders@2.3.0",
      ]);
      for (const methods of observed.values())
        assert.deepEqual([...methods].sort(), [
          "Chat",
          "Collect",
          "Count",
          "Echo",
        ]);
      await first.release();
      assert.equal(second.state, "open");
      assert.equal(
        (await orders.echo({ text: "still open" })).text,
        "still open",
      );
      assert.equal(opens, 1);
      await second.release();
      await second.closed;
      assert.equal(second.state, "closed");
    } finally {
      await shared.dispose();
    }
  },
);

for (const mode of ["create", "open", "shared"] as const) {
  test(
    `${mode} connection honors interceptors for every RPC shape`,
    { timeout: 10000 },
    async () => {
      const calls: string[] = [];
      const interceptors: Interceptor[] = [
        (next) => async (req) => {
          calls.push(req.method.name);
          req.header.set("x-proto-contract", "demo.echo@1.0.0");
          const response = await next(req);
          if (!response.stream)
            return {
              ...response,
              message: { ...response.message, text: "intercepted" },
            };
          return response;
        },
      ];
      const options = { url, tunnelToken: token, interceptors };
      const shared =
        mode === "shared" ? createSharedBridgeConnection(options) : undefined;
      // Shared configuration is snapshotted even before its first acquire.
      if (shared) interceptors.length = 0;
      const connection = shared
        ? await shared.acquire()
        : mode === "open"
          ? await openBridgeConnection(options)
          : createBridgeConnection(options);
      try {
        if (connection.state !== "open")
          await new Promise<void>((resolve) => {
            const unsubscribe = connection.subscribe((event) => {
              if (event.state === "open") {
                unsubscribe();
                resolve();
              }
            });
          });
        const client = createClient(DemoService, connection.transport);
        assert.equal(
          (await client.echo({ text: "original" })).text,
          "intercepted",
        );
        for await (const _ of client.count({ number: 1 })) {
          /* consume */
        }
        await client.collect(
          (async function* () {
            yield { number: 1 };
          })(),
        );
        for await (const _ of client.chat(
          (async function* () {
            yield { text: "hello" };
          })(),
        )) {
          /* consume */
        }
        assert.deepEqual(calls, ["Echo", "Count", "Collect", "Chat"]);
      } finally {
        if ("release" in connection) await connection.release();
        else await connection.close();
        await shared?.dispose();
      }
    },
  );
}

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
