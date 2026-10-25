import type { Schedule } from "./schedule";
import { LATE_MS } from "./schedule-board-types";
import { formatLocal } from "./schedule-rules";

/**
 * The turn text of a scheduled run: a header with the due time, a late note when the run started 15 min or more
 * after it was due (Rakazo wording), then a blank line and the task.
 */
export function scheduleTurnText(
  s: Pick<Schedule, "name" | "task" | "timeZone">,
  due: number,
  now: number,
): string {
  const tz = s.timeZone;
  const lines = [`[Scheduled run "${s.name}", due ${formatLocal(due, tz)} (${tz})]`];
  if (now - due >= LATE_MS)
    lines.push(
      `This scheduled run started late: it was due ${formatLocal(due, tz)} and started ${formatLocal(now, tz)} (${tz}). ` +
        "Adapt anything that depends on the time of day to the actual time, skip steps that no longer make sense, " +
        "and mention the delay when it matters to the owner.",
    );
  return `${lines.join("\n")}\n\n${s.task}`;
}
