import { createClient, Code, ConnectError } from "@connectrpc/connect";
import { DemoService } from "../src/gen/demo_pb.js";
import { openBridgeConnection } from "../src/index.js";
import { inputQueue } from "../src/queue.js";

/** The URL addresses the gateway, not the private Python host. */
export async function connectDemo(
  gatewayUrl: string,
  tunnelToken = "",
  target = "python-demo:50051",
  options: { forwardToken?: boolean } = {},
) {
  // The bridge authorizes and resolves this host:port before HTTP/2 starts.
  const connection = await openBridgeConnection({
    url: gatewayUrl,
    target,
    tunnelToken,
    backendBearerToken: options.forwardToken ? tunnelToken : undefined,
  });
  const client = createClient(DemoService, connection.transport);
  return { client, close: () => connection.close() };
}

/** Runs in browsers or Node 24+. No Node-only imports in this module. */
export async function runExamples(
  gatewayUrl: string,
  tunnelToken = "",
  log: (message: string) => void = console.log,
  target = "python-demo:50051",
  options: { forwardToken?: boolean } = {},
) {
  const { client, close } = await connectDemo(
    gatewayUrl,
    tunnelToken,
    target,
    options,
  );
  try {
    // Unary. This metadata reaches Python inside HTTP/2. The gateway does not
    // inspect it, and it cannot change which backend this tunnel connects to.
    const echoed = await client.echo(
      { text: "Hello from a typed TypeScript client" },
      {
        headers: { "x-request-id": "typescript-example" },
        timeoutMs: 5000,
        onTrailer: (trailers) =>
          log(`Backend trailer: ${trailers.get("demo-trailer")}`),
      },
    );
    log(`Unary: ${echoed.text}`);

    // Server streaming: responses arrive incrementally.
    for await (const response of client.count({ number: 3, delayMs: 30 })) {
      log(`Server stream: ${response.number}`);
    }

    // Client streaming: generator completion half-closes the request.
    const collected = await client.collect(
      (async function* () {
        for (const number of [10, 20, 30]) yield { number };
      })(),
    );
    log(`Client stream sum: ${collected.number}`);

    // Bidirectional: receive each reply BEFORE completing the request.
    const input = inputQueue<{ text: string }>();
    const replies = client.chat(input.messages)[Symbol.asyncIterator]();
    for (const text of ["first live message", "second live message"]) {
      const receiving = replies.next();
      await input.send({ text });
      log(`Bidi: ${(await receiving).value?.text}`);
    }
    await input.complete();
    await replies.next(); // Consume completion and validate gRPC trailers.

    // Concurrent RPCs reuse this same channel; no extra WebSocket is opened.
    const responses = await Promise.all([
      client.echo({ text: "parallel A" }),
      client.echo({ text: "parallel B" }),
    ]);
    log(`Multiplexed: ${responses.map((r) => r.text).join(", ")}`);

    // Cancellation affects this RPC, not the channel or its siblings.
    const cancel = new AbortController();
    try {
      for await (const response of client.count(
        { number: 100, delayMs: 30 },
        { signal: cancel.signal },
      )) {
        log(`Before cancellation: ${response.number}`);
        cancel.abort();
      }
    } catch (error) {
      if (!(error instanceof ConnectError) || error.code !== Code.Canceled)
        throw error;
      log("RPC canceled; connection remains open");
    }
    log(
      `After cancellation: ${(await client.echo({ text: "still connected" })).text}`,
    );
  } finally {
    await close();
  }
}
