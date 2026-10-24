import type { WakeRow } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";
import { returnOutcomeSafe } from "./outcome-outbox";
import type { RunExec } from "./run-exec";

/**
 * A run cut short by the owner's stop (`cancelled`), a lost lease or a graceful shutdown of this process.
 * A stop cancels the row. A shutdown puts it back to `queued` (fenced on `running`, due now) so any worker
 * claims it again without counting a cut (spec "Worker shutdown"; restarts must not trip the poison guard).
 * After a lost lease another worker owns the row, so only the attempt is closed. The attempt always ends
 * `interrupted`.
 */
export async function cutShort(ctx: HubContext, exec: RunExec): Promise<void> {
  const { store, clock } = ctx.deps;
  const { row } = exec;
  const now = clock.now();
  if (exec.stop?.kind === "stopped") {
    const patch = { status: "cancelled" as const, endedAt: now };
    if (!(await store.wakes.transition(row.id, row.leaseFence, ["running"], patch))) return;
    await store.scopes.finished(row.scopeKey, now, Math.max(0, row.createdAt - 1));
    await returnOutcomeSafe(ctx, { ...row, ...patch });
  }
  if (exec.stop?.kind === "shutdown") {
    const patch = { status: "queued" as const, wakeAt: now };
    if (await store.wakes.transition(row.id, row.leaseFence, ["running"], patch))
      ctx.deps.log?.info({ wakeId: row.id }, "run.requeued_on_shutdown");
  }
  await store.attempts.finish(`${row.id}:${row.leaseFence}`, "interrupted", now);
}

/**
 * The claimed row went back to `queued` at a graceful shutdown: claimed from `queued` and its previous attempt
 * ended `interrupted`. Such a run gets the cut note, but no cut is counted.
 */
export async function requeuedByShutdown(ctx: HubContext, row: WakeRow): Promise<boolean> {
  if (row.claimedFrom !== "queued" || row.leaseFence < 2) return false;
  const prev = await ctx.deps.store.attempts.status(`${row.id}:${row.leaseFence - 1}`);
  return prev === "interrupted";
}
