import { Code, ConnectError, type Client } from "@connectrpc/connect";
import { DemoService, type Message } from "./gen/demo_pb.js";
import { inputQueue } from "./queue.js";
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function code(run: () => Promise<unknown>, expected: Code) {
  try {
    await run();
  } catch (error) {
    check(
      error instanceof ConnectError && error.code === expected,
      `Expected ${expected}, got ${error}`,
    );
    return;
  }
  throw new Error(`Expected gRPC error ${expected}`);
}
export async function runChecks(
  client: Client<typeof DemoService>,
  report: (message: string) => void,
  backendName = "Python",
) {
  let trailer = "";
  const echo = await client.echo(
    { text: `browser → ${backendName} ✓` },
    { onTrailer: (t) => (trailer = t.get("demo-trailer") ?? "") },
  );
  check(
    echo.text === `browser → ${backendName} ✓` && trailer === "echo-complete",
    "echo/trailers",
  );
  report("PASS unary protobuf + trailers");
  const ticks: number[] = [];
  for await (const tick of client.count({ number: 4, delayMs: 10 }))
    ticks.push(tick.number);
  check(ticks.join(",") === "1,2,3,4", "server stream");
  report("PASS server streaming");
  const sum = await client.collect(
    (async function* () {
      for (let number = 1; number <= 5; number++) yield { number };
    })(),
  );
  check(sum.number === 15, "client stream");
  report("PASS client streaming + half-close");
  const queue = inputQueue<Partial<Omit<Message, "$typeName" | "$unknown">>>();
  const replies = client.chat(queue.messages)[Symbol.asyncIterator]();
  let first = replies.next();
  await queue.send({ text: "one" });
  check(
    (await first).value?.text === `${backendName} received: one`,
    "first bidi response before half-close",
  );
  first = replies.next();
  await queue.send({ text: "two" });
  check(
    (await first).value?.text === `${backendName} received: two`,
    "second bidi response",
  );
  await queue.complete();
  check((await replies.next()).done, "bidi trailers");
  report("PASS live bidi: replies arrive before request half-close");
  const concurrent = await Promise.all(
    Array.from({ length: 16 }, (_, number) =>
      client.echo({ number, delayMs: 20 }),
    ),
  );
  check(
    concurrent.every((r, i) => r.number === i),
    "multiplex",
  );
  report("PASS 16 concurrent RPCs on the same connection");
  const large = "x".repeat(180000);
  check((await client.echo({ text: large })).text === large, "flow control");
  report("PASS 180 KB message across HTTP/2 flow-control windows");
  await code(() => client.echo({ text: "error" }), Code.InvalidArgument);
  report("PASS native error status");
  await code(
    () => client.echo({ delayMs: 1000 }, { timeoutMs: 40 }),
    Code.DeadlineExceeded,
  );
  report("PASS deadline");
  const abort = new AbortController();
  const pending = client.echo({ delayMs: 1000 }, { signal: abort.signal });
  setTimeout(() => abort.abort(), 30);
  await code(() => pending, Code.Canceled);
  check(
    (await client.echo({ text: "still open" })).text === "still open",
    "cancel closed shared channel",
  );
  report("PASS cancellation keeps sibling RPCs working");
}
