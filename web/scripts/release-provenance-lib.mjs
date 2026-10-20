import { execFileSync } from "node:child_process";
export function captureSource(
  run = (args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
) {
  try {
    return {
      revision: run(["rev-parse", "HEAD"]),
      tree: run(["rev-parse", "HEAD^{tree}"]),
      dirty: run(["status", "--porcelain"]).length > 0,
    };
  } catch {
    return null;
  }
}
export function sourceProvenance(before, after) {
  const matchingSnapshots = Boolean(
    before &&
      after &&
      before.revision === after.revision &&
      before.tree === after.tree,
  );
  return {
    revision: before?.revision ?? null,
    tree: before?.tree ?? null,
    afterRevision: after?.revision ?? null,
    afterTree: after?.tree ?? null,
    dirtyBefore: before?.dirty ?? null,
    dirtyAfter: after?.dirty ?? null,
    matchingSnapshots,
    verifiedClean:
      matchingSnapshots && before.dirty === false && after.dirty === false,
  };
}
