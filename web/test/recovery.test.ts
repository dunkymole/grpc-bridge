import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Code,
  ConnectError,
  createClient,
  createContextValues,
  type Transport,
} from "@connectrpc/connect";
import { RecoveringConnection, type Session } from "../src/recovery.js";
import { waitForReady, createBridgeConnectionPool } from "../src/client.js";
import { DemoService } from "../src/gen/demo_pb.js";

const waiting = createContextValues().set(waitForReady, true);
const code = (expected: Code) => (error: unknown) =>
  error instanceof ConnectError && error.code === expected;
function session() {
  let stop!: () => void;
  const closed = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const timeouts: Array<number | undefined> = [];
  let calls = 0;
  const transport = {
    unary: async (_method, _signal, timeoutMs, _header, input) => {
      calls++;
      timeouts.push(timeoutMs);
      return { message: input };
    },
  } as Transport;
  return {
    channel: { closed, close: stop },
    transport,
    stop,
    timeouts,
    get calls() {
      return calls;
    },
  };
}

test(
  "initial outages recover and observer exceptions do not break recovery",
  { timeout: 5000 },
  async () => {
    let attempts = 0;
    const ready = session();
    const connection = new RecoveringConnection(
      async () => {
        if (++attempts === 1) throw new Error("offline");
        return ready;
      },
      () => {
        throw new Error("observer failure");
      },
    );
    try {
      const client = createClient(DemoService, connection.transport);
      const result = await client.echo(
        { text: "recovered" },
        { contextValues: waiting, timeoutMs: 3000 },
      );
      assert.equal(result.text, "recovered");
      assert.equal(attempts, 2);
    } finally {
      await connection.close();
    }
  },
);

test(
  "waiting streams never consume input or retry after shutdown",
  { timeout: 5000 },
  async () => {
    let attempts = 0;
    let consumed = false;
    const connection = new RecoveringConnection(async () => {
      attempts++;
      throw new Error("offline");
    });
    const client = createClient(DemoService, connection.transport);
    const input = (async function* () {
      consumed = true;
      yield { number: 1 };
    })();
    const pending = assert.rejects(
      client.collect(input, { contextValues: waiting, timeoutMs: 20 }),
      code(Code.DeadlineExceeded),
    );
    await pending;
    assert.equal(consumed, false);
    await connection.close();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(attempts, 1);
  },
);

test("pool shutdown cancels acquisitions even when a token provider has not returned", async () => {
  const pool = createBridgeConnectionPool();
  const pending = assert.rejects(
    pool.acquire({
      url: "ws://localhost:8080/tunnel",
      authenticationContext: "pending",
      tunnelToken: () => new Promise<string>(() => {}),
    }),
  );
  await Promise.resolve();
  await pool.close();
  await pending;
});

test(
  "same client recovers; wait-for-ready keeps its original deadline",
  { timeout: 5000 },
  async () => {
    const first = session();
    const second = session();
    let attempts = 0;
    const connection = new RecoveringConnection(async () =>
      ++attempts === 1 ? first : second,
    );
    try {
      await connection.initial;
      const client = createClient(DemoService, connection.transport);
      await client.echo({ text: "first" });
      first.stop();
      await Promise.resolve();
      assert.equal(connection.state, "transient_failure");
      await assert.rejects(client.echo({}), code(Code.Unavailable));
      const result = await client.echo(
        { text: "second" },
        { contextValues: waiting, timeoutMs: 3000 },
      );
      assert.equal(result.text, "second");
      assert.equal(first.calls, 1);
      assert.equal(second.calls, 1);
      assert.ok(second.timeouts[0]! < 2500);
      assert.equal(connection.state, "open");
    } finally {
      await connection.close();
    }
  },
);

test("waiting calls cancel, expire, and fail on explicit close", async () => {
  const connection = new RecoveringConnection(async () => {
    throw new Error("offline");
  });
  await assert.rejects(connection.initial);
  const client = createClient(DemoService, connection.transport);
  const abort = new AbortController();
  const canceled = assert.rejects(
    client.echo({}, { contextValues: waiting, signal: abort.signal }),
    code(Code.Canceled),
  );
  abort.abort();
  await canceled;
  await assert.rejects(
    client.echo({}, { contextValues: waiting, timeoutMs: 10 }),
    code(Code.DeadlineExceeded),
  );
  const pending = assert.rejects(
    client.echo({}, { contextValues: waiting }),
    code(Code.Unavailable),
  );
  await connection.close();
  await pending;
  await connection.closed;
  assert.equal(connection.state, "closed");
});

test("close during dial disposes late sessions and never reopens", async () => {
  let complete!: (value: Session) => void;
  let signal!: AbortSignal;
  const connection = new RecoveringConnection((value) => {
    signal = value;
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  await Promise.resolve();
  await connection.close();
  assert.ok(signal.aborted);
  const late = session();
  complete(late);
  await late.channel.closed;
  assert.equal(connection.state, "closed");
});

test("an in-flight RPC is not retried after transport loss", async () => {
  const first = session();
  let calls = 0;
  first.transport.unary = async () => {
    calls++;
    await first.channel.closed;
    throw new ConnectError("lost", Code.Unavailable);
  };
  const connection = new RecoveringConnection(async () => first);
  await connection.initial;
  const client = createClient(DemoService, connection.transport);
  const pending = assert.rejects(client.echo({}), code(Code.Unavailable));
  await Promise.resolve();
  await Promise.resolve();
  first.stop();
  await pending;
  assert.equal(calls, 1);
  await connection.close();
});
