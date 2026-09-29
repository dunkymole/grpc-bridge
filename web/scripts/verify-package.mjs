import { access, readdir, readFile } from "node:fs/promises";

const required = [
  "index.js",
  "index.js.map",
  "index.d.ts",
  "index.d.ts.map",
  "raw.js",
  "raw.d.ts",
  "codegen.js",
  "codegen.d.ts",
  "client.js",
  "channel.js",
  "transport.js",
];
await Promise.all(required.map((name) => access(`package-dist/${name}`)));

const files = await readdir("package-dist");
if (files.some((name) => /^(demo|verify)(\.|$)|^gen$/i.test(name))) {
  throw new Error(`Demo-only file emitted in package: ${files.join(", ")}`);
}

const entry = await import(new URL("../package-dist/index.js", import.meta.url));
for (const name of [
  "openBridgeConnection",
  "createBridgeConnection",
  "waitForReady",
  "createSharedBridgeConnection",
  "SharedBridgeConnection",
]) {
  if (!(name in entry)) throw new Error(`Missing strict package export: ${name}`);
}
for (const name of ["openChannel", "createTunnelTransport", "interceptTransport"]) {
  if (name in entry) throw new Error(`Unsafe API is exposed on the main entry: ${name}`);
}

const raw = await import(new URL("../package-dist/raw.js", import.meta.url));
for (const name of ["createTunnelTransport", "interceptTransport", "openChannel"]) {
  if (!(name in raw)) throw new Error(`Missing raw package export: ${name}`);
}
const codegen = await import(new URL("../package-dist/codegen.js", import.meta.url));
if (!("defineContract" in codegen)) throw new Error("Missing codegen entry export");

const declaration = await readFile("package-dist/index.d.ts", "utf8");
if (
  ![
    "BridgeConnectionOptions",
    "BridgeClientOptions",
    "ContractDefinition",
    "RetryOptions",
    "RetryPolicy",
  ].every((name) => declaration.includes(name))
) {
  throw new Error("Strict public declarations were not emitted");
}
if (/readonly transport\s*[:;]/.test(declaration))
  throw new Error("Raw Transport leaked into the strict public declarations");
