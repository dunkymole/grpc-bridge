import assert from "node:assert/strict";
import { build, version } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
await mkdir("public", { recursive: true });
const result = await build({
  entryPoints: ["browser.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  outfile: "public/bundle.js",
  metafile: true,
  write: false,
});
const inputs = Object.keys(result.metafile.inputs);
assert.ok(
  inputs.some((path) =>
    path.startsWith("node_modules/@dunkymole/grpc-bridge/package-dist/"),
  ),
  "bundle did not use installed package",
);
assert.ok(
  !inputs.some(
    (path) => path.includes("../web/src") || path.startsWith("/src/"),
  ),
  "monorepo source import",
);
for (const file of result.outputFiles)
  await writeFile(file.path, file.contents);
const bytes = result.outputFiles.find((file) =>
  file.path.endsWith("/bundle.js"),
).contents;
const installed = fileURLToPath(import.meta.resolve("@dunkymole/grpc-bridge"));
const entry = await build({
  entryPoints: [installed],
  bundle: true,
  minify: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  write: false,
  metafile: true,
});
const entryOutput = Object.values(entry.metafile.outputs)[0];
assert.deepEqual(
  entryOutput.exports.sort(),
  Object.keys(await import("@dunkymole/grpc-bridge")).sort(),
  "bundle must preserve all public entry exports",
);
assert.ok(
  entryOutput.imports.every((item) => !item.external),
  "bundle must include runtime dependencies",
);
const entryBytes = entry.outputFiles[0].contents;
await writeFile(
  "bundle-report.json",
  JSON.stringify(
    {
      fixtureBundleBytes: bytes.length,
      fixtureBundleGzipBytes: gzipSync(bytes).length,
      fixtureBundleGzipLevel: 6,
      browserEntry: {
        minifiedBytes: entryBytes.length,
        gzipBytes: gzipSync(entryBytes, { level: 9 }).length,
        gzipLevel: 9,
        esbuild: version,
        platform: "browser",
        format: "esm",
        target: "es2022",
        dependenciesBundled: true,
        publicExports: entryOutput.exports,
      },
      bridgeInputs: inputs.filter((path) =>
        path.includes("@dunkymole/grpc-bridge/"),
      ),
    },
    null,
    2,
  ),
);
