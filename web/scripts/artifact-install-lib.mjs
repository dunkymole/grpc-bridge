import assert from "node:assert/strict";
import { createHash } from "node:crypto";
export function bindAuditedArtifact(consumer, lock, manifest, audit, bytes) {
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
  const spec = "file:/artifact/package.tgz";
  boundConsumer.dependencies[manifest.name] = spec;
  boundLock.packages[""].dependencies[manifest.name] = spec;
  boundLock.packages[`node_modules/${manifest.name}`] = {
    version: manifest.version,
    resolved: spec,
    integrity: audit.integrity,
    license: manifest.license,
    dependencies: manifest.dependencies,
    engines: manifest.engines,
  };
  return { consumer: boundConsumer, lock: boundLock };
}
