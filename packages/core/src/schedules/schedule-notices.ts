import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import { errText } from "../hub/hub-types";
import type { Schedule } from "./schedule";
import type { ScheduleBoardDeps } from "./schedule-board-types";

/** The owner's notices about schedule problems: at most one per schedule per local day (kept in memory). */
export class ScheduleNotices {
  /** Local day (`YYYY-MM-DD` in the schedule's zone) of the last notice, by schedule id. */
  private lastDay = new Map<string, string>();

  constructor(private deps: ScheduleBoardDeps) {}

  /**
   * Post `text` in the schedule's conversation and toast it, unless this schedule already did today.
   * `toastOnly`: the chat already has its own message (createRun's cap notice), so only toast.
   */
  async send(s: Schedule, text: string, opts: { toastOnly?: boolean } = {}): Promise<void> {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: s.timeZone }).format(
      this.deps.clock.now(),
    );
    if (this.lastDay.get(s.id) === day) return;
    // Counted only once posted: a failed post lets the next problem of the day try again.
    if (!opts.toastOnly) await this.deps.tell(s.conversationId, text);
    this.lastDay.set(s.id, day);
    this.toast(s.conversationId, s.botId, text);
  }

  /** `Schedule "<name>" failed: <error>`. */
  failed(s: Schedule, error: string, opts?: { toastOnly?: boolean }): Promise<void> {
    return this.send(s, `Schedule "${s.name}" failed: ${error}`, opts);
  }

  /** Post and toast a one-time notice in any conversation (not counted against the daily limit). */
  async post(conversationId: ConversationId, botId: BotId, text: string): Promise<void> {
    await this.deps.tell(conversationId, text);
    this.toast(conversationId, botId, text);
  }

  /** Raise the toast; a surface failure is logged, never thrown. */
  private toast(conversationId: ConversationId, botId: BotId, text: string): void {
    try {
      this.deps.notifyFinished({ conversationId, botId, preview: text });
    } catch (err) {
      this.deps.log?.error({ error: errText(err), conversationId }, "schedule.notice_failed");
    }
  }
}
