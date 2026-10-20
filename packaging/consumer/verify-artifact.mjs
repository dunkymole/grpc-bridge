import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { bindAuditedArtifact } from "./artifact-install-lib.mjs";
const report = JSON.parse(
  await readFile("/artifact/package-audit.json", "utf8"),
);
const bytes = await readFile("/artifact/package.tgz");
const manifest = JSON.parse(
  execFileSync(
    "tar",
    ["-xOzf", "/artifact/package.tgz", "package/package.json"],
    { encoding: "utf8" },
  ),
);
// Default to the audited local file; the explicit registry mode is a read-only
// post-publication gate. Preserve every external dependency resolution/integrity.
const consumer = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const installSource = process.env.PACKAGE_INSTALL_SOURCE ?? "local";
let registryMetadata;
if (installSource === "registry") {
  const response = await fetch(
    `https://registry.npmjs.org/@dunkymole%2fgrpc-bridge/${encodeURIComponent(report.version)}`,
  );
  if (!response.ok)
    throw new Error(
      `Public registry verification failed: HTTP ${response.status}`,
    );
  registryMetadata = await response.json();
}
const bound = bindAuditedArtifact(consumer, lock, manifest, report, bytes, {
  installSource,
  registryMetadata,
});
await writeFile("package.json", JSON.stringify(bound.consumer, null, 2));
await writeFile("package-lock.json", JSON.stringify(bound.lock, null, 2));
console.log(
  `Verified audited artifact ${report.name}@${report.version}: ${report.sha256}`,
);
