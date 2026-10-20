import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { auditFileList } from "./package-audit-lib.mjs";
export const expectedChecks = [
  "installed public exports",
  "generated strict construction and declarations",
  "unary and trailers",
  "server streaming",
  "client streaming",
  "live bidi before request half-close",
  "deadline",
  "cancellation",
];
export function verifyReleaseEvidence(
  { audit, node, browsers, bytes, manifest, paths },
  { revision, compilerRevision, installSource = "local" },
) {
  assert.match(revision, /^[a-f0-9]{40}$/, "full source revision required");
  assert.equal(audit.name, "@dunkymole/grpc-bridge");
  assert.equal(audit.mapsAndSourcesVerified, true);
  assert.equal(manifest.name, audit.name);
  assert.equal(manifest.version, audit.version);
  assert.equal(manifest.type, "module");
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    ".",
    "./codegen",
    "./raw",
  ]);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), audit.sha256);
  assert.equal(
    "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    audit.integrity,
  );
  assert.equal(bytes.length, audit.compressedBytes);
  auditFileList(paths);
  assert.deepEqual(
    [...paths].sort(),
    audit.files.map((file) => file.path).sort(),
  );
  assert.equal(paths.length, audit.fileCount);
  assert.equal(
    audit.source?.verifiedClean,
    true,
    "source provenance is missing or dirty",
  );
  assert.equal(audit.source.revision, revision);
  assert.equal(audit.source.afterRevision, revision);
  assert.match(audit.source.tree, /^[a-f0-9]{40}$/);
  assert.equal(audit.source.afterTree, audit.source.tree);
  assert.equal(audit.source.dirtyBefore, false);
  assert.equal(audit.source.dirtyAfter, false);
  assert.match(audit.packageLockSha256, /^[a-f0-9]{64}$/);
  assert.ok(
    Number(audit.toolchain?.node?.match(/^v(\d+)\./)?.[1]) >= 24,
    "unverified build runtime",
  );
  assert.match(audit.toolchain.npm, /^\d+\.\d+\.\d+/);
  assert.match(audit.toolchain.typescript, /^\d+\.\d+\.\d+/);
  assert.equal(node.status, "PASS");
  assert.equal(node.artifactSha256, audit.sha256);
  assert.equal(node.packageVersion, audit.version);
  assert.equal(node.compilerRevision, compilerRevision);
  assert.deepEqual(node.checks, expectedChecks);
  assert.ok(["local", "registry"].includes(installSource));
  assert.equal(node.installSource, installSource);
  assert.equal(node.installedResolution?.integrity, audit.integrity);
  if (installSource === "local")
    assert.equal(
      node.installedResolution.resolved,
      "file:/artifact/package.tgz",
    );
  else {
    const url = new URL(node.installedResolution.resolved);
    assert.ok(
      url.protocol === "https:" &&
        url.hostname === "registry.npmjs.org" &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.startsWith("/@dunkymole/grpc-bridge/-/"),
    );
  }
  assert.equal(node.browserEntry?.dependenciesBundled, true);
  assert.equal(node.browserEntry.platform, "browser");
  assert.equal(node.browserEntry.format, "esm");
  assert.equal(node.browserEntry.target, "es2022");
  assert.equal(node.browserEntry.gzipLevel, 9);
  assert.match(node.browserEntry.esbuild, /^\d+\.\d+\.\d+/);
  assert.ok(
    Array.isArray(node.browserEntry.publicExports) &&
      node.browserEntry.publicExports.length > 0,
  );
  assert.ok(
    node.browserEntry.minifiedBytes > 0 && node.browserEntry.gzipBytes > 0,
  );
  assert.equal(browsers.status, "PASS");
  assert.equal(browsers.artifactSha256, audit.sha256);
  assert.equal(browsers.installSource, installSource);
  assert.deepEqual(
    browsers.results.map((result) => result.name),
    ["chromium", "firefox", "webkit"],
  );
  for (const result of browsers.results) {
    assert.equal(result.status, "PASS");
    assert.ok(result.version);
    assert.deepEqual(result.checks, expectedChecks);
  }
  return {
    status: "PASS",
    meaning:
      "Integrity and retained test evidence only; NOT publication authorization",
    sourceRevision: revision,
    name: audit.name,
    version: audit.version,
    sha256: audit.sha256,
    integrity: audit.integrity,
    compressedBytes: audit.compressedBytes,
    unpackedBytes: audit.unpackedBytes,
    installSource,
    browserEntry: node.browserEntry,
  };
}
