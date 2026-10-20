import * as bridge from "@dunkymole/grpc-bridge";
import * as raw from "@dunkymole/grpc-bridge/raw";
import * as codegen from "@dunkymole/grpc-bridge/codegen";
import { Code, ConnectError } from "@connectrpc/connect";
import { contract } from "./gen/demo_contract.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function rejectsCode(run: () => Promise<unknown>, expected: Code) {
  let rejected = false;
  try {
    await run();
  } catch (error) {
    rejected = true;
    check(
      error instanceof ConnectError && error.code === expected,
      `expected status ${expected}: ${error}`,
    );
  }
  check(rejected, `expected rejection ${expected}`);
}

export async function runChecks(url: string, token: string) {
  const passed: string[] = [];
  check(
    !("openChannel" in bridge) && !("createTunnelTransport" in bridge),
    "unsafe main export",
  );
  check(
    typeof raw.openChannel === "function" &&
      typeof codegen.defineContract === "function",
    "missing subpath exports",
  );
  passed.push("installed public exports");
  const connection = await bridge.openBridgeConnection({
    url,
    target: "demo",
    tunnelToken: token,
  });
  try {
    check(!("transport" in connection), "raw transport exposed");
    // @ts-expect-error the installed declarations must not expose transport
    void connection.transport;
    let rejected = false;
    try {
      // @ts-expect-error the installed declarations require a generated contract
      connection.client({});
    } catch {
      rejected = true;
    }
    check(rejected, "forged contract accepted");
    const client = connection.client(contract);
    passed.push("generated strict construction and declarations");

    let trailer = "";
    const reply = await client.echo(
      { text: "installed artifact ✓" },
      {
        timeoutMs: 5000,
        onTrailer: (value) => {
          trailer = value.get("demo-trailer") ?? "";
        },
      },
    );
    check(
      reply.text === "installed artifact ✓" && trailer === "echo-complete",
      "unary/trailers",
    );
    passed.push("unary and trailers");

    const ticks: number[] = [];
    for await (const tick of client.count({ number: 3 }, { timeoutMs: 5000 }))
      ticks.push(tick.number);
    check(ticks.join(",") === "1,2,3", "server stream");
    passed.push("server streaming");
    const sum = await client.collect(
      (async function* () {
        for (const number of [1, 2, 3]) yield { number };
      })(),
      { timeoutMs: 5000 },
    );
    check(
      sum.number === 6 && sum.text === "collected 3 messages",
      "client stream",
    );
    passed.push("client streaming");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const chat = client
        .chat(
          (async function* () {
            yield { text: "first", number: 1 };
            await gate;
            yield { text: "second", number: 2 };
          })(),
          { timeoutMs: 5000 },
        )
        [Symbol.asyncIterator]();
      check(
        (await chat.next()).value?.text === "Python received: first",
        "bidi response before half-close",
      );
      release();
      check(
        (await chat.next()).value?.text === "Python received: second",
        "bidi second response",
      );
      check((await chat.next()).done, "bidi completion");
    } finally {
      release();
    }
    passed.push("live bidi before request half-close");

    await rejectsCode(
      () => client.echo({ delayMs: 100 }, { timeoutMs: 5 }),
      Code.DeadlineExceeded,
    );
    passed.push("deadline");
    const abort = new AbortController();
    const stream = client
      .count(
        { number: 100, delayMs: 20 },
        { signal: abort.signal, timeoutMs: 5000 },
      )
      [Symbol.asyncIterator]();
    check(
      (await stream.next()).value?.number === 1,
      "cancel stream initial response",
    );
    abort.abort();
    await rejectsCode(() => stream.next(), Code.Canceled);
    passed.push("cancellation");
    return passed;
  } finally {
    await connection.close();
  }
}
