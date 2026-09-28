import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { Duplex } from "node:stream";
import {
  createServer,
  constants,
  type ServerHttp2Stream,
  type IncomingHttpHeaders,
  type ServerHttp2Session,
} from "node:http2";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { Client, credentials } from "@grpc/grpc-js";
import {
  Code,
  ConnectError,
  createClient,
  type Interceptor,
} from "@connectrpc/connect";
import { H2Connection } from "../src/h2/connection.js";
import { createTunnelTransport } from "../src/transport.js";
import { RecoveringConnection } from "../src/recovery.js";
import { type RetryOptions, type RetryPolicy } from "../src/retry.js";
import { DemoService, MessageSchema } from "../src/gen/demo_pb.js";
import { frame } from "../src/framing.js";

const policy: RetryPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 5,
  maxBackoffMs: 20,
  backoffMultiplier: 2,
  retryableStatusCodes: [Code.Unavailable],
};
const unavailable = (error: unknown) =>
  error instanceof ConnectError && error.code === Code.Unavailable;
const status = (stream: ServerHttp2Stream, code = 14, extra = {}) => {
  stream.respond(
    {
      ":status": 200,
      "content-type": "application/grpc",
      "grpc-status": String(code),
      ...extra,
    },
    { endStream: true },
  );
};
const success = (stream: ServerHttp2Stream, text = "ok") => {
  stream.respond(
    { ":status": 200, "content-type": "application/grpc" },
    { waitForTrailers: true },
  );
  stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
  stream.end(frame(toBinary(MessageSchema, create(MessageSchema, { text }))));
};

async function fixture(
  handler: (
    stream: ServerHttp2Stream,
    headers: IncomingHttpHeaders,
    n: number,
    drop: () => void,
  ) => void,
  retry?: RetryOptions,
  interceptors?: readonly Interceptor[],
) {
  const server = createServer();
  const sockets = new Map<number, Socket>();
  server.on("connection", (socket) => {
    sockets.set(socket.remotePort!, socket);
  });
  const sessions = new Set<ServerHttp2Session>();
  let calls = 0,
    connections = 0;
  server.on("session", (session) => {
    connections++;
    sessions.add(session);
    session.on("error", () => {});
  });
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    stream.resume();
    const socket = sockets.get(stream.session!.socket.remotePort!);
    handler(stream, headers, ++calls, () => socket!.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connection = new RecoveringConnection(
    async () => {
      const socket = createConnection(address.port, "127.0.0.1");
      await once(socket, "connect");
      const channel = new H2Connection(
        Duplex.toWeb(socket) as unknown as ConstructorParameters<
          typeof H2Connection
        >[0],
        { settings: { enablePush: false } },
      );
      return { channel, transport: createTunnelTransport(channel) };
    },
    undefined,
    retry,
    { interceptors, baseUrl: "http://backend" },
  );
  await connection.initial;
  return {
    client: createClient(DemoService, connection.transport),
    connection,
    port: address.port,
    get calls() {
      return calls;
    },
    get connections() {
      return connections;
    },
    async close() {
      await connection.close();
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("interceptor metadata reaches all RPC shapes in declaration order", async () => {
  const seen: IncomingHttpHeaders[] = [];
  const events: string[] = [];
  const first: Interceptor = (next) => async (req) => {
    events.push(`first:${req.method.name}`);
    assert.equal(
      req.url,
      `http://backend/${DemoService.typeName}/${req.method.name}`,
    );
    assert.equal(req.requestMethod, "POST");
    req.header.set("x-proto-contract", "demo.echo@1.0.0");
    const response = await next(req);
    events.push(`last:${req.method.name}`);
    return response;
  };
  const second: Interceptor = (next) => async (req) => {
    events.push(`second:${req.method.name}`);
    assert.equal(req.header.get("x-proto-contract"), "demo.echo@1.0.0");
    return next(req);
  };
  const f = await fixture(
    (stream, headers) => {
      seen.push(headers);
      success(stream);
    },
    undefined,
    [first, second],
  );
  try {
    await f.client.echo({});
    for await (const _ of f.client.count({})) {
      /* consume trailers */
    }
    await f.client.collect(
      (async function* () {
        yield {};
      })(),
    );
    for await (const _ of f.client.chat(
      (async function* () {
        yield {};
      })(),
    )) {
      /* consume trailers */
    }
    assert.equal(seen.length, 4);
    assert.ok(seen.every((h) => h["x-proto-contract"] === "demo.echo@1.0.0"));
    assert.deepEqual(
      events,
      ["Echo", "Count", "Collect", "Chat"].flatMap((name) => [
        `first:${name}`,
        `second:${name}`,
        `last:${name}`,
      ]),
    );
  } finally {
    await f.close();
  }
});

test("interceptors run once and retain metadata across GOAWAY replacement", async () => {
  let invocations = 0;
  const seen: IncomingHttpHeaders[] = [];
  const metadata: Interceptor = (next) => async (req) => {
    req.header.set("x-logical-call", String(++invocations));
    return next(req);
  };
  const f = await fixture(
    (stream, headers, n) => {
      seen.push(headers);
      n === 2 ? stream.session!.goaway(0, 1) : success(stream);
    },
    undefined,
    [metadata],
  );
  try {
    await f.client.echo({}, { timeoutMs: 1000 });
    await f.client.echo({}, { timeoutMs: 2000 });
    assert.equal(invocations, 2);
    assert.equal(f.connections, 2);
    assert.deepEqual(
      seen.map((h) => h["x-logical-call"]),
      ["1", "2", "2"],
    );
  } finally {
    await f.close();
  }
});

test("configured streaming retries keep interceptor metadata and run once", async () => {
  let invocations = 0;
  const seen: IncomingHttpHeaders[] = [];
  const f = await fixture(
    (stream, headers, n) => {
      seen.push(headers);
      n === 1 ? status(stream) : success(stream);
    },
    { policy },
    [
      (next) => async (req) => {
        req.header.set("x-logical-call", String(++invocations));
        return next(req);
      },
    ],
  );
  try {
    for await (const _ of f.client.count({}, { timeoutMs: 1000 })) {
      /* consume */
    }
    assert.equal(invocations, 1);
    assert.deepEqual(
      seen.map((h) => h["x-logical-call"]),
      ["1", "1"],
    );
  } finally {
    await f.close();
  }
});

test(
  "REFUSED_STREAM is retried once, without configured-attempt metadata",
  { timeout: 5000 },
  async () => {
    const headers: IncomingHttpHeaders[] = [];
    const f = await fixture((stream, h, n) => {
      headers.push(h);
      n === 1
        ? stream.close(constants.NGHTTP2_REFUSED_STREAM)
        : success(stream);
    });
    try {
      assert.equal((await f.client.echo({}, { timeoutMs: 2000 })).text, "ok");
      assert.equal(f.calls, 2);
      assert.equal(headers[1]["grpc-previous-rpc-attempts"], undefined);
    } finally {
      await f.close();
    }
    const repeated = await fixture((stream) =>
      stream.close(constants.NGHTTP2_REFUSED_STREAM),
    );
    try {
      await assert.rejects(
        repeated.client.echo({}, { timeoutMs: 1000 }),
        unavailable,
      );
      assert.equal(repeated.calls, 2);
    } finally {
      await repeated.close();
    }
  },
);

test(
  "unknown socket failure is not transparently replayed",
  { timeout: 5000 },
  async () => {
    const f = await fixture((stream) => stream.session!.destroy());
    try {
      await assert.rejects(f.client.echo({}, { timeoutMs: 1000 }), unavailable);
      assert.equal(f.calls, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "GOAWAY replaces the connection and lets accepted RPCs finish",
  { timeout: 5000 },
  async () => {
    let accepted!: ServerHttp2Stream;
    let first!: () => void;
    const received = new Promise<void>((resolve) => {
      first = resolve;
    });
    const f = await fixture((stream, _h, n) => {
      if (n === 1) {
        accepted = stream;
        stream.session!.goaway(0, stream.id!);
        first();
      } else success(stream, "new");
    });
    try {
      const pending = f.client.echo({}, { timeoutMs: 2000 });
      await received;
      await new Promise<void>((resolve) => {
        const check = () => {
          if (f.connections === 2) resolve();
          else setTimeout(check, 5);
        };
        check();
      });
      assert.equal((await f.client.echo({}, { timeoutMs: 1000 })).text, "new");
      success(accepted, "original");
      assert.equal((await pending).text, "original");
      assert.equal(f.calls, 2);
    } finally {
      await f.close();
    }
  },
);

test(
  "GOAWAY lastStreamId excludes an RPC: replay on replacement connection",
  { timeout: 5000 },
  async () => {
    const f = await fixture((stream, _h, n) =>
      n === 2 ? stream.session!.goaway(0, 1) : success(stream),
    );
    try {
      await f.client.echo({}, { timeoutMs: 1000 });
      assert.equal((await f.client.echo({}, { timeoutMs: 2000 })).text, "ok");
      assert.equal(f.calls, 3);
      assert.equal(f.connections, 2);
    } finally {
      await f.close();
    }
  },
);

test(
  "configured retry limit and grpc-previous-rpc-attempts",
  { timeout: 5000 },
  async () => {
    const attempts: Array<string | string[] | undefined> = [];
    const timeouts: number[] = [];
    const f = await fixture(
      (stream, headers) => {
        attempts.push(headers["grpc-previous-rpc-attempts"]);
        timeouts.push(Number(String(headers["grpc-timeout"]).slice(0, -1)));
        status(stream);
      },
      { policy },
    );
    try {
      await assert.rejects(f.client.echo({}, { timeoutMs: 1000 }), unavailable);
      assert.deepEqual(attempts, [undefined, "1", "2"]);
      assert.ok(timeouts[2] < timeouts[0]);
    } finally {
      await f.close();
    }
  },
);

test(
  "normal response headers commit unary and streaming calls even before any message",
  { timeout: 5000 },
  async () => {
    const f = await fixture(
      (stream) => {
        stream.respond(
          { ":status": 200, "content-type": "application/grpc" },
          { waitForTrailers: true },
        );
        stream.on("wantTrailers", () =>
          stream.sendTrailers({ "grpc-status": "14" }),
        );
        stream.end();
      },
      { policy },
    );
    try {
      await assert.rejects(f.client.echo({}, { timeoutMs: 1000 }), unavailable);
      await assert.rejects(async () => {
        for await (const _ of f.client.count({}, { timeoutMs: 1000 })) {
        }
      }, unavailable);
      assert.equal(f.calls, 2);
    } finally {
      await f.close();
    }
  },
);

test(
  "server pushback controls delays and malformed/negative values prohibit retry",
  { timeout: 5000 },
  async () => {
    const stamps: number[] = [];
    const f = await fixture(
      (stream, _h, n) => {
        stamps.push(performance.now());
        n === 1
          ? status(stream, 14, { "grpc-retry-pushback-ms": "45" })
          : success(stream);
      },
      { policy },
    );
    try {
      await f.client.echo({}, { timeoutMs: 1000 });
      assert.ok(stamps[1] - stamps[0] >= 40);
    } finally {
      await f.close();
    }
    for (const value of ["-1", "invalid", "1, 2"]) {
      const f = await fixture(
        (stream) => status(stream, 14, { "grpc-retry-pushback-ms": value }),
        { policy },
      );
      try {
        await assert.rejects(
          f.client.echo({}, { timeoutMs: 1000 }),
          unavailable,
        );
        assert.equal(f.calls, 1);
      } finally {
        await f.close();
      }
    }
  },
);

test(
  "deadline and cancellation interrupt retry backoff",
  { timeout: 5000 },
  async () => {
    const f = await fixture(
      (stream) => status(stream, 14, { "grpc-retry-pushback-ms": "1000" }),
      { policy },
    );
    try {
      await assert.rejects(
        f.client.echo({}, { timeoutMs: 40 }),
        (e) => e instanceof ConnectError && e.code === Code.DeadlineExceeded,
      );
      assert.equal(f.calls, 1);
      const abort = new AbortController();
      const pending = assert.rejects(
        f.client.echo({}, { signal: abort.signal }),
        (e) => e instanceof ConnectError && e.code === Code.Canceled,
      );
      setTimeout(() => abort.abort(), 40);
      await pending;
      assert.equal(f.calls, 2);
    } finally {
      await f.close();
    }
  },
);

test(
  "method opt-out, non-retryable status, and request buffer limits",
  { timeout: 5000 },
  async () => {
    for (const retry of [
      {
        policy,
        methods: { "/bridge.demo.v1.DemoService/Echo": false as const },
      },
      { policy, perRpcBufferBytes: 5 },
      { policy, bufferBytes: 5 },
    ]) {
      const f = await fixture((stream) => status(stream), retry);
      try {
        await assert.rejects(
          f.client.echo({ text: "too large to retain" }, { timeoutMs: 1000 }),
          unavailable,
        );
        assert.equal(f.calls, 1);
      } finally {
        await f.close();
      }
    }
    const f = await fixture((stream) => status(stream, 7), { policy });
    try {
      await assert.rejects(
        f.client.echo({}, { timeoutMs: 1000 }),
        (e) => e instanceof ConnectError && e.code === Code.PermissionDenied,
      );
      assert.equal(f.calls, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "streaming request is read once and its serialized messages are replayed",
  { timeout: 5000 },
  async () => {
    let reads = 0;
    const bodies: Buffer[] = [];
    const f = await fixture(
      (stream, _h, n) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on("end", () => {
          bodies.push(Buffer.concat(chunks));
          n === 1 ? status(stream) : success(stream);
        });
      },
      { policy },
    );
    try {
      const input = (async function* () {
        reads++;
        yield { text: "one" };
        reads++;
        yield { text: "two" };
      })();
      assert.equal(
        (await f.client.collect(input, { timeoutMs: 2000 })).text,
        "ok",
      );
      assert.equal(reads, 2);
      assert.equal(bodies.length, 2);
      assert.deepEqual(bodies[0], bodies[1]);
    } finally {
      await f.close();
    }
  },
);

test(
  "retry throttling suppresses retries until successful calls replenish tokens",
  { timeout: 5000 },
  async () => {
    let fail = true;
    const f = await fixture(
      (stream) => (fail ? status(stream) : success(stream)),
      { policy, throttling: { maxTokens: 4, tokenRatio: 1 } },
    );
    try {
      await assert.rejects(f.client.echo({}, { timeoutMs: 1000 }), unavailable);
      assert.equal(f.calls, 2);
      await assert.rejects(f.client.echo({}, { timeoutMs: 1000 }), unavailable);
      assert.equal(f.calls, 3);
      fail = false;
      for (let i = 0; i < 3; i++) await f.client.echo({}, { timeoutMs: 1000 });
      fail = true;
      await assert.rejects(f.client.echo({}, { timeoutMs: 1000 }), unavailable);
      assert.equal(f.calls, 8);
    } finally {
      await f.close();
    }
  },
);

for (const scenario of [
  "refused",
  "policy",
  "pushback-stop",
  "committed",
  "socket-loss",
] as const) {
  test(
    `native grpc-js comparison: ${scenario}`,
    { timeout: 10000 },
    async () => {
      const results: Array<{
        attempts: number;
        status: number;
        previous: unknown[];
      }> = [];
      for (const implementation of ["bridge", "native"] as const) {
        const previous: unknown[] = [];
        const configured = scenario !== "refused" && scenario !== "socket-loss";
        const f = await fixture(
          (stream, headers, n, drop) => {
            previous.push(headers["grpc-previous-rpc-attempts"]);
            if (scenario === "refused")
              return n === 1
                ? stream.close(constants.NGHTTP2_REFUSED_STREAM)
                : success(stream);
            if (scenario === "socket-loss") return drop();
            if (scenario === "pushback-stop")
              return status(stream, 14, { "grpc-retry-pushback-ms": "-1" });
            if (scenario === "committed") {
              stream.respond(
                { ":status": 200, "content-type": "application/grpc" },
                { waitForTrailers: true },
              );
              stream.on("wantTrailers", () =>
                stream.sendTrailers({ "grpc-status": "14" }),
              );
              stream.end();
              return;
            }
            n < 3 ? status(stream) : success(stream);
          },
          configured ? { policy } : undefined,
        );
        let native: Client | undefined;
        let code = 0;
        try {
          if (implementation === "bridge")
            await f.client.echo({}, { timeoutMs: 2000 });
          else {
            native = new Client(
              `127.0.0.1:${f.port}`,
              credentials.createInsecure(),
              {
                "grpc.enable_retries": 1,
                ...(configured
                  ? {
                      "grpc.service_config": JSON.stringify({
                        methodConfig: [
                          {
                            name: [{ service: "bridge.demo.v1.DemoService" }],
                            retryPolicy: {
                              maxAttempts: 3,
                              initialBackoff: "0.005s",
                              maxBackoff: "0.020s",
                              backoffMultiplier: 2,
                              retryableStatusCodes: ["UNAVAILABLE"],
                            },
                          },
                        ],
                      }),
                    }
                  : {}),
              },
            );
            await new Promise<void>((resolve, reject) =>
              native!.makeUnaryRequest(
                "/bridge.demo.v1.DemoService/Echo",
                (value) =>
                  Buffer.from(
                    toBinary(MessageSchema, create(MessageSchema, value)),
                  ),
                (bytes) => fromBinary(MessageSchema, bytes),
                {},
                { deadline: Date.now() + 2000 },
                (error) => (error ? reject(error) : resolve()),
              ),
            );
          }
        } catch (error) {
          code = (error as { code: number }).code;
        } finally {
          native?.close();
          await f.close();
        }
        results.push({ attempts: f.calls, status: code, previous });
      }
      assert.deepEqual(results[0], results[1]);
      assert.equal(
        results[0].status,
        scenario === "policy" || scenario === "refused" ? 0 : 14,
      );
    },
  );
}

test(
  "refusal while a streaming input read is pending does not lose or duplicate input",
  { timeout: 5000 },
  async () => {
    let reads = 0;
    const received: Buffer[] = [];
    const f = await fixture((stream, _headers, n) => {
      if (n === 1)
        stream.once("data", () =>
          stream.close(constants.NGHTTP2_REFUSED_STREAM),
        );
      else {
        stream.on("data", (chunk) => received.push(Buffer.from(chunk)));
        stream.on("end", () => success(stream));
      }
    });
    try {
      const input = (async function* () {
        reads++;
        yield { text: "one" };
        await new Promise((resolve) => setTimeout(resolve, 40));
        reads++;
        yield { text: "two" };
      })();
      await f.client.collect(input, { timeoutMs: 2000 });
      assert.equal(reads, 2);
      assert.deepEqual(
        Buffer.concat(received),
        Buffer.concat(
          ["one", "two"].map((text) =>
            frame(toBinary(MessageSchema, create(MessageSchema, { text }))),
          ),
        ),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "aggregate buffer is bounded across calls and released for later calls",
  { timeout: 5000 },
  async () => {
    const initial: ServerHttp2Stream[] = [];
    const f = await fixture(
      (stream, headers, n) => {
        if (headers["grpc-previous-rpc-attempts"]) return success(stream);
        if (n <= 2) {
          initial.push(stream);
          if (initial.length === 2) initial.forEach((s) => status(s));
        } else status(stream);
      },
      { policy, bufferBytes: 40 },
    );
    try {
      const results = await Promise.allSettled([
        f.client.echo({ text: "a".repeat(20) }, { timeoutMs: 1000 }),
        f.client.echo({ text: "b".repeat(20) }, { timeoutMs: 1000 }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(f.calls, 3);
      await f.client.echo({ text: "c".repeat(20) }, { timeoutMs: 1000 });
      assert.equal(f.calls, 5);
    } finally {
      await f.close();
    }
  },
);

test(
  "post-header streaming deadline preserves DeadlineExceeded",
  { timeout: 5000 },
  async () => {
    const f = await fixture((stream) => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" });
    });
    try {
      await assert.rejects(
        async () => {
          for await (const _ of f.client.count({}, { timeoutMs: 40 })) {
          }
        },
        (e) => e instanceof ConnectError && e.code === Code.DeadlineExceeded,
      );
      assert.equal(f.calls, 1);
    } finally {
      await f.close();
    }
  },
);
