import { createClient, type Interceptor } from "@connectrpc/connect";
import {
  createSharedBridgeConnection,
  interceptTransport,
} from "../src/index.js";
import { DemoService } from "../src/gen/demo_pb.js";

/** Two client-specific chains and a shared default, using only public bridge APIs. */
export async function runInterceptorExample(
  url: string,
  tunnelToken = "",
  target = "python-demo:50051",
  log: (message: string) => void = console.log,
) {
  const defaults: Interceptor = (next) => async (req) => {
    if (!req.header.has("x-client-name"))
      req.header.set("x-client-name", "shared-default");
    log(
      `${req.method.name}: ${req.header.get("x-proto-contract")} (${req.header.get("x-client-name")})`,
    );
    return next(req);
  };
  const shared = createSharedBridgeConnection({
    url,
    tunnelToken,
    target,
    interceptors: [defaults],
  });
  try {
    const [legacyLease, currentLease] = await Promise.all([
      shared.acquire(),
      shared.acquire(),
    ]);
    try {
      const contract =
        (version: string): Interceptor =>
        (next) =>
        async (req) => {
          req.header.set("x-proto-contract", `demo.echo@${version}`);
          return next(req);
        };
      const legacy = createClient(
        DemoService,
        interceptTransport(legacyLease.transport, {
          baseUrl: `http://${target}`,
          interceptors: [contract("1.0.0")],
        }),
      );
      const current = createClient(
        DemoService,
        interceptTransport(currentLease.transport, {
          baseUrl: `http://${target}`,
          interceptors: [
            contract("2.0.0"),
            (next) => async (req) => {
              req.header.set("x-client-name", "current-ui");
              return next(req);
            },
          ],
        }),
      );
      // The demo accepts both metadata values; it does not enforce contracts.
      const replies = await Promise.all([
        legacy.echo({ text: "legacy client" }),
        current.echo({ text: "current client" }),
      ]);
      log(
        `Shared connection: ${replies.map((reply) => reply.text).join(", ")}`,
      );
    } finally {
      await Promise.all([legacyLease.release(), currentLease.release()]);
    }
  } finally {
    await shared.dispose();
  }
}
