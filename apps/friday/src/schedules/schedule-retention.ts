import type { Store } from "@friday/core";

const DAY_MS = 86_400_000;

/** How long schedule run rows are kept. */
const RUN_KEEP_DAYS = 90;
/** Schedules disabled because their bot or group went are kept this long (past the 7-day trash of the owner). */
const GONE_KEEP_DAYS = 8;

/** Delete run rows older than 90 days and schedules disabled `bot_gone` or `group_gone` for over 8 days. */
export async function pruneSchedules(
  store: Pick<Store, "schedules" | "scheduleRuns">,
  now: number,
): Promise<void> {
  await store.scheduleRuns.deleteBefore(now - RUN_KEEP_DAYS * DAY_MS);
  await store.schedules.removeDisabledBefore(
    ["bot_gone", "group_gone"],
    now - GONE_KEEP_DAYS * DAY_MS,
  );
}
