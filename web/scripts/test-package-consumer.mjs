import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(root, "web/test-results/package");
const audit = JSON.parse(
  await readFile(join(output, "package-audit.json"), "utf8"),
);
assert.match(audit.artifact, /^dunkymole-grpc-bridge-[\w.+-]+\.tgz$/);
const artifact = join(output, audit.artifact);
assert.equal(
  createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex"),
  audit.sha256,
);
const staging = await mkdtemp(join(tmpdir(), "grpc-bridge-consumer-"));
const project = "grpc-bridge-package-" + randomUUID().slice(0, 8);
const env = { ...process.env, PACKAGE_ARTIFACT_DIR: staging };
const args = [
  "compose",
  "--project-name",
  project,
  "-f",
  "compose.package.yaml",
];
const docker = (...extra) =>
  execFileSync("docker", [...args, ...extra], {
    cwd: root,
    env,
    stdio: "inherit",
    timeout: 900000,
  });
let failure;
try {
  await copyFile(artifact, join(staging, "package.tgz"));
  await copyFile(
    join(output, "package-audit.json"),
    join(staging, "package-audit.json"),
  );
  // Stale previous reports must not make a failed build appear successful.
  for (const name of ["consumer-node.json", "consumer-browsers.json"])
    await rm(join(output, name), { force: true });
  const config = JSON.parse(
    execFileSync("docker", [...args, "config", "--format", "json"], {
      cwd: root,
      env,
      encoding: "utf8",
    }),
  );
  assert.equal(
    (config.services.bridge.ports ?? []).length,
    0,
    "fixture must not publish host ports",
  );
  docker(
    "up",
    "--build",
    "--abort-on-container-exit",
    "--exit-code-from",
    "package-browser",
  );
  const node = JSON.parse(
    await readFile(join(output, "consumer-node.json"), "utf8"),
  );
  const browsers = JSON.parse(
    await readFile(join(output, "consumer-browsers.json"), "utf8"),
  );
  assert.equal(node.status, "PASS");
  assert.equal(node.artifactSha256, audit.sha256);
  assert.equal(browsers.status, "PASS");
  assert.deepEqual(
    browsers.results.map((result) => result.name),
    ["chromium", "firefox", "webkit"],
  );
  assert.ok(
    browsers.results.every(
      (result) => result.status === "PASS" && result.checks.length === 8,
    ),
  );
  console.log(
    `PASS: exact artifact ${audit.sha256} in Node and all three browsers`,
  );
} catch (error) {
  failure = error;
} finally {
  try {
    docker("down", "--remove-orphans");
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], "Consumer and cleanup failed")
      : error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
if (failure) throw failure;
