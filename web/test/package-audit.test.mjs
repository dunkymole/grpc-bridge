import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditFileList,
  auditMap,
  requiredFiles,
} from "../scripts/package-audit-lib.mjs";

test("packed allowlist rejects demos, secrets, dependencies and missing notices", () => {
  assert.doesNotThrow(() => auditFileList(requiredFiles));
  for (const extra of [
    "contracts/demo.contract.json",
    "package-dist/demo.js",
    "package-sources/gen/demo_pb.ts",
    ".npmrc",
    "node_modules/secret.js",
    "../outside",
    "package-lock.json",
  ])
    assert.throws(
      () => auditFileList([...requiredFiles, extra]),
      /unexpected|demo|unsafe/,
    );
  assert.throws(
    () =>
      auditFileList(
        requiredFiles.filter((p) => p !== "licenses/h2ts-NOTICE.md"),
      ),
    /missing packed/,
  );
  assert.throws(
    () => auditFileList([...requiredFiles, "package-dist/extra.js"]),
    /missing map/,
  );
});

test("maps must resolve to physically shipped library sources", () => {
  const files = new Set(["package-sources/index.ts"]);
  const map = { version: 3, sources: ["../package-sources/index.ts"] };
  assert.deepEqual(auditMap("package-dist/index.d.ts.map", map, files), [
    "package-sources/index.ts",
  ]);
  for (const source of [
    "../src/index.ts",
    "../../outside.ts",
    "/secret.ts",
    "C:\\secret.ts",
  ])
    assert.throws(() =>
      auditMap(
        "package-dist/index.d.ts.map",
        { ...map, sources: [source] },
        files,
      ),
    );
  assert.throws(() =>
    auditMap(
      "package-dist/index.d.ts.map",
      { ...map, sourceRoot: "/tmp" },
      files,
    ),
  );
});
