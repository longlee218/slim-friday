import type { ScheduleDto, ScheduleRunDto } from "@friday/contracts";

/** A daily schedule of `botId` posting to its own chat, on, with sensible defaults. */
export const schedule = (id: string, over: Partial<ScheduleDto> = {}): ScheduleDto => ({
  id,
  name: `Schedule ${id}`,
  botId: "ray",
  task: "Send me the news.",
  rule: { kind: "daily", at: "07:30" },
  timeZone: "UTC",
  when: "Every day · 07:30",
  conversationId: "bot:ray",
  notify: "always",
  enabled: true,
  nextRunAt: Date.UTC(2026, 9, 27, 7, 30),
  createdBy: { kind: "user" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

/** A finished run with the given status. */
export const run = (status: ScheduleRunDto["status"]): ScheduleRunDto => ({
  id: `r-${status}`,
  dueAt: 1,
  firedAt: 1,
  manual: false,
  late: false,
  status,
  costUsd: 0.01,
});
