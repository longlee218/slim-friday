import type { WakeRow } from "../domain/wake";
import { errText } from "../hub/hub-types";
import { isSilent } from "../runs/silent-reply";
import type { Schedule, ScheduleRun } from "./schedule";
import type { ScheduleBoardDeps } from "./schedule-board-types";
import { settle } from "./schedule-fire";
import type { ScheduleNotices } from "./schedule-notices";

/** How long a row may stay open without a wake before it is failed as never started. */
const NO_WAKE_GRACE_MS = 5 * 60_000;

/** A wake that ended without its answer; the history row says `Run <status>.`. */
const ENDED: WakeRow["status"][] = ["cancelled", "interrupted", "expired", "dropped", "blocked"];

/**
 * Settle each open history row from its wake: `done` is `ok` (or `problem` when a "problems" schedule posted an
 * answer), a failed or ended wake is `failed` with a notice (none for a cancelled one), a missing wake is
 * `failed` too. A wake still in progress leaves the row `running`. A row with no wake
 * for 5 min fails as never started (else it would keep the schedule skipping forever).
 */
export async function reconcileRuns(
  deps: ScheduleBoardDeps,
  notices: ScheduleNotices,
): Promise<void> {
  for (const row of await deps.store.scheduleRuns.open()) {
    // One row's failure (a rejected notice, a store error) never stops the others.
    try {
      await settleRow(deps, notices, row);
    } catch (err) {
      deps.log?.error(
        { error: errText(err), scheduleId: row.scheduleId },
        "schedule.settle_failed",
      );
    }
  }
}

/** Settle one open row, when its wake has ended or it never got one in time. */
async function settleRow(
  deps: ScheduleBoardDeps,
  notices: ScheduleNotices,
  row: ScheduleRun,
): Promise<void> {
  const { store, clock } = deps;
  const now = clock.now();
  // No wake: the fire crashed between the row and the run (or the wakeId write failed).
  if (!row.wakeId && row.firedAt > now - NO_WAKE_GRACE_MS) return;
  const s = await store.schedules.get(row.scheduleId);
  const wake = row.wakeId ? await store.wakes.get(row.wakeId) : undefined;
  const out = row.wakeId
    ? outcome(wake, s)
    : { status: "failed" as const, error: "The run did not start.", notify: true };
  if (!out) return;
  await settle(deps, row.scheduleId, row.id, {
    status: out.status,
    endedAt: wake?.endedAt ?? now,
    ...(out.error !== undefined && { error: out.error }),
  });
  if (out.error === undefined) return;
  const reason = !row.wakeId ? "not_started" : wake ? wake.status : "wake_missing";
  deps.log?.warn(
    { event: "schedule.failed", scheduleId: row.scheduleId, botId: s?.botId, reason },
    "schedule.failed",
  );
  if (s && out.notify) await notices.failed(s, out.error);
}

/** The final status of a row from its wake; undefined while the wake is still in progress. */
function outcome(
  wake: WakeRow | undefined,
  s: Schedule | undefined,
): { status: ScheduleRun["status"]; error?: string; notify?: boolean } | undefined {
  if (!wake) return { status: "failed", error: "Run record expired.", notify: true };
  if (wake.status === "done") {
    const posted = wake.resultText !== undefined && !isSilent(wake.resultText);
    return { status: s?.notify === "problems" && posted ? "problem" : "ok" };
  }
  if (wake.status === "failed")
    return { status: "failed", error: wake.error ?? "Run failed.", notify: true };
  if (ENDED.includes(wake.status))
    return {
      status: "failed",
      error: `Run ${wake.status}.`,
      notify: wake.status !== "cancelled",
    };
  return undefined;
}
