import { clip } from "../../observability/redact";
import { type Reply, refuse } from "../../orchestrator/engine/lead-call";
import { goalUsage, measurePaths } from "../../policy/bounds-usage";
import { checkEnvelope } from "../../policy/check-envelope";
import { type EffectsCtx, recordEffect, refuseLogged, safeText } from "../../policy/effect-context";
import { TRASH_TTL_MS } from "../../policy/risk-types";
import { classifyPath, type PathKind, stillSame } from "./delete-paths-classify";
import { containsNestedGit } from "./nested-git";
import { DELETE_PATHS_TOOL } from "./tools/DeletePathsTool/constants";
import { moveToTrash } from "./trash-store";

/* DeletePaths: move paths to the trash (restorable for 7 days). Fails closed: a path that cannot be resolved, a symlink
   escape, a secret file, a `.git` at any depth, the agent home or a location root is refused; a path in a location the goal
   does not use asks the owner at every act (R4) and STILL obeys the bounds; a request past the bounds asks once it is
   concrete. Every refusal and owner denial is written to `effect_log`. Each target is re-validated right before it moves. */

/** Handle one `DeletePaths` call. */
export async function deletePaths(
  ctx: EffectsCtx,
  input: { paths: string[]; reason: string },
): Promise<Reply> {
  const paths = [...new Set(input.paths)];
  const scope = paths.join(" ");
  const kinds = paths.map((p) => classifyPath(ctx, p));
  if (kinds.length === 0 || kinds.some((k) => k.kind === "refused"))
    return refuseLogged(
      ctx,
      DELETE_PATHS_TOOL,
      scope,
      "FORBIDDEN_PATH",
      "A path is missing, not absolute, outside the goal's locations or protected. Nothing was deleted.",
    );
  const found = kinds as Exclude<PathKind, { kind: "refused" }>[];
  const reals = found.map((k) => k.real);
  const shown = clip(reals.map(safeText).join("\n"), 800);
  const why = clip(safeText(input.reason), 200);
  let ownerAsked = false;
  // R4: a location the goal does not use. Asked at every act, never stored.
  if (found.some((k) => k.kind === "other_location")) {
    const yes = await ctx.confirm(
      `Delete ${reals.length} path(s) in a location outside this goal's envelope?\n${shown}\nReason: ${why}`,
    );
    if (!yes)
      return refuseLogged(
        ctx,
        DELETE_PATHS_TOOL,
        scope,
        "OWNER_DENIED",
        "The owner did not allow deleting outside the goal's locations.",
        "denied",
      );
    ownerAsked = true;
  }
  // R4: a target that contains a git dir (nested repo, submodule, worktree) would take its history to the trash: ask, with the reason.
  const nested = reals.filter(containsNestedGit);
  if (nested.length > 0) {
    const yes = await ctx.confirm(
      `Delete ${nested.length} path(s) that contain a git repository (or are too big to check)?\n${clip(nested.map(safeText).join("\n"), 800)}\nReason: ${why}`,
    );
    if (!yes)
      return refuseLogged(
        ctx,
        DELETE_PATHS_TOOL,
        scope,
        "OWNER_DENIED",
        "The owner did not allow deleting a path that contains a git repository.",
        "denied",
      );
    ownerAsked = true;
  }
  const size = measurePaths(reals, ctx.envelope.bounds.maxBytes + 1);
  const verdict = checkEnvelope(
    { tool: DELETE_PATHS_TOOL, ...size },
    ctx.envelope,
    goalUsage(ctx.db, ctx.goalId),
  );
  if (!verdict.allow) {
    // An owner's yes for another location never lifts the bounds. Inside the goal, out of the bounds the scope is only
    // now concrete: the ask table answers `when_concrete` (asked here).
    const yes =
      !ownerAsked &&
      (await ctx.confirm(
        `Delete ${size.items} path(s) (over this goal's bound: ${verdict.reason})?\nReason: ${why}`,
      ));
    if (!yes)
      return refuseLogged(
        ctx,
        DELETE_PATHS_TOOL,
        scope,
        "OVER_BOUNDS",
        `Not allowed: ${verdict.reason}. Narrow the list or ask the lead for an amendment.`,
        ownerAsked ? "refused" : "denied",
      );
    ownerAsked = true;
  }
  const now = (ctx.now ?? Date.now)();
  // Re-check each target (same kind, path, device, inode) right before it moves: an owner's wait is a window to swap a link in.
  const byReal = new Map(found.map((k, i) => [k.real, { p: paths[i], k }]));
  const move = moveToTrash(ctx.agentHome, ctx.goalId, reals, now, (from) => {
    const t = byReal.get(from);
    return !!t && stillSame(ctx, t.p, t.k);
  });
  recordEffect(ctx, {
    tool: DELETE_PATHS_TOOL,
    scope: clip(safeText(reals.join(" ")), 500),
    result: JSON.stringify({
      items: move.entries.length,
      bytes: size.bytes,
      ...(move.error && { error: move.error }),
    }),
    // Restore = move each `to` back to `from` (the manifest of this entry).
    undo: JSON.stringify({ restore: move.entries }),
    owner: ownerAsked,
  });
  if (move.error === "CHANGED")
    return refuse(
      "CHANGED",
      `A path changed after it was checked (moved ${move.entries.length} of ${reals.length}); the rest was refused.`,
    );
  if (move.error)
    return refuse(
      "PARTIAL",
      `Moved ${move.entries.length} of ${reals.length} path(s), then stopped (${move.error}).`,
    );
  return { ok: true, moved: move.entries.length, keptDays: 7 };
}
