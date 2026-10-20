import assert from "node:assert/strict";
import { build } from "esbuild";
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
await writeFile(
  "bundle-report.json",
  JSON.stringify(
    {
      fixtureBundleBytes: bytes.length,
      fixtureBundleGzipBytes: gzipSync(bytes).length,
      bridgeInputs: inputs.filter((path) =>
        path.includes("@dunkymole/grpc-bridge/"),
      ),
    },
    null,
    2,
  ),
);
