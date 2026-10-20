import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { verifyReleaseEvidence } from "./release-preflight-lib.mjs";
const { values } = parseArgs({
  options: {
    revision: { type: "string" },
    "compiler-revision": { type: "string" },
    "read-only": { type: "boolean", default: false },
    directory: { type: "string", default: "test-results/package" },
  },
});
assert.match(
  values.revision ?? "",
  /^[a-f0-9]{40}$/,
  "provide --revision with the independently verified source commit",
);
const directory = resolve(values.directory);
const json = async (name) =>
  JSON.parse(await readFile(join(directory, name), "utf8"));
const audit = await json("package-audit.json");
assert.match(audit.artifact, /^dunkymole-grpc-bridge-[\w.+-]+\.tgz$/);
const artifact = join(directory, audit.artifact);
const manifest = JSON.parse(
  execFileSync("tar", ["-xOzf", artifact, "package/package.json"], {
    encoding: "utf8",
  }),
);
const paths = execFileSync("tar", ["-tzf", artifact], { encoding: "utf8" })
  .trim()
  .split(/\r?\n/)
  .filter((path) => !path.endsWith("/"))
  .map((path) => {
    assert.ok(path.startsWith("package/"));
    return path.slice(8);
  });
const workflow = await readFile(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../.github/workflows/ci.yml",
  ),
  "utf8",
);
const compilerRevision =
  values["compiler-revision"] ??
  workflow.match(/PROTO_CONTRACT_REVIEWED_REF:\s*([a-f0-9]{40})/)?.[1];
assert.ok(compilerRevision, "reviewed compiler pin missing from CI");
assert.match(compilerRevision, /^[a-f0-9]{40}$/);
const result = verifyReleaseEvidence(
  {
    audit,
    node: await json("consumer-node.json"),
    browsers: await json("consumer-browsers.json"),
    bytes: await readFile(artifact),
    manifest,
    paths,
  },
  {
    revision: values.revision,
    compilerRevision,
    installSource: process.env.PACKAGE_INSTALL_SOURCE ?? "local",
  },
);
if (!values["read-only"])
  await writeFile(
    join(directory, "release-preflight.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
console.log(JSON.stringify(result, null, 2));
