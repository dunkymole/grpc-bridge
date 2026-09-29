import type { Interceptor } from "@connectrpc/connect";
import {
  createSharedBridgeConnection,
} from "../src/index.js";
import { DemoContract } from "../src/gen/demo_contract.js";

/** Two client-specific chains and a shared default, using only public bridge APIs. */
export async function runInterceptorExample(
  url: string,
  tunnelToken = "",
  target = "python-demo:50051",
  log: (message: string) => void = console.log,
) {
  const defaults: Interceptor = (next) => async (req) => {
    if (!req.header.has("x-request-source"))
      req.header.set("x-request-source", "shared-default");
    log(
      `${req.method.name}: ${req.header.get("x-client-name")} (${req.header.get("x-request-source")})`,
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
    const [workerLease, dashboardLease] = await Promise.all([
      shared.acquire(),
      shared.acquire(),
    ]);
    try {
      const clientLabel =
        (name: string): Interceptor =>
        (next) =>
        async (req) => {
          req.header.set("x-client-name", name);
          return next(req);
        };
      const worker = workerLease.client(DemoContract, {
        interceptors: [clientLabel("background-worker")],
      });
      const dashboard = dashboardLease.client(DemoContract, {
        interceptors: [
          clientLabel("dashboard"),
          (next) => async (req) => {
            req.header.set("x-request-source", "interactive");
            return next(req);
          },
        ],
      });
      // The clients attach independent labels while sharing one connection.
      const replies = await Promise.all([
        worker.echo({ text: "background work" }),
        dashboard.echo({ text: "dashboard request" }),
      ]);
      log(
        `Shared connection: ${replies.map((reply) => reply.text).join(", ")}`,
      );
    } finally {
      await Promise.all([workerLease.release(), dashboardLease.release()]);
    }
  } finally {
    await shared.dispose();
  }
}
