import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { Author } from "../domain/message";

/** When a schedule fires; times are wall-clock in the schedule's own time zone. */
export type RepeatRule =
  /** Every day at `at` ("HH:MM", 24 h). */
  | { kind: "daily"; at: string }
  /** Monday to Friday at `at`. */
  | { kind: "weekdays"; at: string }
  /** Every `weekday` (0 = Sunday ... 6 = Saturday) at `at`. */
  | { kind: "weekly"; at: string; weekday: number }
  /** Every `every` minutes or hours. */
  | { kind: "interval"; every: number; unit: "minutes" | "hours" }
  /** One time on `date` ("YYYY-MM-DD", local to the schedule's zone) at `at`. */
  | { kind: "once"; date: string; at: string };

/** Whether the owner hears about every run or only about problems. */
export type NotifyMode = "always" | "problems";

/** Why a schedule was switched off by the engine (not by the owner). */
export type DisabledReason = "bot_gone" | "group_gone" | "done";

/** A recurring (or one-time) task a bot runs by itself. */
export interface Schedule {
  id: string;
  /** Short label shown on the board. */
  name: string;
  botId: BotId;
  /** The instruction sent to the bot at every fire. */
  task: string;
  rule: RepeatRule;
  /** IANA zone the rule is read in. */
  timeZone: string;
  /** Where the run happens and its messages land. */
  conversationId: ConversationId;
  notify: NotifyMode;
  enabled: boolean;
  /** Epoch ms of the next fire; none when nothing is left to fire. */
  nextRunAt?: number;
  /** Epoch ms of the last fire. */
  lastFireAt?: number;
  /** Set when the engine switched the schedule off. */
  disabledReason?: DisabledReason;
  createdBy: Author;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
}

/** How one fire of a schedule ended (`running` until its wake finishes). */
export type ScheduleRunStatus = "running" | "ok" | "problem" | "failed" | "skipped";

/** One fire of a schedule. */
export interface ScheduleRun {
  id: string;
  scheduleId: string;
  /** The time the fire was planned for. */
  dueAt: number;
  /** The time it actually fired. */
  firedAt: number;
  /** Started by the owner ("run now"), not by the clock. */
  manual: boolean;
  /** Fired well after `dueAt` (the engine was down). */
  late: boolean;
  status: ScheduleRunStatus;
  /** The wake that did the work; none for a skipped fire. */
  wakeId?: string;
  endedAt?: number;
  /** Summed spend of the wake, in USD. */
  costUsd: number;
  error?: string;
}
