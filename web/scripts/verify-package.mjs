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
  "createBridgeConnectionPool",
  "BridgeConnectionPool",
  "openChannel",
  "createTunnelTransport",
  "inputQueue",
]) {
  if (!(name in entry)) throw new Error(`Missing package export: ${name}`);
}

const declaration = await readFile("package-dist/index.d.ts", "utf8");
if (!declaration.includes("BridgeConnectionOptions")) {
  throw new Error("Public declarations were not emitted");
}
