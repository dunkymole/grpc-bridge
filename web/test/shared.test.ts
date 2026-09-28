import assert from "node:assert/strict";
import { test } from "node:test";
import { createSharedBridgeConnection } from "../src/index.js";

test("configuration is captured once; failed concurrent opens can be acquired again", async () => {
  let calls = 0;
  const options = {
    url: "ws://localhost:8080/tunnel",
    tunnelToken: async () => {
      calls++;
      throw new Error("credential unavailable");
    },
  };
  const shared = createSharedBridgeConnection(options);
  options.tunnelToken = async () => {
    throw new Error("mutated");
  };
  assert.equal(calls, 0);
  const failures = await Promise.allSettled([
    shared.acquire(),
    shared.acquire(),
  ]);
  assert.equal(calls, 1);
  for (const failure of failures) {
    assert.equal(failure.status, "rejected");
    if (failure.status === "rejected")
      assert.match(failure.reason.message, /credential unavailable/);
  }
  await assert.rejects(shared.acquire(), /credential unavailable/);
  assert.equal(calls, 2);
  await shared.dispose();
  await assert.rejects(shared.acquire(), /disposed/);
});

test("disposing an unused handle never invokes its token provider", async () => {
  let calls = 0;
  const shared = createSharedBridgeConnection({
    url: "ws://localhost:8080/tunnel",
    tunnelToken: () => {
      calls++;
      return "";
    },
  });
  await shared.dispose();
  await shared.dispose();
  await assert.rejects(shared.acquire(), /disposed/);
  assert.equal(calls, 0);
});
