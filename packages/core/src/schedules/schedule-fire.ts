import { errText } from "../hub/hub-types";
import type { NextRunAt } from "../ports/next-run";
import type { Schedule, ScheduleRun } from "./schedule";
import { changed, LATE_MS, type ScheduleBoardDeps } from "./schedule-board-types";
import type { ScheduleNotices } from "./schedule-notices";
import { scheduleTurnText } from "./schedule-turn";

/** The error of a skipped fire. */
export const SKIPPED_ERROR = "The previous run has not finished.";
/** The error of a fire whose bot is not a member of the target group. */
const NOT_MEMBER = "The bot is not a member of the target group.";

/** What the fire steps share. */
export interface FireCtx {
  deps: ScheduleBoardDeps;
  nextRunAt: NextRunAt;
  notices: ScheduleNotices;
}

/** True when a history row of the schedule is still `running` (its run is queued, running or parked). */
export async function hasOpenRun(deps: ScheduleBoardDeps, scheduleId: string): Promise<boolean> {
  return (await deps.store.scheduleRuns.open()).some((r) => r.scheduleId === scheduleId);
}

/**
 * Fire one due schedule at `now`: switch it off when its bot or conversation is gone, skip it while its last run
 * is open, else advance `nextRunAt` (compare-and-set; a lost race does nothing) and start the run.
 */
export async function fireDue(f: FireCtx, s: Schedule, now: number): Promise<void> {
  const { store, log } = f.deps;
  const due = s.nextRunAt;
  if (due === undefined) return;
  if (!(await store.bots.get(s.botId))) {
    await switchOff(f, s, now, "bot_gone", "The bot is gone.");
    return;
  }
  const conv = await store.conversations.get(s.conversationId);
  if (!conv || (conv.kind === "group" && !(await store.groups.get(conv.groupId)))) {
    await switchOff(f, s, now, "group_gone", "The group is gone.");
    const direct = await store.conversations.direct(s.botId);
    if (direct) await f.deps.tell(direct.id, `Schedule "${s.name}" is off: its group is gone.`);
    return;
  }
  const open = await hasOpenRun(f.deps, s.id);
  if (!(await store.schedules.advance(s.id, due, advancePatch(f, s, due, now)))) return;
  changed(f.deps, s.id);
  if (open) {
    await insertRun(f, s, due, now, false, {
      status: "skipped",
      endedAt: now,
      error: SKIPPED_ERROR,
    });
    log?.info({ event: "schedule.skipped", scheduleId: s.id, botId: s.botId }, "schedule.skipped");
    await f.notices.send(
      s,
      `Schedule "${s.name}" skipped a run: the previous run has not finished.`,
    );
    return;
  }
  await startRun(f, s, due, now, false, `sched:${s.id}:${new Date(due).toISOString()}`);
}

/**
 * Insert a `running` history row and create the run; `ok` stores the wake, `gone` and a cap block fail the row
 * (createRun already posted the cap notice). Returns the outcome; a thrown createRun fails the row too.
 */
export async function startRun(
  f: FireCtx,
  s: Schedule,
  due: number,
  now: number,
  manual: boolean,
  dedupeKey: string,
): Promise<{ wakeId: string } | { error: string }> {
  const row = await insertRun(f, s, due, now, manual, { status: "running" });
  f.deps.log?.info(
    { event: "schedule.fired", scheduleId: s.id, botId: s.botId, lateMs: now - due, manual },
    "schedule.fired",
  );
  let error: string;
  let reason: string;
  try {
    const out = await f.deps.createRun({
      botId: s.botId,
      conversationId: s.conversationId,
      sender: { kind: "system" },
      text: scheduleTurnText(s, due, now),
      hop: 0,
      dedupeKey,
      opts: { schedule: { id: s.id, quiet: s.notify === "problems" } },
    });
    if (out.ok) {
      await f.deps.store.scheduleRuns.update(row.id, { wakeId: out.wakeId });
      changed(f.deps, s.id);
      return { wakeId: out.wakeId };
    }
    reason = out.reason === "gone" ? "not_member" : out.reason;
    error = out.reason === "gone" ? NOT_MEMBER : `Stopped: ${out.reason} limit reached.`;
  } catch (err) {
    reason = "create_failed";
    error = errText(err);
  }
  await settle(f.deps, s.id, row.id, { status: "failed", endedAt: f.deps.clock.now(), error });
  f.deps.log?.warn(
    { event: "schedule.failed", scheduleId: s.id, botId: s.botId, reason },
    "schedule.failed",
  );
  // A cap block already has its "Stopped" notice from createRun.
  if (reason === "not_member" || reason === "create_failed") await f.notices.failed(s, error);
  return { error };
}

/** Patch a history row and tell the listener. */
export async function settle(
  deps: ScheduleBoardDeps,
  scheduleId: string,
  runId: string,
  patch: Partial<Pick<ScheduleRun, "status" | "wakeId" | "endedAt" | "error">>,
): Promise<void> {
  await deps.store.scheduleRuns.update(runId, patch);
  changed(deps, scheduleId);
}

/** The compare-and-set patch of a fire: the next occurrence after max(due, now), or switched off when none is left. */
function advancePatch(f: FireCtx, s: Schedule, due: number, now: number) {
  const next = f.nextRunAt(s.rule, s.timeZone, Math.max(due, now), due);
  const base = { lastFireAt: now, updatedAt: now };
  if (s.rule.kind === "once" || next === undefined)
    return { ...base, enabled: false, disabledReason: "done" as const, nextRunAt: undefined };
  return { ...base, nextRunAt: next };
}

/** Switch a schedule off for good (`bot_gone`, `group_gone`) with one failed history row. */
async function switchOff(
  f: FireCtx,
  s: Schedule,
  now: number,
  reason: "bot_gone" | "group_gone",
  error: string,
): Promise<void> {
  const patch = { enabled: false, disabledReason: reason, nextRunAt: undefined, updatedAt: now };
  await f.deps.store.schedules.update(s.id, patch);
  await insertRun(f, s, s.nextRunAt ?? now, now, false, { status: "failed", endedAt: now, error });
  f.deps.log?.warn(
    { event: "schedule.failed", scheduleId: s.id, botId: s.botId, reason },
    "schedule.failed",
  );
  changed(f.deps, s.id);
}

/** Insert one history row of a fire. */
async function insertRun(
  f: FireCtx,
  s: Schedule,
  due: number,
  now: number,
  manual: boolean,
  over: Pick<ScheduleRun, "status"> & Partial<ScheduleRun>,
): Promise<ScheduleRun> {
  const row: ScheduleRun = {
    id: crypto.randomUUID(),
    scheduleId: s.id,
    dueAt: due,
    firedAt: now,
    manual,
    late: now - due >= LATE_MS,
    costUsd: 0,
    ...over,
  };
  await f.deps.store.scheduleRuns.insert(row);
  return row;
}
