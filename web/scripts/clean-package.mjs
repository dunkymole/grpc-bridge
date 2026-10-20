import { rm } from "node:fs/promises";

await rm("package-dist", { recursive: true, force: true });
await rm("package-sources", { recursive: true, force: true });
