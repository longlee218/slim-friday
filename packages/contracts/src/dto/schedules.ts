import { z } from "zod";
import { BotIdSchema, ConversationIdSchema } from "../ids";
import { AuthorDtoSchema } from "./chat";

// Same rules as core `schedule-rules.ts` (contracts imports only itself, so they are copied).
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** Core `MIN_INTERVAL_MINUTES`. */
const MIN_INTERVAL_MINUTES = 15;

const AtSchema = z.string().regex(TIME, "time must be HH:MM (24 h)");

/** When a schedule fires; mirrors core `RepeatRule` with the same limits. */
export const RepeatRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), at: AtSchema }),
  z.object({ kind: z.literal("weekdays"), at: AtSchema }),
  z.object({
    kind: z.literal("weekly"),
    at: AtSchema,
    weekday: z.number().int().min(0).max(6),
  }),
  z.discriminatedUnion("unit", [
    z.object({
      kind: z.literal("interval"),
      unit: z.literal("minutes"),
      every: z.number().int().min(MIN_INTERVAL_MINUTES),
    }),
    z.object({
      kind: z.literal("interval"),
      unit: z.literal("hours"),
      every: z.number().int().min(1).max(24),
    }),
  ]),
  z.object({
    kind: z.literal("once"),
    date: z.string().regex(DATE, "date must be YYYY-MM-DD"),
    at: AtSchema,
  }),
]);
export type RepeatRuleDto = z.infer<typeof RepeatRuleSchema>;

/** Whether the owner hears about every run or only about problems. */
export const NotifyModeSchema = z.enum(["always", "problems"]);

/** One fire of a schedule. */
export const ScheduleRunDtoSchema = z.object({
  id: z.string(),
  dueAt: z.number(),
  firedAt: z.number(),
  manual: z.boolean(),
  late: z.boolean(),
  status: z.enum(["running", "ok", "problem", "failed", "skipped"]),
  endedAt: z.number().optional(),
  costUsd: z.number(),
  error: z.string().optional(),
  /** The run's final chat message, when it posted one. */
  messageId: z.number().int().optional(),
});
export type ScheduleRunDto = z.infer<typeof ScheduleRunDtoSchema>;

/** A schedule on the board with its latest run. */
export const ScheduleDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  botId: z.string(),
  task: z.string(),
  rule: RepeatRuleSchema,
  timeZone: z.string(),
  /** Human text of the rule (core `describeRule`). */
  when: z.string(),
  conversationId: z.string(),
  notify: NotifyModeSchema,
  enabled: z.boolean(),
  nextRunAt: z.number().optional(),
  disabledReason: z.enum(["bot_gone", "group_gone", "done"]).optional(),
  createdBy: AuthorDtoSchema,
  last: ScheduleRunDtoSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ScheduleDto = z.infer<typeof ScheduleDtoSchema>;

/** Input of `schedules.create`. */
export const ScheduleCreateInputSchema = z.object({
  name: z.string().min(1).max(80),
  botId: BotIdSchema,
  task: z.string().min(1).max(4000),
  rule: RepeatRuleSchema,
  timeZone: z.string().min(1).optional(),
  conversationId: ConversationIdSchema,
  notify: NotifyModeSchema.optional(),
});
