/**
 * EnterWorktree guard: the one worktree rule that outlives the shell policy (the shell is bounded by the OS sandbox).
 */
import { isAbsolute, resolve } from "node:path";
import type { Decision, GuardrailContext } from "./check-tool-call";
import { isInside, realOrSame } from "./paths";

/** Words the guard cannot resolve itself: variable, command substitution, home or brace expansion. */
const EXPANSION = /[$`~{}]/;

/** True when the real path `abs` lies inside one of `roots`. */
const insideAny = (abs: string, roots: string[]): boolean =>
  roots.some((r) => isInside(realOrSame(r), realOrSame(abs)));

/** `put worktrees under <dirs>` denial of the EnterWorktree tool. */
const worktreeDenial = (ctx: GuardrailContext): Decision => ({
  decision: "deny",
  reason: ctx.worktreeDirs?.length
    ? `put worktrees under ${ctx.worktreeDirs.join(", ")} (a literal path, no expansion)`
    : "creating worktrees is not allowed here",
});

/** `path` must be literal and inside `ctx.worktreeDirs` (`base` resolves a relative one). */
export function checkWorktreePath(
  path: string | undefined,
  base: string | undefined,
  ctx: GuardrailContext,
): Decision {
  if (!path || EXPANSION.test(path) || /[*?[]/.test(path)) return worktreeDenial(ctx);
  const abs = isAbsolute(path) ? path : base ? resolve(base, path) : undefined;
  return abs && ctx.worktreeDirs && insideAny(abs, ctx.worktreeDirs)
    ? { decision: "allow", reason: "worktree inside the worktrees dir" }
    : worktreeDenial(ctx);
}
