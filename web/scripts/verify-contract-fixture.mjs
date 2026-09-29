import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const version = execFileSync("protoc", ["--version"], { encoding: "utf8" }).trim();
if (version !== "libprotoc 31.1")
  throw new Error(`Conformance source is pinned to protoc 31.1, found ${version}`);

const output = await mkdtemp(join(tmpdir(), "grpc-bridge-es-fixture-"));
try {
  const plugin = join(output, "protoc-gen-es");
  const executable = resolve("node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es");
  await writeFile(plugin, `#!/bin/sh\nexec node "${executable}" "$@"\n`);
  await chmod(plugin, 0o755);
  execFileSync("protoc", [
    "-Icontracts",
    `--plugin=protoc-gen-es=${plugin}`,
    `--es_out=${output}`,
    "--es_opt=target=ts",
    "contracts/runtime-graph-v1.conformance.proto",
  ], { stdio: "inherit" });
  const generated = normalize(await readFile(join(output, "runtime-graph-v1.conformance_pb.ts"), "utf8"));
  const checkedIn = normalize(await readFile("contracts/gen/runtime-graph-v1.conformance_pb.ts", "utf8"));
  if (generated !== checkedIn)
    throw new Error("Protobuf-ES conformance output is stale; regenerate contracts/gen/runtime-graph-v1.conformance_pb.ts");
} finally {
  await rm(output, { recursive: true, force: true });
}

function normalize(source) {
  return source.replace(/\r\n/g, "\n").replace(/\n+$/, "\n");
}
