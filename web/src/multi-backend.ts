import { Code, ConnectError } from "@connectrpc/connect";
import { contract as DemoContract } from "./gen/demo_contract.js";
import { openBridgeConnection } from "./index.js";
import { runChecks } from "./verify.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function expectCode(run: () => Promise<unknown>, expected: Code) {
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

export interface MultiBackendFixtureOptions {
  url: string;
  tunnelToken?: string;
  /** Browser-test fault hook. The runnable demo skips only this injected fault. */
  dropTunnel?: (target: "demo" | "dotnet-demo") => void;
}

/** Exercise two strict-contract clients over independent simultaneous tunnels. */
export async function runMultiBackendChecks(
  options: MultiBackendFixtureOptions,
  report: (message: string) => void,
) {
  const [pythonConnection, dotnetConnection] = await Promise.all([
    openBridgeConnection({
      url: options.url,
      target: "demo",
      tunnelToken: options.tunnelToken,
    }),
    openBridgeConnection({
      url: options.url,
      target: "dotnet-demo",
      tunnelToken: options.tunnelToken,
    }),
  ]);
  const python = pythonConnection.client(DemoContract);
  const dotnet = dotnetConnection.client(DemoContract);

  try {
    report("Two independent tunnels open: Python + .NET");
    await Promise.all([
      runChecks(python, (message) => report(`Python · ${message}`), "Python"),
      runChecks(dotnet, (message) => report(`.NET · ${message}`), ".NET"),
    ]);
    report("PASS simultaneous strict-client checks on both backends");

    const abort = new AbortController();
    const canceled = python.echo(
      { text: "cancel only Python", delayMs: 1_000 },
      { signal: abort.signal },
    );
    const dotnetSibling = dotnet.echo({ text: "dotnet sibling", delayMs: 100 });
    setTimeout(() => abort.abort(), 30);
    await Promise.all([
      expectCode(() => canceled, Code.Canceled),
      dotnetSibling.then((reply) =>
        check(reply.text === "dotnet sibling", "dotnet sibling"),
      ),
    ]);
    report("PASS cancellation on Python does not disrupt .NET");

    if (options.dropTunnel) {
      const pythonStream = python
        .count({ number: 20, delayMs: 50 })
        [Symbol.asyncIterator]();
      const dotnetStream = dotnet
        .count({ number: 6, delayMs: 50 })
        [Symbol.asyncIterator]();
      await Promise.all([pythonStream.next(), dotnetStream.next()]);
      options.dropTunnel("demo");
      await expectCode(() => pythonStream.next(), Code.Unavailable);
      const dotnetTicks: number[] = [1];
      for (;;) {
        const next = await dotnetStream.next();
        if (next.done) break;
        dotnetTicks.push(next.value.number);
      }
      check(
        dotnetTicks.join(",") === "1,2,3,4,5,6",
        "dotnet stream after Python loss",
      );
      check(
        (await dotnet.echo({ text: "after peer loss" })).text ===
          "after peer loss",
        "dotnet after peer loss",
      );
      report("PASS connection loss on Python does not disrupt .NET");
    } else {
      report("Connection-loss injection runs in the automated browser suite");
    }

    await pythonConnection.close();
    check(
      (await dotnet.echo({ text: "after Python cleanup" })).text ===
        "after Python cleanup",
      "dotnet after Python cleanup",
    );
    report("PASS cleanup of Python channel does not disrupt .NET");
  } finally {
    await Promise.allSettled([pythonConnection.close(), dotnetConnection.close()]);
  }
}
