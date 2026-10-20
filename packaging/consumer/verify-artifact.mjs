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
// Bind the one local-file dependency to the audited bytes while preserving every
// checked-in external dependency resolution/integrity. No registry bridge lookup.
const consumer = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const bound = bindAuditedArtifact(consumer, lock, manifest, report, bytes);
await writeFile("package.json", JSON.stringify(bound.consumer, null, 2));
await writeFile("package-lock.json", JSON.stringify(bound.lock, null, 2));
console.log(
  `Verified audited artifact ${report.name}@${report.version}: ${report.sha256}`,
);
