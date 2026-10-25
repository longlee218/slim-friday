import { errText } from "../hub/hub-types";
import type { Schedule } from "./schedule";
import type { ScheduleBoardDeps } from "./schedule-board-types";

/** The owner's notices about schedule problems: at most one per schedule per local day (kept in memory). */
export class ScheduleNotices {
  /** Local day (`YYYY-MM-DD` in the schedule's zone) of the last notice, by schedule id. */
  private lastDay = new Map<string, string>();

  constructor(private deps: ScheduleBoardDeps) {}

  /** Post `text` in the schedule's conversation and toast it, unless this schedule already did today. */
  async send(s: Schedule, text: string): Promise<void> {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: s.timeZone }).format(
      this.deps.clock.now(),
    );
    if (this.lastDay.get(s.id) === day) return;
    this.lastDay.set(s.id, day);
    await this.deps.tell(s.conversationId, text);
    try {
      this.deps.notifyFinished({ conversationId: s.conversationId, botId: s.botId, preview: text });
    } catch (err) {
      this.deps.log?.error({ error: errText(err), scheduleId: s.id }, "schedule.notice_failed");
    }
  }

  /** `Schedule "<name>" failed: <error>`. */
  failed(s: Schedule, error: string): Promise<void> {
    return this.send(s, `Schedule "${s.name}" failed: ${error}`);
  }
}
