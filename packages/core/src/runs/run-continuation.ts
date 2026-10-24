import type { WakeRow } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";
import { CONTINUATION_KEY, holdOrContinue } from "./run-steering";

/**
 * A run starts again after a cut (a restart or a lost lease). Rows are deleted the moment a turn answers them
 * (`answerFirstTurn`, `answerPushed`), so every row still claimed was not answered: offer it again, and this
 * attempt claims it with its first turn.
 */
export async function settleCutSteering(ctx: HubContext, row: WakeRow): Promise<void> {
  await ctx.deps.store.steering.releaseClaimed(row.id);
}

/**
 * The steering of a run that ended (called by `finishRun` after the fenced transition, and by the reconciler
 * for rows left on an ended run). Rows an ended turn answered are already deleted; every other claimed row is
 * offered again and every row still bound goes back to held, so none is orphaned. Then the held rows are
 * handed on (`holdOrContinue`). To bound loops, a continuation run that failed or was interrupted deletes the
 * rows it claimed instead (the owner sees the failure notice); rows bound to it later go back to held. Every step is idempotent. If the process dies after the
 * transition and before this runs, the rows stay bound to the ended run until the reconciler (Task 11) calls
 * this again.
 */
export async function settleSteering(
  ctx: HubContext,
  row: WakeRow,
  status: "done" | "failed" | "interrupted",
): Promise<void> {
  const { steering } = ctx.deps.store;
  // A failed continuation drops the rows it took (claimed); rows bound to it but never claimed are new messages and go back to held.
  if (status !== "done" && row.dedupeKey?.startsWith(CONTINUATION_KEY)) await steering.deleteClaimed(row.id);
  else await steering.releaseClaimed(row.id);
  await steering.unbind(row.id);
  await holdOrContinue(ctx, row.scopeKey, row.id);
}
