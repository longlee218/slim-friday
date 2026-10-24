import type { WakeRow } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";
import { holdOrContinue } from "./run-steering";

/**
 * A run starts again after a cut (a restart or a lost lease): the rows its earlier attempt claimed are
 * answered when the bot spoke after the claim (`firstTextAt` is the bot's first text of the last attempt that
 * spoke, so a row claimed at or before it is answered). Those are deleted; the others are offered again, so
 * this attempt claims them with its first turn. A row injected after the bot's first text counts as
 * unanswered (at-least-once: it may be answered twice, never lost).
 */
export async function settleCutSteering(ctx: HubContext, row: WakeRow): Promise<void> {
  const { steering } = ctx.deps.store;
  if (row.firstTextAt !== undefined) await steering.deleteClaimed(row.id, row.firstTextAt);
  await steering.releaseClaimed(row.id);
}

/**
 * The steering of a run that ended (called by `finishRun` after the fenced transition, and by the reconciler
 * for rows left on an ended run). `answeredUpTo`: rows claimed at or before it were answered by a turn that
 * ended, so they are deleted; every other claimed row is offered again. Rows still bound go back to held, so
 * none is orphaned. A run that finished done then hands the held rows on (`holdOrContinue`); a failed or
 * interrupted one does not (a failing continuation would loop), so its rows wait for the next finished run.
 * Every step is idempotent. If the process dies after the transition and before this runs, the rows stay
 * bound to the ended run until the reconciler (Task 11) calls this again.
 */
export async function settleSteering(
  ctx: HubContext,
  row: WakeRow,
  status: "done" | "failed" | "interrupted",
  answeredUpTo?: number,
): Promise<void> {
  const { steering } = ctx.deps.store;
  if (status === "done" && answeredUpTo !== undefined)
    await steering.deleteClaimed(row.id, answeredUpTo);
  await steering.releaseClaimed(row.id);
  await steering.unbind(row.id);
  if (status === "done") await holdOrContinue(ctx, row.scopeKey);
}
