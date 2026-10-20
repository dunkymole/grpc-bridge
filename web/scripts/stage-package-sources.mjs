import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

// Declaration maps need physical sources, not just JS maps' sourcesContent.
// Stage only the compiler-emitted source closure, never demo/generated fixtures.
const sourceRoot = resolve("src");
const stagedRoot = resolve("package-sources");
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!entry.name.endsWith(".map")) continue;
    const map = JSON.parse(await readFile(path, "utf8"));
    if (map.sourceRoot) throw new Error(`Unexpected sourceRoot: ${path}`);
    const staged = [];
    for (const source of map.sources) {
      const original = resolve(dirname(path), source);
      const local = relative(sourceRoot, original);
      if (
        local.startsWith(`..${sep}`) ||
        local === ".." ||
        isAbsolute(local) ||
        resolve(sourceRoot, local) !== original
      )
        throw new Error(`Source map escapes src: ${path}: ${source}`);
      const destination = resolve(stagedRoot, local);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(original, destination);
      staged.push(relative(dirname(path), destination).split(sep).join("/"));
    }
    map.sources = staged;
    await writeFile(path, JSON.stringify(map) + "\n");
  }
}
await visit(resolve("package-dist"));
