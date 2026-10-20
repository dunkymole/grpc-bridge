import assert from "node:assert/strict";
import { test } from "node:test";
import { openChannel } from "../src/channel.js";
import {
  createBridgeConnection,
  createSharedBridgeConnection,
  openBridgeConnection,
} from "../src/client.js";

const url = "ws://localhost:8080/tunnel";

test("managed factories reject malformed labels before opening or retrying", async () => {
  const invalid = [
    "",
    "Demo",
    "1demo",
    "demo.example",
    "host:50051",
    "-demo",
    "demo\n",
    "demo\r",
    "a".repeat(64),
    42 as unknown as string,
  ];
  for (const target of invalid) {
    assert.throws(() => createBridgeConnection({ url, target }), TypeError);
    assert.throws(
      () => createSharedBridgeConnection({ url, target }),
      TypeError,
    );
    await assert.rejects(openBridgeConnection({ url, target }), TypeError);
  }
  for (const query of [
    "?target=",
    "?target=Demo",
    "?target=demo&target=other",
    "?target=host%3A50051",
    "?target=demo%0A",
    "?target=demo%0D",
  ]) {
    assert.throws(
      () => createBridgeConnection({ url: `${url}${query}` }),
      TypeError,
    );
    assert.throws(
      () => createSharedBridgeConnection({ url: `${url}${query}` }),
      TypeError,
    );
  }
});

test("raw channel validates labels and preserves a valid URL target", async () => {
  const previous = globalThis.WebSocket;
  const attempted: string[] = [];
  class SocketStub {
    binaryType = "";
    onerror?: () => void;
    constructor(endpoint: URL) {
      attempted.push(endpoint.toString());
      queueMicrotask(() => this.onerror?.());
    }
    close() {}
  }
  globalThis.WebSocket = SocketStub as unknown as typeof WebSocket;
  try {
    for (const bad of [
      "",
      "Demo",
      "host:50051",
      "demo\n",
      "demo\r",
      "a".repeat(64),
      42 as unknown as string,
    ]) {
      await assert.rejects(openChannel(url, "", { target: bad }), TypeError);
    }
    for (const badUrl of [
      `${url}?target=`,
      `${url}?target=demo&target=other`,
      `${url}?target=host%3A50051`,
      `${url}?target=demo%0A`,
      `${url}?target=demo%0D`,
    ]) {
      await assert.rejects(openChannel(badUrl), TypeError);
    }
    assert.deepEqual(attempted, []);

    await assert.rejects(openChannel(`${url}?target=demo`), /handshake failed/);
    await assert.rejects(
      openChannel(url, "", { target: "a".repeat(63) }),
      /handshake failed/,
    );
    await assert.rejects(
      openChannel(`${url}?target=ignored`, "", { target: "other" }),
      /handshake failed/,
    );
    assert.equal(new URL(attempted[0]!).searchParams.get("target"), "demo");
    assert.equal(
      new URL(attempted[1]!).searchParams.get("target"),
      "a".repeat(63),
    );
    assert.equal(new URL(attempted[2]!).searchParams.get("target"), "other");
  } finally {
    globalThis.WebSocket = previous;
  }
});

test("managed connection snapshots the selected route before its first dial", async () => {
  const previous = globalThis.WebSocket;
  const attempted: string[] = [];
  class SocketStub {
    binaryType = "";
    onerror?: () => void;
    constructor(endpoint: URL) {
      attempted.push(endpoint.toString());
      queueMicrotask(() => this.onerror?.());
    }
    close() {}
  }
  globalThis.WebSocket = SocketStub as unknown as typeof WebSocket;
  try {
    const options = { url, target: "demo" };
    const connection = createBridgeConnection(options);
    options.url = `${url}?target=changed`;
    options.target = "changed";
    await new Promise<void>((resolve) => {
      connection.subscribe(({ state }) => {
        if (state === "transient_failure") resolve();
      });
    });
    await connection.close();
    assert.equal(attempted.length, 1);
    assert.equal(new URL(attempted[0]!).searchParams.get("target"), "demo");
  } finally {
    globalThis.WebSocket = previous;
  }
});
