import type { WakeRow } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";
import { returnOutcomeSafe } from "./outcome-outbox";
import { releaseComputer } from "./run-computer-release";
import { settleSteering } from "./run-continuation";

/** How a run ended, as `finishRun` stores it. */
export interface RunResult {
  status: "done" | "failed";
  /** The bot's last text (returned to the bot that delegated the work). */
  resultText?: string;
  /** Why the run failed. */
  error?: string;
}

/**
 * Finish a run. The store has no transaction across repos, so the fence-guarded `transition` to done/failed
 * is the commit point: when it matches no row (another worker owns the run, or it was cancelled) nothing else
 * is written and false is returned. The follow-ups are idempotent and safe to repeat: attempt closed,
 * `scopes.finished`, steering settled (`settleSteering`: unanswered rows held, then a continuation run), the
 * outcome returned to the bot that delegated the work (`returnOutcome`, which never throws here).
 *
 * Crash order: after the transition and before the follow-ups the attempt stays `running` and the scope's
 * finish time is older (bookkeeping); steering rows stay bound to the ended run and the outcome stays
 * unreturned until the reconciler (`outcome-reconciler.ts`) settles them (no row is lost or answered twice).
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
  await releaseComputer(ctx, row.targetBot, row.id);
  await store.attempts.finish(`${row.id}:${fence}`, r.status, endedAt, r.error);
  await store.scopes.finished(row.scopeKey, endedAt, Math.max(0, row.createdAt - 1));
  await settleSteering(ctx, row, r.status);
  const ended = (await store.wakes.get(row.id)) ?? { ...row, ...patch };
  await returnOutcomeSafe(ctx, ended);
  if (r.status === "done") ctx.wakeLog.logDone(ended, endedAt);
  else log?.warn({ event: "wake.failed", wakeId: row.id, botId: row.targetBot }, "wake.failed");
  return true;
}
