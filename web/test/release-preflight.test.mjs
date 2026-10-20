import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { requiredFiles } from "../scripts/package-audit-lib.mjs";
import {
  captureSource,
  sourceProvenance,
} from "../scripts/release-provenance-lib.mjs";
import {
  expectedChecks,
  verifyReleaseEvidence,
} from "../scripts/release-preflight-lib.mjs";
const revision = "a".repeat(40),
  tree = "b".repeat(40),
  compilerRevision = "c".repeat(40);
test("source snapshots reject unknown, dirty and changed checkouts", () => {
  const clean = { revision, tree, dirty: false };
  assert.equal(sourceProvenance(clean, clean).verifiedClean, true);
  for (const [before, after] of [
    [null, null],
    [{ ...clean, dirty: true }, clean],
    [clean, { ...clean, dirty: true }],
    [clean, { ...clean, revision: tree }],
    [clean, { ...clean, tree: revision }],
  ])
    assert.equal(sourceProvenance(before, after).verifiedClean, false);
  assert.equal(
    captureSource(() => {
      throw new Error("no Git");
    }),
    null,
  );
});
function fixture() {
  const bytes = Buffer.from("an audited release artifact");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity =
    "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const audit = {
    name: "@dunkymole/grpc-bridge",
    version: "0.2.0",
    sha256,
    integrity,
    compressedBytes: bytes.length,
    unpackedBytes: 100,
    mapsAndSourcesVerified: true,
    files: requiredFiles.map((path) => ({ path })),
    fileCount: requiredFiles.length,
    source: sourceProvenance(
      { revision, tree, dirty: false },
      { revision, tree, dirty: false },
    ),
    packageLockSha256: "d".repeat(64),
    toolchain: { node: "v24.21.0", npm: "11.19.0", typescript: "5.9.3" },
  };
  const manifest = {
    name: audit.name,
    version: audit.version,
    type: "module",
    exports: { ".": {}, "./raw": {}, "./codegen": {} },
  };
  const node = {
    status: "PASS",
    artifactSha256: sha256,
    packageVersion: audit.version,
    compilerRevision,
    checks: [...expectedChecks],
    installSource: "local",
    installedResolution: { resolved: "file:/artifact/package.tgz", integrity },
    browserEntry: {
      esbuild: "0.28.2",
      publicExports: ["openBridgeConnection"],
      minifiedBytes: 100,
      gzipBytes: 50,
      gzipLevel: 9,
      dependenciesBundled: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
    },
  };
  const browsers = {
    status: "PASS",
    artifactSha256: sha256,
    installSource: "local",
    results: ["chromium", "firefox", "webkit"].map((name) => ({
      name,
      version: "tested",
      status: "PASS",
      checks: [...expectedChecks],
    })),
  };
  return { audit, node, browsers, bytes, manifest, paths: [...requiredFiles] };
}
test("preflight binds bytes, clean reviewed source and complete runtime evidence", () => {
  const result = verifyReleaseEvidence(fixture(), {
    revision,
    compilerRevision,
  });
  assert.equal(result.status, "PASS");
  assert.match(result.meaning, /NOT publication authorization/);
});
test("preflight fails closed on missing, mismatched or partial evidence", () => {
  for (const change of [
    (f) => {
      f.bytes = Buffer.from("tampered");
    },
    (f) => {
      f.audit.source.verifiedClean = false;
    },
    (f) => {
      f.audit.source.afterRevision = tree;
    },
    (f) => {
      f.node.artifactSha256 = "wrong";
    },
    (f) => {
      f.browsers.artifactSha256 = "wrong";
    },
    (f) => {
      f.node.compilerRevision = tree;
    },
    (f) => {
      f.node.installedResolution.integrity = "wrong";
    },
    (f) => {
      f.node.checks.pop();
    },
    (f) => {
      f.browsers.results.pop();
    },
    (f) => {
      f.browsers.results[1].status = "FAIL";
    },
    (f) => {
      f.node.browserEntry.dependenciesBundled = false;
    },
    (f) => {
      f.paths.push(".npmrc");
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() =>
      verifyReleaseEvidence(f, { revision, compilerRevision }),
    );
  }
});
test("registry preflight requires registry resolution, not a reused local installation", () => {
  const f = fixture();
  f.node.installSource = "registry";
  f.browsers.installSource = "registry";
  const options = { revision, compilerRevision, installSource: "registry" };
  assert.throws(() => verifyReleaseEvidence(f, options));
  f.node.installedResolution.resolved =
    "https://registry.npmjs.org/@dunkymole/grpc-bridge/-/grpc-bridge-0.2.0.tgz";
  assert.equal(verifyReleaseEvidence(f, options).installSource, "registry");
  f.node.installedResolution.resolved = "https://example.com/other.tgz";
  assert.throws(() => verifyReleaseEvidence(f, options));
});
