import { rm } from "node:fs/promises";

await rm("package-dist", { recursive: true, force: true });
