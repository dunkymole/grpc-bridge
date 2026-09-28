import { access, readdir, readFile } from "node:fs/promises";

const required = [
  "index.js",
  "index.js.map",
  "index.d.ts",
  "index.d.ts.map",
  "client.js",
  "channel.js",
  "transport.js",
];
await Promise.all(required.map((name) => access(`package-dist/${name}`)));

const files = await readdir("package-dist");
if (files.some((name) => /demo|verify|gen/i.test(name))) {
  throw new Error(`Demo-only file emitted in package: ${files.join(", ")}`);
}

const entry = await import(
  new URL("../package-dist/index.js", import.meta.url)
);
for (const name of [
  "openBridgeConnection",
  "createBridgeConnection",
  "waitForReady",
  "createSharedBridgeConnection",
  "SharedBridgeConnection",
  "openChannel",
  "createTunnelTransport",
  "interceptTransport",
  "inputQueue",
]) {
  if (!(name in entry)) throw new Error(`Missing package export: ${name}`);
}

const declaration = await readFile("package-dist/index.d.ts", "utf8");
if (
  ![
    "BridgeConnectionOptions",
    "InterceptorOptions",
    "RetryOptions",
    "RetryPolicy",
  ].every((name) => declaration.includes(name))
) {
  throw new Error("Public declarations were not emitted");
}
