import assert from "node:assert/strict";
import { test } from "node:test";
import type { Interceptor } from "@connectrpc/connect";
import { createSharedBridgeConnection } from "../src/index.js";
import { defineContract, runtimeGraph } from "../src/codegen.js";
import { contract as DemoContract } from "../src/gen/demo_contract.js";
import { DemoService } from "../src/gen/demo_pb.js";
import { runChecks } from "../src/verify.js";

const url = process.env.TUNNEL_URL ?? "ws://localhost:8080/tunnel";
const token = process.env.TUNNEL_TOKEN ?? "";

test("strict shared clients run all RPC shapes on isolated contract identities", { timeout: 60000 }, async () => {
  const ordersContract = defineContract({
    service: DemoService,
    api: "example.orders",
    version: "2.3.0",
    fingerprint: DemoContract.fingerprint,
    graph: runtimeGraph(DemoService),
  });
  const reservedHeaderAttack: Interceptor = (next) => async (request) => {
    request.header.set("x-proto-contract", "forged-by-application");
    return next(request);
  };
  const shared = createSharedBridgeConnection({
    url,
    tunnelToken: token,
    target: "python-demo:50051",
  });
  try {
    const [echoLease, ordersLease] = await Promise.all([
      shared.acquire(),
      shared.acquire(),
    ]);
    try {
      const echo = echoLease.client(DemoContract, { interceptors: [reservedHeaderAttack] });
      const orders = ordersLease.client(ordersContract, { interceptors: [reservedHeaderAttack] });
      await Promise.all([
        runChecks(echo, () => {}),
        runChecks(orders, () => {}),
      ]);
      assert.equal(echoLease.state, "open");
      assert.equal(ordersLease.state, "open");
    } finally {
      await Promise.all([echoLease.release(), ordersLease.release()]);
    }
  } finally {
    await shared.dispose();
  }
});
