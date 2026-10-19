import assert from "node:assert/strict";
import { test } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { DemoService, MessageSchema } from "../src/gen/demo_pb.js";
import { frame } from "../src/framing.js";
import type { H2Connection } from "../src/h2/connection.js";
import type { H2RequestInit, H2Response } from "../src/h2/types.js";
import { createTunnelTransport } from "../src/transport.js";

test(
  "a resumed canceled producer cannot replace a committed connection error",
  { timeout: 3_000 },
  async (t) => {
    for (const outcome of ["yield", "return", "throw"] as const) {
      await t.test(outcome, async () => {
        let resume!: () => void;
        let entered!: () => void;
        const parked = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const pulling = new Promise<void>((resolve) => {
          entered = resolve;
        });
        let requestReader!: ReadableStreamDefaultReader<Uint8Array>;
        let pendingRead!: Promise<ReadableStreamReadResult<Uint8Array>>;
        let responseController!: ReadableStreamDefaultController<Uint8Array>;
        let calls = 0;
        const connection = {
          async request(init: H2RequestInit): Promise<H2Response> {
            calls++;
            assert(init.body instanceof ReadableStream);
            requestReader = init.body.getReader();
            await requestReader.read();
            pendingRead = requestReader.read();
            return {
              endStream: false,
              status: 200,
              headers: { "content-type": "application/grpc" },
              rawHeaders: [],
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  responseController = controller;
                  controller.enqueue(
                    frame(
                      toBinary(
                        MessageSchema,
                        create(MessageSchema, { text: "committed reply" }),
                      ),
                    ),
                  );
                },
              }),
              trailers: () => undefined,
              bytes: async () => {
                throw new Error("unexpected bytes() helper");
              },
              arrayBuffer: async () => {
                throw new Error("unexpected arrayBuffer() helper");
              },
              text: async () => {
                throw new Error("unexpected text() helper");
              },
              json: async () => {
                throw new Error("unexpected json() helper");
              },
            };
          },
        } as unknown as H2Connection;
        const client = createClient(
          DemoService,
          createTunnelTransport(connection),
        );
        const replies = client
          .chat(
            (async function* () {
              yield { text: "first input" };
              entered();
              await parked;
              if (outcome === "throw") throw new Error("late producer failure");
              if (outcome === "return") return;
              yield { text: "late input" };
            })(),
          )
          [Symbol.asyncIterator]();
        assert.equal((await replies.next()).value?.text, "committed reply");
        await pulling;
        // Model the real HTTP/2 pump canceling its input after socket loss while
        // the application is paused between bidi response reads.
        await requestReader.cancel();
        responseController.error(
          new ConnectError("connection lost", Code.Unavailable),
        );
        resume();
        await pendingRead;
        await new Promise((resolve) => setTimeout(resolve, 0));
        await assert.rejects(
          replies.next(),
          (error: unknown) =>
            error instanceof ConnectError &&
            error.code === Code.Unavailable &&
            error.message.includes("connection lost"),
        );
        assert.equal(calls, 1, "committed request was replayed");
      });
    }
  },
);
