import type { StoredMessage } from "../domain/message";
import type { HubContext } from "../hub/hub-context";
import type { RunExec } from "./run-exec";

/** The fields that tag a message with the schedule whose run posted it. */
export type ScheduleTag = Pick<StoredMessage, "scheduleId" | "scheduleName">;

/**
 * The schedule tag of a run's messages: none for a run no schedule fired; else the schedule id and, when the
 * schedule still exists, its name. The name is read once, at the run's first post, and kept for the run. A
 * schedule deleted by then (or a failed read) leaves the id alone: the tag never blocks a post.
 */
export async function scheduleTagOf(ctx: HubContext, exec: RunExec): Promise<ScheduleTag> {
  const scheduleId = exec.row.scheduleId;
  if (!scheduleId) return {};
  if (!exec.scheduleTag) {
    const name = await ctx.deps.store.schedules.get(scheduleId).then(
      (s) => s?.name,
      () => undefined,
    );
    exec.scheduleTag = { scheduleId, ...(name && { scheduleName: name }) };
  }
  return exec.scheduleTag;
}
