/**
 * Protected-dir rule for search tools (AGENT_HOME, `ctx.denyPaths`): a run whose location is an ANCESTOR of a denied
 * dir (a `$HOME` location) can reach it by a wide Glob/Grep search root. Pure function. The shell is bounded by the OS sandbox.
 */
import { isAbsolute, resolve } from "node:path";
import type { GuardrailContext } from "./check-tool-call";
import { isInside, realOrSame } from "./paths";

type Ctx = Pick<GuardrailContext, "denyPaths" | "allowInside" | "cwd">;

/** Denial reason of a search root or recursive command that would cover a protected dir. */
export const COVERS_PROTECTED_REASON =
  "narrow the search path; it would cover a protected dir (the agent home)";

/** Denied roots that are NOT wholly granted back by `allowInside`. */
const liveRoots = (ctx: Ctx): string[] =>
  (ctx.denyPaths ?? []).filter((d) => !(ctx.allowInside ?? []).some((a) => isInside(a, d)));

/** True when the real path of `dir` is an ancestor-or-equal of a denied root (a search from it would cover it). */
function containsDenied(dir: string, ctx: Ctx): boolean {
  const real = realOrSame(dir);
  return liveRoots(ctx).some((d) => isInside(real, d));
}

/** Glob/Grep: the search root (`path` or the cwd) must not contain a denied root, whatever the pattern. */
export function searchRootDenied(path: unknown, ctx: Ctx): boolean {
  if (!ctx.denyPaths?.length) return false;
  const root = typeof path === "string" && path ? path : ctx.cwd;
  const abs = root && (isAbsolute(root) ? root : ctx.cwd ? resolve(ctx.cwd, root) : undefined);
  return abs ? containsDenied(abs, ctx) : false;
}
