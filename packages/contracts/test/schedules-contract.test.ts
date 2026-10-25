import { expect, test } from "bun:test";
import { contract, FridayEventSchema, listProcedurePaths, MessageDtoSchema } from "../src";
import { RepeatRuleSchema } from "../src/dto/schedules";

test("RepeatRuleSchema accepts valid rules and refuses bad times and short intervals", () => {
  expect(RepeatRuleSchema.safeParse({ kind: "daily", at: "07:30" }).success).toBe(true);
  expect(RepeatRuleSchema.safeParse({ kind: "weekly", at: "08:00", weekday: 1 }).success).toBe(
    true,
  );
  expect(
    RepeatRuleSchema.safeParse({ kind: "once", date: "2026-11-01", at: "09:00" }).success,
  ).toBe(true);
  expect(RepeatRuleSchema.safeParse({ kind: "daily", at: "25:00" }).success).toBe(false);
  expect(RepeatRuleSchema.safeParse({ kind: "weekly", at: "08:00", weekday: 7 }).success).toBe(
    false,
  );
  expect(
    RepeatRuleSchema.safeParse({ kind: "once", date: "2026-13-01", at: "09:00" }).success,
  ).toBe(false);
  expect(RepeatRuleSchema.safeParse({ kind: "interval", every: 10, unit: "minutes" }).success).toBe(
    false,
  );
  expect(RepeatRuleSchema.safeParse({ kind: "interval", every: 15, unit: "minutes" }).success).toBe(
    true,
  );
  expect(RepeatRuleSchema.safeParse({ kind: "interval", every: 25, unit: "hours" }).success).toBe(
    false,
  );
});

test("contract.schedules has the eight procedures", () => {
  const paths = listProcedurePaths(contract).filter((p) => p.startsWith("schedules."));
  expect(paths).toEqual([
    "schedules.create",
    "schedules.delete",
    "schedules.get",
    "schedules.list",
    "schedules.runNow",
    "schedules.runs",
    "schedules.setEnabled",
    "schedules.update",
  ]);
});

test("the events union parses a schedule event", () => {
  expect(FridayEventSchema.safeParse({ type: "schedule", id: "s1" }).success).toBe(true);
});

test("a MessageDto parses with and without the schedule tag", () => {
  const base = {
    id: 1,
    conversationId: "bot:alpha",
    author: { kind: "user" },
    kind: "text",
    text: "hi",
    at: 1,
  };
  expect(MessageDtoSchema.safeParse(base).success).toBe(true);
  const tagged = MessageDtoSchema.parse({ ...base, schedule: { id: "s1", name: "Brief" } });
  expect(tagged.schedule).toEqual({ id: "s1", name: "Brief" });
});
