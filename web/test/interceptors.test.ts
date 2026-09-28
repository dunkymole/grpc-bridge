import assert from "node:assert/strict";
import { test } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  Code,
  ConnectError,
  createClient,
  createContextKey,
  createContextValues,
  type Transport,
  type Interceptor,
} from "@connectrpc/connect";
import { interceptTransport } from "../src/index.js";
import { DemoService, MessageSchema } from "../src/gen/demo_pb.js";

const direct: Transport = {
  async unary(method, _signal, _timeout, header, message) {
    return {
      stream: false,
      method,
      service: method.parent,
      message: fromBinary(
        method.output,
        toBinary(method.input, create(method.input, message)),
      ),
      header: new Headers(header),
      trailer: new Headers({ "test-trailer": "done" }),
    };
  },
  async stream(method, _signal, _timeout, header, message) {
    return {
      stream: true,
      method,
      service: method.parent,
      message: (async function* () {
        for await (const item of message)
          yield fromBinary(
            method.output,
            toBinary(method.input, create(method.input, item)),
          );
      })(),
      header: new Headers(header),
      trailer: new Headers(),
    };
  },
};

test("omitted and empty interceptors preserve transport identity", () => {
  assert.equal(
    interceptTransport(direct, { baseUrl: "http://backend" }),
    direct,
  );
  assert.equal(
    interceptTransport(direct, { baseUrl: "http://backend", interceptors: [] }),
    direct,
  );
});

test("wrapper snapshots options and trims trailing URL slashes", async () => {
  const urls: string[] = [];
  const interceptor: Interceptor = (next) => async (req) => {
    urls.push(req.url);
    return next(req);
  };
  const options = {
    baseUrl: "https://service.internal/",
    interceptors: [interceptor],
  };
  const client = createClient(DemoService, interceptTransport(direct, options));
  options.baseUrl = "http://changed";
  options.interceptors.length = 0;
  await client.echo({});
  for await (const _ of client.count({})) {
    /* consume */
  }
  assert.deepEqual(
    urls,
    ["Echo", "Count"].map(
      (name) => `https://service.internal/${DemoService.typeName}/${name}`,
    ),
  );
});

test("interceptors receive context and normalized messages and can wrap streaming messages", async () => {
  const key = createContextKey("");
  const transport = interceptTransport(direct, {
    baseUrl: "https://backend",
    interceptors: [
      (next) => async (req) => {
        assert.equal(req.contextValues.get(key), "context");
        if (!req.stream) {
          assert.equal(req.message.$typeName, MessageSchema.typeName);
          const response = await next(req);
          assert.equal(response.trailer.get("test-trailer"), "done");
          return response;
        }
        const input = req.message;
        const response = await next({
          ...req,
          message: (async function* () {
            for await (const item of input) {
              assert.equal(item.$typeName, MessageSchema.typeName);
              yield { ...item, text: "modified request" };
            }
          })(),
        });
        assert.ok(response.stream);
        const output = response.message;
        return {
          ...response,
          message: (async function* () {
            for await (const item of output) {
              assert.equal(
                (item as { text?: string }).text,
                "modified request",
              );
              yield { ...item, text: "modified response" };
            }
          })(),
        };
      },
    ],
  });
  const client = createClient(DemoService, transport);
  const contextValues = createContextValues().set(key, "context");
  await client.echo({}, { contextValues });
  const replies = [];
  for await (const reply of client.chat(
    (async function* () {
      yield {};
    })(),
    { contextValues },
  ))
    replies.push(reply.text);
  assert.deepEqual(replies, ["modified response"]);
});

test("an interceptor can reject without reaching the transport", async () => {
  let calls = 0;
  const transport = interceptTransport(
    {
      ...direct,
      async unary(...args) {
        calls++;
        return direct.unary(...args);
      },
    },
    {
      baseUrl: "http://backend",
      interceptors: [
        () => async () => {
          throw new ConnectError("blocked", Code.PermissionDenied);
        },
      ],
    },
  );
  await assert.rejects(
    createClient(DemoService, transport).echo({}),
    (e: unknown) =>
      e instanceof ConnectError && e.code === Code.PermissionDenied,
  );
  assert.equal(calls, 0);
});

test("deadline includes time spent inside an interceptor", async () => {
  const transport = interceptTransport(direct, {
    baseUrl: "http://backend",
    interceptors: [
      (next) => async (req) => {
        await new Promise<void>((resolve) =>
          req.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        req.signal.throwIfAborted();
        return next(req);
      },
    ],
  });
  await assert.rejects(
    createClient(DemoService, transport).echo({}, { timeoutMs: 20 }),
    (e: unknown) =>
      e instanceof ConnectError && e.code === Code.DeadlineExceeded,
  );
});
