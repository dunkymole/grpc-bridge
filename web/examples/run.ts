import { runExamples } from "./client.js";
import { runInterceptorExample } from "./interceptors.js";

// The gateway resolves the "demo" label using its own target policy.
await runExamples(
  process.env.TUNNEL_URL ?? "ws://localhost:8080/tunnel",
  process.env.TUNNEL_TOKEN ?? "",
  console.log,
  process.env.BACKEND_TARGET ?? "demo",
  { forwardToken: process.env.FORWARD_TUNNEL_TOKEN === "true" },
);

await runInterceptorExample(
  process.env.TUNNEL_URL ?? "ws://localhost:8080/tunnel",
  process.env.TUNNEL_TOKEN ?? "",
  process.env.BACKEND_TARGET ?? "demo",
);
