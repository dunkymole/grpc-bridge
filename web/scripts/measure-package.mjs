import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["package-dist/index.js"],
  bundle: true,
  minify: true,
  platform: "browser",
  format: "esm",
  write: false,
});
const bytes = result.outputFiles[0].contents;
const gzipBytes = gzipSync(bytes).byteLength;
console.log(
  `Browser bundle: ${(bytes.byteLength / 1024).toFixed(1)} kB minified, ${(gzipBytes / 1024).toFixed(1)} kB gzip`,
);
