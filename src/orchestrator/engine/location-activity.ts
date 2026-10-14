import { realOrSame } from "../../guardrails/paths";

/* Which locations a writing run works in right now (used to tell a busy working dir from a free one). */

/** Locations (real paths) with a writing run in progress, counted. */
const active = new Map<string, number>();

/** True while a writing run works in the location at `path`. */
export const workActiveIn = (path: string): boolean => (active.get(realOrSame(path)) ?? 0) > 0;

/** Mark the location at `path` as worked in; returns the release function (call it when the run ends). */
export function markWorking(path: string): () => void {
  const key = realOrSame(path);
  active.set(key, (active.get(key) ?? 0) + 1);
  return () => active.set(key, (active.get(key) ?? 1) - 1);
}
