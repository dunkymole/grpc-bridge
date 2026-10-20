import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["package-dist/index.js"],
  bundle: true,
  minify: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  write: false,
});
const bytes = result.outputFiles[0].contents;
const gzipBytes = gzipSync(bytes, { level: 9 }).byteLength;
console.log(
  `Workspace public-entry browser ESM/ES2022 bundle (dependencies included): ${bytes.byteLength} bytes (${(bytes.byteLength / 1024).toFixed(1)} KiB) minified, ${gzipBytes} bytes (${(gzipBytes / 1024).toFixed(1)} KiB) gzip level 9. Release evidence comes from the installed-artifact consumer report.`,
);
