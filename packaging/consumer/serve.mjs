import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { runChecks } from "./compiled/checks.js";
const audit = JSON.parse(
  await readFile("/artifact/package-audit.json", "utf8"),
);
const installed = JSON.parse(
  await readFile("node_modules/@dunkymole/grpc-bridge/package.json", "utf8"),
);
const installedLock = JSON.parse(await readFile("package-lock.json", "utf8"));
const installedResolution =
  installedLock.packages["node_modules/@dunkymole/grpc-bridge"];
const installSource = process.env.PACKAGE_INSTALL_SOURCE ?? "local";
assert.equal(installed.name, audit.name);
assert.equal(installed.version, audit.version);
const checks = await runChecks(
  process.env.TUNNEL_URL,
  process.env.TUNNEL_TOKEN,
);
assert.equal(checks.length, 8);
const bundle = JSON.parse(await readFile("bundle-report.json", "utf8"));
await writeFile(
  "/results/consumer-node.json",
  JSON.stringify(
    {
      status: "PASS",
      node: process.version,
      compilerRevision: process.env.PROTO_CONTRACT_REVISION,
      artifactSha256: audit.sha256,
      packageVersion: installed.version,
      installSource,
      installedResolution: {
        resolved: installedResolution.resolved,
        integrity: installedResolution.integrity,
      },
      checks,
      ...bundle,
    },
    null,
    2,
  ),
);
console.log("Installed-artifact Node checks passed");
const html =
  '<!doctype html><html><head><meta charset="utf-8"><title>Installed package test</title></head><body><script type="module" src="/bundle.js"></script></body></html>';
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://consumer").pathname;
  if (path === "/health") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ artifactSha256: audit.sha256, installSource }),
    );
    return;
  }
  if (path === "/") {
    response.setHeader("content-type", "text/html");
    response.end(html);
    return;
  }
  if (path === "/bundle.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(await readFile("public/bundle.js"));
    return;
  }
  response.writeHead(404).end();
}).listen(8081, "0.0.0.0");
process.once("SIGTERM", () => server.close(() => process.exit(0)));
