import assert from "node:assert/strict";
import { posix } from "node:path";

export const requiredFiles = [
  "package.json",
  "README.md",
  "RETRIES.md",
  "LICENSE",
  "licenses/h2ts-LICENSE-MIT",
  "licenses/h2ts-NOTICE.md",
  "licenses/go-LICENSE",
  "licenses/protobuf-LICENSE",
  "licenses/connect-LICENSE",
  "contracts/runtime-graph-v1.md",
  "contracts/runtime-graph-v1.schema.json",
  "contracts/runtime-graph-v1.conformance.json",
  "contracts/runtime-graph-v1.conformance.proto",
  ...["index", "raw", "codegen"].flatMap((name) =>
    [".js", ".js.map", ".d.ts", ".d.ts.map"].map(
      (ext) => `package-dist/${name}${ext}`,
    ),
  ),
];

export function auditFileList(paths) {
  assert.equal(new Set(paths).size, paths.length, "duplicate packed paths");
  const files = new Set(paths);
  for (const path of paths) {
    assert.ok(
      !path.includes("\\") &&
        !path.startsWith("/") &&
        !path.split("/").includes(".."),
      `unsafe packed path: ${path}`,
    );
    const allowed =
      requiredFiles.includes(path) ||
      /^package-dist\/[\w/-]+\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(path) ||
      /^package-sources\/[\w/-]+\.ts$/.test(path);
    assert.ok(allowed, `unexpected packed file: ${path}`);
    assert.ok(
      !/(?:^|\/)(?:demo|verify)(?:[._/]|$)|(?:^|\/)gen\//.test(path),
      `demo fixture leaked: ${path}`,
    );
  }
  for (const path of requiredFiles)
    assert.ok(files.has(path), `missing packed file: ${path}`);
  for (const path of paths.filter(
    (p) => p.startsWith("package-dist/") && p.endsWith(".js"),
  )) {
    for (const sibling of [
      path + ".map",
      path.replace(/\.js$/, ".d.ts"),
      path.replace(/\.js$/, ".d.ts.map"),
    ])
      assert.ok(files.has(sibling), `missing map/declaration: ${sibling}`);
  }
  return files;
}

export function auditMap(path, map, files) {
  assert.equal(map.version, 3, `invalid source map: ${path}`);
  assert.ok(!map.sourceRoot, `unexpected sourceRoot: ${path}`);
  assert.ok(
    Array.isArray(map.sources) && map.sources.length > 0,
    `missing sources: ${path}`,
  );
  return map.sources.map((source) => {
    assert.ok(
      typeof source === "string" &&
        !source.includes("\\") &&
        !posix.isAbsolute(source),
      `unsafe map source: ${path}`,
    );
    const target = posix.normalize(posix.join(posix.dirname(path), source));
    assert.ok(
      target.startsWith("package-sources/") && files.has(target),
      `unresolved packed source: ${path}: ${source}`,
    );
    return target;
  });
}
