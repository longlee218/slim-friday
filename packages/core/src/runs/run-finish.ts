import type { WakeRow } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";

/** How a run ended, as `finishRun` stores it. */
export interface RunResult {
  status: "done" | "failed";
  /** The bot's last text (kept for the delegating bot, Task 11 returns it). */
  resultText?: string;
  /** Why the run failed. */
  error?: string;
}

/**
 * Finish a run. The store has no transaction across repos, so the fence-guarded `transition` to done/failed
 * is the commit point: when it matches no row (another worker owns the run, or it was cancelled) nothing else
 * is written and false is returned. The follow-ups are idempotent and safe to repeat: attempt closed,
 * `scopes.finished`, held steering handed on (Task 9). The outcome fields stay on the row for Task 11.
 *
 * Crash order: after the transition and before the follow-ups the attempt stays `running` and the scope's
 * finish time is older; both are only bookkeeping (no run is lost or repeated).
 */
export async function finishRun(
  ctx: HubContext,
  row: WakeRow,
  fence: number,
  r: RunResult,
): Promise<boolean> {
  const { store, clock, log } = ctx.deps;
  const endedAt = clock.now();
  const patch: Partial<WakeRow> = {
    status: r.status,
    endedAt,
    ...(r.resultText !== undefined && { resultText: r.resultText }),
    ...(r.error !== undefined && { error: r.error }),
  };
  if (!(await store.wakes.transition(row.id, fence, ["running"], patch))) return false;
  await store.attempts.finish(`${row.id}:${fence}`, r.status, endedAt, r.error);
  await store.scopes.finished(row.scopeKey, endedAt, Math.max(0, row.createdAt - 1));
  await continueHeldSteering(ctx, row);
  const ended = (await store.wakes.get(row.id)) ?? { ...row, ...patch };
  if (r.status === "done") ctx.wakeLog.logDone(ended, endedAt);
  else log?.warn({ event: "wake.failed", wakeId: row.id, botId: row.targetBot }, "wake.failed");
  return true;
}

/**
 * Held steering of the finished run's scope becomes a continuation run. Task 9 fills this in; until then the
 * reconciler sweep (Task 11) and the next owner message pick up what is held.
 */
export async function continueHeldSteering(_ctx: HubContext, _row: WakeRow): Promise<void> {}
