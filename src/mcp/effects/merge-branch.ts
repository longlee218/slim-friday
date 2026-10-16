import type { Reply } from "../../orchestrator/engine/lead-call";
import { checkEnvelope, grantNamesBranch } from "../../policy/check-envelope";
import {
  type EffectsCtx,
  locationPath,
  recordEffect,
  refuseLogged,
  safeText,
} from "../../policy/effect-context";
import { isPlainRef } from "./git-run";
import { MERGE_BRANCH_TOOL } from "./tools/MergeBranchTool/constants";

/* MergeBranch: a local merge of `from` into the checked-out branch `into` (R2). `into` must be covered by a grant. */

/** Handle one `MergeBranch` call. */
export async function mergeBranch(
  ctx: EffectsCtx,
  input: { location: string; from: string; into: string },
): Promise<Reply> {
  const { location, from, into } = input;
  const scope = `${location} ${from} -> ${into}`;
  const refused = (code: string, message: string) =>
    refuseLogged(ctx, MERGE_BRANCH_TOOL, scope, code, message);
  if (!isPlainRef(from) || !isPlainRef(into))
    return refused("BAD_REF", "Branch names must be plain names.");
  const verdict = checkEnvelope({ tool: MERGE_BRANCH_TOOL, location, into }, ctx.envelope);
  if (!verdict.allow && verdict.code !== "R4") return refused(verdict.code, verdict.reason);
  const cwd = locationPath(ctx, location);
  if (!cwd) return refused("OUT_OF_ENVELOPE", "Unknown location.");
  // The merge lands on the checked-out branch: it must be the one the grant names (no hidden checkout).
  const head = await ctx.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (head.code !== 0 || head.out.trim() !== into)
    return refused("WRONG_BRANCH", "The location must have the target branch checked out first.");
  // A merge already in progress is the owner's or an earlier step's: this call neither continues nor aborts it.
  const pending = await ctx.run(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd);
  if (pending.code === 0)
    return refused("MERGE_IN_PROGRESS", "A merge is already in progress in the location.");
  // R4: a merge into a default branch (the usual names, or the one `origin/HEAD` points at) asks the owner at EVERY act, grant or not.
  const originHead = await ctx.run(
    ["git", "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"],
    cwd,
  );
  // When `origin/HEAD` is unreadable or unset the default is unknown: only a target the grant names exactly runs without asking.
  const known = originHead.code === 0 && originHead.out.trim() !== "";
  const isDefault = verdict.allow
    ? known
      ? originHead.out.trim() === `origin/${into}`
      : !grantNamesBranch(ctx.envelope, MERGE_BRANCH_TOOL, location, into)
    : true;
  if (isDefault) {
    const yes = await ctx.confirm(
      `Merge ${safeText(from)} into the default branch ${safeText(into)} of ${safeText(location)}?`,
    );
    if (!yes)
      return refuseLogged(
        ctx,
        MERGE_BRANCH_TOOL,
        scope,
        "OWNER_DENIED",
        "The owner did not allow a merge into a default branch.",
        "denied",
      );
  }
  const before = (await ctx.run(["git", "rev-parse", "HEAD"], cwd)).out.trim();
  const r = await ctx.run(["git", "merge", "--no-edit", "--", from], cwd);
  if (r.code !== 0) {
    // MERGE_HEAD was absent before this call: if it exists now, THIS call started the merge, so only then abort it.
    const started = await ctx.run(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd);
    if (started.code === 0) await ctx.run(["git", "merge", "--abort"], cwd); // a conflict leaves nothing half merged
    return refused(
      "MERGE_FAILED",
      `git merge failed${started.code === 0 ? " (aborted)" : ""}: ${r.out}`,
    );
  }
  recordEffect(ctx, {
    tool: MERGE_BRANCH_TOOL,
    scope,
    result: JSON.stringify({ code: 0 }),
    undo: `git reset --hard ${before}`,
    owner: isDefault,
  });
  return { ok: true, merged: from, into };
}
