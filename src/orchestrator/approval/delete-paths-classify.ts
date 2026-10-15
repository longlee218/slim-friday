import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isSecretPath } from "../../guardrails/deny-dangerous";
import { isInside, realOrSame, resolveReal } from "../../guardrails/paths";
import { foldName, hasGitComponent, isInsideFolded } from "../../guardrails/protected-names";
import type { EffectsCtx } from "./effect-context";

/* Where one DeletePaths target stands relative to the run's envelope. Fail closed: anything unclear is `refused`.
   Names are compared folded (case, unicode): macOS volumes are case-insensitive. */

/** What `classifyPath` found. `dev` + `ino` identify the entry for the re-check just before it moves. */
export type PathKind =
  | { kind: "ok" | "other_location"; real: string; dev: number; ino: number }
  | { kind: "refused" };

/** The on-disk spelling of `name` in `parent` (a case variant on a case-insensitive volume resolves to the real name). */
function diskName(parent: string, name: string): string {
  const names = readdirSync(parent);
  if (names.includes(name)) return name;
  const want = foldName(name);
  return names.find((n) => foldName(n) === want) ?? name;
}

/** Real path of the entry itself (parent resolved with the disk's case, the entry not followed: a link is removed, not its target). */
function entryPath(p: string): string | undefined {
  if (!isAbsolute(p) || p.includes("\0")) return undefined;
  const name = basename(p);
  if (name === "" || name === "." || name === "..") return undefined;
  try {
    const parent = resolveReal(dirname(p));
    const real = join(parent, diskName(parent, name));
    lstatSync(real); // must exist
    return real;
  } catch {
    return undefined;
  }
}

/** Classify one path: protected names (secret, `.git` at any depth, the agent home), the goal dir, a location of the goal or another one. */
export function classifyPath(ctx: EffectsCtx, p: string): PathKind {
  const real = entryPath(p);
  if (!real || isSecretPath(real) || hasGitComponent(real)) return { kind: "refused" };
  const st = lstatSync(real);
  const found = (kind: "ok" | "other_location"): PathKind => ({
    kind,
    real,
    dev: st.dev,
    ino: st.ino,
  });
  const goalDir = realOrSame(ctx.envelope.goalDir);
  if (isInside(goalDir, real)) return real === goalDir ? { kind: "refused" } : found("ok");
  // The agent home (db, memory, trash) and anything above it are never deletable by an agent.
  const home = realOrSame(ctx.agentHome);
  if (isInsideFolded(home, real) || isInsideFolded(real, home)) return { kind: "refused" };
  for (const loc of ctx.locations) {
    const root = realOrSame(loc.path);
    // A location root or anything above it is not a delete target.
    if (isInsideFolded(real, root)) return { kind: "refused" };
    if (!isInsideFolded(root, real)) continue;
    return found(ctx.envelope.locations.includes(loc.name) ? "ok" : "other_location");
  }
  return { kind: "refused" };
}

/** True when `p` still classifies exactly as `before` (same kind, real path, device and inode). */
export function stillSame(ctx: EffectsCtx, p: string, before: PathKind): boolean {
  const now = classifyPath(ctx, p);
  return (
    before.kind !== "refused" &&
    now.kind === before.kind &&
    now.real === before.real &&
    now.dev === before.dev &&
    now.ino === before.ino
  );
}
