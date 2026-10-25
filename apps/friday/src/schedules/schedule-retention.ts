import type { Schedule, Store } from "@friday/core";

const DAY_MS = 86_400_000;

/** How long schedule run rows are kept. */
const RUN_KEEP_DAYS = 90;
/** Schedules disabled because their bot or group went are kept this long (past the 7-day trash of the owner). */
const GONE_KEEP_DAYS = 8;

/**
 * Delete run rows older than 90 days, and schedules disabled `bot_gone` or `group_gone` for over 8 days whose bot or
 * group is still missing. A restored bot or group keeps its schedules (still disabled until the owner turns them on).
 */
export async function pruneSchedules(
  store: Pick<Store, "schedules" | "scheduleRuns" | "bots" | "groups" | "conversations">,
  now: number,
): Promise<void> {
  await store.scheduleRuns.deleteBefore(now - RUN_KEEP_DAYS * DAY_MS);
  const old = await store.schedules.disabledBefore(
    ["bot_gone", "group_gone"],
    now - GONE_KEEP_DAYS * DAY_MS,
  );
  for (const s of old) if (await targetGone(store, s)) await store.schedules.remove(s.id);
}

/** True when the reason the schedule was switched off still holds: its bot, or its group chat, is missing. */
async function targetGone(
  store: Pick<Store, "bots" | "groups" | "conversations">,
  s: Schedule,
): Promise<boolean> {
  if (s.disabledReason === "bot_gone") return !(await store.bots.get(s.botId));
  const conv = await store.conversations.get(s.conversationId);
  if (!conv) return true;
  return conv.kind === "group" && !(await store.groups.get(conv.groupId));
}
