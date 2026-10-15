import type { Decision, GuardrailContext } from "../../guardrails/check-tool-call";
import { classifyBash } from "./bash-allowlist";
import { maxRisk } from "./risk-types";

/** What a denied unknown line tells the worker: what works, so it picks the alternative instead of retrying. */
const DENIAL =
  "OUT_OF_ENVELOPE: that shell line is not allowed. The shell takes ONE plain command (no pipe, redirect, `;`, `&&`, quote or $); " +
  "allowed: read tools (ls cat head tail wc grep rg find sed -n diff ...), tests and checks (bun test, bunx tsc --noEmit, biome), " +
  'git status/diff/log/show (`git show REV:path` too)/add/commit -m "msg"/stash/checkout|switch <branch>/checkout -b <new>/' +
  "worktree add <dir under the worktrees dir> <branch>/worktree list. Use the Write/Edit tools for files, DeletePaths to delete, " +
  "GitPush / MergeBranch / CreatePullRequest for push, merge and PR; otherwise report BLOCKED with what you need";

/**
 * Worker / read-only shell: after the deny list, an ALLOWLIST (bash-allowlist.ts). `shellMode: read` allows R0 only;
 * a run with an envelope allows R0 + R1, and a LISTED R2 row (`git reset`, `git restore`, `git branch -D`) only when the envelope
 * grants R2. An unknown line is never allowed, grant or not. A command an effect tool replaces (rm, git push, gh pr create, git merge ...) is never allowed here: the reason names the tool.
 * Returns undefined when the run has neither (the deny list alone decides). Reasons never echo the command.
 */
export function allowlistGate(command: string, ctx: GuardrailContext): Decision | undefined {
  if (!ctx.envelope && ctx.shellMode !== "read") return undefined;
  const v = classifyBash(command, ctx);
  const limit = ctx.shellMode === "read" ? "R0" : "R1";
  if (maxRisk(v.risk, limit) === limit)
    return { decision: "allow", reason: "on the shell allowlist" };
  if (v.use)
    return { decision: "deny", reason: `blocked in the shell: use the ${v.use} tool instead` };
  // A listed R2 row runs only when the envelope grants R2; an unknown line (v.listed unset) never does.
  if (
    v.listed &&
    v.risk === "R2" &&
    ctx.shellMode !== "read" &&
    ctx.envelope?.classes.includes("R2")
  )
    return { decision: "allow", reason: "R2 command granted by the envelope" };
  return {
    decision: "deny",
    reason: v.listed
      ? "OUT_OF_ENVELOPE: this command needs the R2 grant that this plan does not have; report BLOCKED with what you need"
      : DENIAL,
  };
}
