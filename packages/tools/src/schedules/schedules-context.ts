import {
  type BotId,
  type ConversationId,
  describeRule,
  formatLocal,
  type RunKind,
  type Schedule,
  type ScheduleBoard,
  type ScheduleScope,
} from "@friday/core";

/** What the schedule tools of one session need: the bot, the board and the conversation of the turn. */
export interface SchedulesContext {
  botId: BotId;
  board: Pick<ScheduleBoard, "create" | "update" | "remove" | "list">;
  /** The conversation of the turn in progress (read when the tool runs); undefined between turns. */
  conversation: () => ConversationId | undefined;
  /** A group session sees and changes only the schedules that post to its conversation. */
  groupSession: boolean;
  /** What started the run: a `schedule` run gets only `ScheduleList`, an `intro` run none. */
  runKind: RunKind;
}

/** Refusal of a call that needs the conversation of the turn when there is none. */
export const NO_CONVERSATION = "There is no current conversation; schedules need one.";

/**
 * The board scope of one call: the bot, plus the conversation in a group session. A string is the refusal
 * when a group session has no current conversation (the scope would otherwise widen to every chat).
 */
export function scopeOf(ctx: SchedulesContext): ScheduleScope | string {
  if (!ctx.groupSession) return { botId: ctx.botId };
  const conversationId = ctx.conversation();
  return conversationId ? { botId: ctx.botId, conversationId } : NO_CONVERSATION;
}

/** A schedule as the model reads it. */
export function scheduleView(s: Schedule) {
  return {
    id: s.id,
    name: s.name,
    when: describeRule(s.rule, s.timeZone),
    nextRun: s.nextRunAt === undefined ? null : formatLocal(s.nextRunAt, s.timeZone),
    notify: s.notify,
    enabled: s.enabled,
    postsTo: s.conversationId,
    task: s.task,
  };
}
