import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auditFileList, auditMap } from "./package-audit-lib.mjs";
import { captureSource, sourceProvenance } from "./release-provenance-lib.mjs";

assert.ok(process.env.npm_execpath, "run through npm run package:verify");
const beforeSource = captureSource();
if (process.env.PACKAGE_REQUIRE_CLEAN === "1")
  assert.equal(
    beforeSource?.dirty,
    false,
    "release evidence requires a clean Git checkout",
  );
const staging = await mkdtemp(join(tmpdir(), "grpc-bridge-pack-"));
try {
  const [metadata] = JSON.parse(
    execFileSync(
      process.execPath,
      [
        process.env.npm_execpath,
        "pack",
        "--json",
        "--pack-destination",
        staging,
      ],
      { encoding: "utf8" },
    ),
  );
  const tarball = join(staging, metadata.filename);
  const paths = metadata.files.map((file) => file.path).sort();
  const files = auditFileList(paths);
  const actual = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .filter((p) => !p.endsWith("/"));
  assert.deepEqual(
    actual
      .map((p) => {
        assert.ok(p.startsWith("package/"), "unexpected archive root");
        return p.slice(8);
      })
      .sort(),
    paths,
    "tar contents differ from pack manifest",
  );
  const listing = execFileSync("tar", ["-tvzf", tarball], { encoding: "utf8" });
  assert.ok(
    listing
      .trim()
      .split(/\r?\n/)
      .every((line) => /^[d-]/.test(line)),
    "links/special files are forbidden",
  );
  const extracted = join(staging, "extracted");
  await mkdir(extracted);
  execFileSync("tar", ["-xzf", tarball, "-C", extracted]);
  const root = join(extracted, "package");
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "@dunkymole/grpc-bridge");
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    ".",
    "./codegen",
    "./raw",
  ]);
  for (const entry of Object.values(manifest.exports))
    for (const target of [entry.types, entry.import])
      assert.ok(
        files.has(target.replace(/^\.\//, "")),
        `unresolved export: ${target}`,
      );
  const usedSources = new Set();
  for (const path of paths.filter((p) => p.endsWith(".map"))) {
    const map = JSON.parse(await readFile(join(root, path), "utf8"));
    const targets = auditMap(path, map, files);
    for (let i = 0; i < targets.length; i++) {
      usedSources.add(targets[i]);
      const source = await readFile(join(root, targets[i]), "utf8");
      if (map.sourcesContent)
        assert.equal(
          map.sourcesContent[i],
          source,
          `map content mismatch: ${path}`,
        );
    }
  }
  for (const path of paths.filter((p) => p.startsWith("package-sources/")))
    assert.ok(usedSources.has(path), `unreferenced source: ${path}`);
  const bytes = await readFile(tarball);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity =
    "sha512-" + createHash("sha512").update(bytes).digest("base64");
  assert.equal(metadata.integrity, integrity, "npm integrity mismatch");
  const source = sourceProvenance(beforeSource, captureSource());
  if (process.env.PACKAGE_REQUIRE_CLEAN === "1")
    assert.equal(
      source.verifiedClean,
      true,
      "source identity/clean state changed across packing",
    );
  const toolchain = {
    node: process.version,
    npm: execFileSync(
      process.execPath,
      [process.env.npm_execpath, "--version"],
      { encoding: "utf8" },
    ).trim(),
    typescript: JSON.parse(
      await readFile("node_modules/typescript/package.json", "utf8"),
    ).version,
  };
  const output = resolve(
    process.env.PACKAGE_OUTPUT_DIR ?? "test-results/package",
  );
  await mkdir(output, { recursive: true });
  const artifact = metadata.filename.replace(
    /\.tgz$/,
    `-${sha256.slice(0, 12)}.tgz`,
  );
  await copyFile(tarball, join(output, artifact));
  const report = {
    name: manifest.name,
    version: manifest.version,
    artifact,
    sha256,
    integrity,
    compressedBytes: bytes.length,
    unpackedBytes: metadata.unpackedSize,
    fileCount: paths.length,
    mapsAndSourcesVerified: true,
    source,
    toolchain,
    packageLockSha256: createHash("sha256")
      .update(await readFile("package-lock.json"))
      .digest("hex"),
    ci:
      process.env.GITHUB_ACTIONS === "true"
        ? {
            repository: process.env.GITHUB_REPOSITORY,
            runId: process.env.GITHUB_RUN_ID,
            event: process.env.GITHUB_EVENT_NAME,
            ref: process.env.GITHUB_REF,
          }
        : null,
    files: metadata.files,
  };
  await writeFile(
    join(output, "package-audit.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify({ ...report, files: undefined }, null, 2));
} finally {
  await rm(staging, { recursive: true, force: true });
}
