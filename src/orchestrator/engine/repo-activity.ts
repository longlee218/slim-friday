import { realOrSame } from "../../guardrails/paths";
import { isManagedClone, refreshRepo } from "../../repos/refresh-repo";
import type { Repo } from "../../repos/repo-registry";

/* Which repos a writing run works in right now: the side lane must not fetch/pull under a working agent. */

/** Repos (real paths) with a writing run in progress, counted. */
const active = new Map<string, number>();

/** True while a writing run works in the repo at `path`. */
export const workActiveIn = (path: string): boolean => (active.get(realOrSame(path)) ?? 0) > 0;

/** Mark the repo at `path` as worked in; returns the release function (call it when the run ends). */
export function markWorking(path: string): () => void {
  const key = realOrSame(path);
  active.set(key, (active.get(key) ?? 0) + 1);
  return () => active.set(key, (active.get(key) ?? 1) - 1);
}

/** Refresh the managed clones in `repos` (never a developer's working copy, nor a repo a writing run works in). */
export async function refreshManaged(repos: Repo[], agentHome: string): Promise<void> {
  await Promise.all(
    repos
      .filter((r) => isManagedClone(r.path, agentHome) && !workActiveIn(r.path))
      .map((r) => refreshRepo(r.path)),
  );
}
