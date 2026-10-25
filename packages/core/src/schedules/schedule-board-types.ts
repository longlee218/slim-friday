import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { WakeOutcome } from "../hub/hub-types";
import type { Clock } from "../ports/clock";
import type { Log } from "../ports/log";
import type { NextRunAt } from "../ports/next-run";
import type { Store } from "../ports/store";
import type { Surface } from "../ports/surface";
import type { NewRun } from "../runs/run-create";
import type { NotifyMode, RepeatRule, Schedule } from "./schedule";

/** Success with a payload, or a short reason a bot can read. */
export type ScheduleResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: "invalid" | "not_found" | "conflict"; error: string };

/** What a caller gives to create a schedule. */
export interface NewSchedule {
  name: string;
  botId: BotId;
  task: string;
  rule: RepeatRule;
  /** IANA zone; unset: the owner's zone at create time. */
  timeZone?: string;
  conversationId: ConversationId;
  /** Unset: `always`. */
  notify?: NotifyMode;
}

/** The fields a change may set; the time zone never changes. */
export type SchedulePatch = Partial<
  Pick<Schedule, "name" | "task" | "rule" | "notify" | "enabled">
>;

/** Limits a tool call: only schedules of this bot, and in a group session only those posting to that conversation. */
export interface ScheduleScope {
  botId: BotId;
  conversationId?: ConversationId;
}

/** What the board needs; the hub passes its own store, clock, `createRun`, `tell` and surface. */
export interface ScheduleBoardDeps {
  store: Pick<Store, "schedules" | "scheduleRuns" | "bots" | "groups" | "conversations" | "wakes">;
  clock: Clock;
  /** Next-occurrence math; without it schedules cannot be created and nothing fires. */
  nextRunAt?: NextRunAt;
  /** The owner's IANA zone, the default of a new schedule. */
  timeZone: () => string;
  /** Store one run (the hub's `createRun`). */
  createRun: (r: NewRun) => Promise<WakeOutcome>;
  /** Post a system notice in a conversation. */
  tell: (conversationId: ConversationId, text: string) => Promise<void>;
  /** Toast the owner. */
  notifyFinished: Surface["notifyFinished"];
  /** Metadata-only events (`schedule.fired`, `schedule.skipped`, `schedule.failed`). */
  log?: Log;
  /** Told after a create, update, remove, fire and each settled history row; never awaited, never throws out. */
  onChange?: (scheduleId: string) => void;
}

/** Longest name, in characters. */
export const NAME_MAX = 80;
/** Longest task, in characters. */
export const TASK_MAX = 4000;
/** A fire this long after its due time is late (its turn gets the late note). */
export const LATE_MS = 15 * 60_000;
/** Allowed notify modes. */
export const NOTIFY_MODES: readonly NotifyMode[] = ["always", "problems"];

/** A refusal with code `invalid`. */
export const invalid = (error: string) => ({ ok: false, code: "invalid", error }) as const;
/** Refusal: no such schedule (or not in the caller's scope). */
export const NOT_FOUND = { ok: false, code: "not_found", error: "Schedule not found." } as const;

/** True when the schedule is inside the scope (no scope: every schedule). */
export function inScope(s: Schedule, scope?: ScheduleScope): boolean {
  if (!scope) return true;
  if (s.botId !== scope.botId) return false;
  return scope.conversationId === undefined || s.conversationId === scope.conversationId;
}

/** Tell the listener about a change; whatever it throws or rejects stays here. */
export function changed(deps: ScheduleBoardDeps, scheduleId: string): void {
  try {
    const r = deps.onChange?.(scheduleId) as unknown;
    if (r instanceof Promise) r.catch(() => undefined);
  } catch {
    // The app logs its own listener failures.
  }
}
