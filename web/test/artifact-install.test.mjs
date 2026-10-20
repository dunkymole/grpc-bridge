import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { bindAuditedArtifact } from "../scripts/artifact-install-lib.mjs";
function fixture() {
  const bytes = Buffer.from("an exact audited archive");
  const dependencies = {
    "@bufbuild/protobuf": "2.15.0",
    "@connectrpc/connect": "2.2.0",
  };
  const manifest = {
    name: "@dunkymole/grpc-bridge",
    version: "0.2.0",
    license: "MIT",
    dependencies,
    engines: { node: ">=24" },
  };
  const consumer = { private: true, dependencies };
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies },
      ...Object.fromEntries(
        Object.entries(dependencies).map(([name, version]) => [
          `node_modules/${name}`,
          { version, integrity: "retained-external-integrity" },
        ]),
      ),
    },
  };
  const audit = {
    name: manifest.name,
    version: manifest.version,
    mapsAndSourcesVerified: true,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
  };
  return { consumer, lock, manifest, audit, bytes };
}
test("consumer binds the exact local archive without unlocking external packages", () => {
  const f = fixture();
  const original = structuredClone(f);
  const bound = bindAuditedArtifact(
    f.consumer,
    f.lock,
    f.manifest,
    f.audit,
    f.bytes,
  );
  assert.equal(
    bound.consumer.dependencies[f.manifest.name],
    "file:/artifact/package.tgz",
  );
  assert.equal(
    bound.lock.packages[`node_modules/${f.manifest.name}`].integrity,
    f.audit.integrity,
  );
  for (const name of Object.keys(f.consumer.dependencies))
    assert.deepEqual(
      bound.lock.packages[`node_modules/${name}`],
      f.lock.packages[`node_modules/${name}`],
    );
  assert.deepEqual(f.consumer, original.consumer);
  assert.deepEqual(f.lock, original.lock);
});
test("consumer rejects tampering, unreviewed bounds and stale resolutions", () => {
  for (const change of [
    (f) => {
      f.bytes = Buffer.from("modified archive");
    },
    (f) => {
      f.audit.integrity = "sha512-wrong";
    },
    (f) => {
      f.manifest.version = "9.0.0";
    },
    (f) => {
      f.manifest.dependencies = { ...f.manifest.dependencies, extra: "1.0.0" };
    },
    (f) => {
      f.lock.packages["node_modules/@bufbuild/protobuf"].version = "2.16.0";
    },
    (f) => {
      f.lock.packages["node_modules/@dunkymole/grpc-bridge"] = {
        version: "0.1.0",
      };
    },
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() =>
      bindAuditedArtifact(f.consumer, f.lock, f.manifest, f.audit, f.bytes),
    );
  }
});
test("registry postflight uses exact public registry resolution and expected integrity", () => {
  const f = fixture();
  const registryMetadata = {
    ...f.manifest,
    dist: {
      integrity: f.audit.integrity,
      tarball:
        "https://registry.npmjs.org/@dunkymole/grpc-bridge/-/grpc-bridge-0.2.0.tgz",
    },
  };
  const options = { installSource: "registry", registryMetadata };
  const bound = bindAuditedArtifact(
    f.consumer,
    f.lock,
    f.manifest,
    f.audit,
    f.bytes,
    options,
  );
  assert.equal(bound.consumer.dependencies[f.manifest.name], "0.2.0");
  assert.equal(
    bound.lock.packages[`node_modules/${f.manifest.name}`].resolved,
    registryMetadata.dist.tarball,
  );
  for (const change of [
    (m) => {
      m.version = "0.1.0";
    },
    (m) => {
      m.dist.integrity = "sha512-wrong";
    },
    (m) => {
      m.dependencies = {};
    },
    (m) => {
      m.dist.tarball = "file:/artifact/package.tgz";
    },
    (m) => {
      m.dist.tarball = "https://example.com/other.tgz";
    },
    (m) => {
      m.dist.tarball =
        "https://token@registry.npmjs.org/@dunkymole/grpc-bridge/-/pkg.tgz";
    },
  ]) {
    const metadata = structuredClone(registryMetadata);
    change(metadata);
    assert.throws(() =>
      bindAuditedArtifact(f.consumer, f.lock, f.manifest, f.audit, f.bytes, {
        installSource: "registry",
        registryMetadata: metadata,
      }),
    );
  }
  assert.throws(() =>
    bindAuditedArtifact(f.consumer, f.lock, f.manifest, f.audit, f.bytes, {
      installSource: "unknown",
    }),
  );
});
