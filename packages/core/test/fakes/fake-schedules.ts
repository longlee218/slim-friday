import type { DisabledReason, Schedule, ScheduleRun, Store } from "../../src";

/** In-memory schedule and schedule-run ports; rows are kept in the returned arrays. */
export function fakeSchedules() {
  const rows: Schedule[] = [];
  const runs: ScheduleRun[] = [];
  const schedules: Store["schedules"] = {
    list: async (f) =>
      rows
        .filter(
          (s) =>
            (!f?.botId || s.botId === f.botId) &&
            (!f?.conversationId || s.conversationId === f.conversationId),
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((s) => ({ ...s })),
    get: async (id) => {
      const s = rows.find((r) => r.id === id);
      return s && { ...s };
    },
    insert: async (s) => {
      rows.push({ ...s });
    },
    update: async (id, patch) => {
      const s = rows.find((r) => r.id === id);
      if (!s) return undefined;
      Object.assign(s, patch);
      return { ...s };
    },
    advance: async (id, expectedNext, patch) => {
      const s = rows.find((r) => r.id === id);
      if (!s || s.nextRunAt !== expectedNext) return false;
      Object.assign(s, patch);
      return true;
    },
    due: async (now) =>
      rows
        .filter((s) => s.enabled && s.nextRunAt !== undefined && s.nextRunAt <= now)
        .map((s) => ({ ...s })),
    remove: async (id) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      for (let j = runs.length - 1; j >= 0; j--) if (runs[j]?.scheduleId === id) runs.splice(j, 1);
      return true;
    },
    removeDisabledBefore: async (reasons: DisabledReason[], at: number) => {
      const gone = rows.filter(
        (s) =>
          !s.enabled && s.disabledReason && reasons.includes(s.disabledReason) && s.updatedAt < at,
      );
      for (const s of gone) await schedules.remove(s.id);
      return gone.length;
    },
  };
  const scheduleRuns: Store["scheduleRuns"] = {
    insert: async (r) => {
      runs.push({ ...r });
    },
    update: async (id, patch) => {
      const r = runs.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
    },
    open: async () => runs.filter((r) => r.status === "running").map((r) => ({ ...r })),
    addCost: async (wakeId, usd) => {
      for (const r of runs) if (r.wakeId === wakeId) r.costUsd += usd;
    },
    list: async (scheduleId, limit, before) =>
      runs
        .filter((r) => r.scheduleId === scheduleId && (before === undefined || r.firedAt < before))
        .sort((a, b) => b.firedAt - a.firedAt)
        .slice(0, limit)
        .map((r) => ({ ...r })),
    deleteBefore: async (at) => {
      const n = runs.length;
      for (let j = runs.length - 1; j >= 0; j--)
        if ((runs[j]?.firedAt ?? 0) < at) runs.splice(j, 1);
      return n - runs.length;
    },
  };
  return { schedules, scheduleRuns };
}
