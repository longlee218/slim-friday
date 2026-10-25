import type { WakeRow } from "../domain/wake";
import { isSilent } from "../runs/silent-reply";
import type { Schedule, ScheduleRun } from "./schedule";
import type { ScheduleBoardDeps } from "./schedule-board-types";
import { settle } from "./schedule-fire";
import type { ScheduleNotices } from "./schedule-notices";

/** A wake that ended without its answer; the history row says `Run <status>.`. */
const ENDED: WakeRow["status"][] = ["cancelled", "interrupted", "expired", "dropped", "blocked"];

/**
 * Settle each open history row from its wake: `done` is `ok` (or `problem` when a "problems" schedule posted an
 * answer), a failed or ended wake is `failed` with a notice (none for a cancelled one), a missing wake is
 * `failed` too. A wake still in progress leaves the row `running`. Rows without a wake are left to the fire step.
 */
export async function reconcileRuns(
  deps: ScheduleBoardDeps,
  notices: ScheduleNotices,
): Promise<void> {
  const { store, clock } = deps;
  for (const row of await store.scheduleRuns.open()) {
    if (!row.wakeId) continue;
    const s = await store.schedules.get(row.scheduleId);
    const wake = await store.wakes.get(row.wakeId);
    const out = outcome(wake, s);
    if (!out) continue;
    const endedAt = wake?.endedAt ?? clock.now();
    await settle(deps, row.scheduleId, row.id, {
      status: out.status,
      endedAt,
      ...(out.error !== undefined && { error: out.error }),
    });
    if (out.error === undefined) continue;
    deps.log?.warn(
      {
        event: "schedule.failed",
        scheduleId: row.scheduleId,
        reason: wake ? wake.status : "wake_missing",
      },
      "schedule.failed",
    );
    if (s && out.notify) await notices.failed(s, out.error);
  }
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
