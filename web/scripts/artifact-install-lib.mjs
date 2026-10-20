import assert from "node:assert/strict";
import { createHash } from "node:crypto";
export function bindAuditedArtifact(
  consumer,
  lock,
  manifest,
  audit,
  bytes,
  options = {},
) {
  assert.equal(consumer.private, true, "consumer fixture must remain private");
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(audit.mapsAndSourcesVerified, true);
  assert.equal(audit.name, "@dunkymole/grpc-bridge");
  assert.equal(manifest.name, audit.name);
  assert.equal(manifest.version, audit.version);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), audit.sha256);
  assert.equal(
    "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    audit.integrity,
  );
  assert.deepEqual(
    manifest.dependencies,
    consumer.dependencies,
    "runtime dependency bounds need review",
  );
  assert.ok(
    !lock.packages[`node_modules/${manifest.name}`],
    "fixture already contains a bridge resolution",
  );
  for (const [name, version] of Object.entries(manifest.dependencies))
    assert.equal(
      lock.packages[`node_modules/${name}`]?.version,
      version,
      `unreviewed runtime dependency: ${name}`,
    );
  const boundConsumer = structuredClone(consumer);
  const boundLock = structuredClone(lock);
  const installSource = options.installSource ?? "local";
  assert.ok(
    ["local", "registry"].includes(installSource),
    "unknown installation source",
  );
  let resolved = "file:/artifact/package.tgz";
  if (installSource === "registry") {
    const published = options.registryMetadata;
    assert.equal(published?.name, manifest.name, "registry package mismatch");
    assert.equal(
      published?.version,
      manifest.version,
      "registry version mismatch",
    );
    assert.deepEqual(
      published.dependencies,
      manifest.dependencies,
      "registry dependency mismatch",
    );
    assert.equal(
      published.dist?.integrity,
      audit.integrity,
      "registry bytes differ from audited artifact",
    );
    const url = new URL(published.dist.tarball);
    assert.ok(
      url.protocol === "https:" &&
        url.hostname === "registry.npmjs.org" &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.startsWith("/@dunkymole/grpc-bridge/-/"),
      "unexpected registry tarball location",
    );
    resolved = url.href;
  }
  const spec = installSource === "registry" ? manifest.version : resolved;
  boundConsumer.dependencies[manifest.name] = spec;
  boundLock.packages[""].dependencies[manifest.name] = spec;
  boundLock.packages[`node_modules/${manifest.name}`] = {
    version: manifest.version,
    resolved,
    integrity: audit.integrity,
    license: manifest.license,
    dependencies: manifest.dependencies,
    engines: manifest.engines,
  };
  return { consumer: boundConsumer, lock: boundLock };
}
