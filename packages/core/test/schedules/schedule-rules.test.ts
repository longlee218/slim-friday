import { expect, test } from "bun:test";
import {
  describeRule,
  formatLocal,
  ruleError,
  timeZoneError,
} from "../../src/schedules/schedule-rules";

test("ruleError refuses an interval under 15 minutes", () => {
  expect(ruleError({ kind: "interval", every: 10, unit: "minutes" })).toContain("15 minutes");
});

test("ruleError refuses a badly formed time and accepts good rules", () => {
  expect(ruleError({ kind: "daily", at: "7:30" })).toBeDefined();
  expect(ruleError({ kind: "daily", at: "07:30" })).toBeUndefined();
  expect(ruleError({ kind: "weekly", at: "08:00", weekday: 7 })).toBeDefined();
  expect(ruleError({ kind: "interval", every: 25, unit: "hours" })).toBeDefined();
  expect(ruleError({ kind: "interval", every: 1.5, unit: "hours" })).toBeDefined();
  expect(ruleError({ kind: "interval", every: 15, unit: "minutes" })).toBeUndefined();
  expect(ruleError({ kind: "once", date: "2026-10-26", at: "15:00" })).toBeUndefined();
  expect(ruleError({ kind: "once", date: "26/10/2026", at: "15:00" })).toBeDefined();
});

test("describeRule writes the exact texts", () => {
  const tz = "Asia/Saigon";
  expect(describeRule({ kind: "weekly", at: "08:00", weekday: 1 }, tz)).toBe(
    "Every Monday 08:00 (Asia/Saigon)",
  );
  expect(describeRule({ kind: "daily", at: "07:30" }, tz)).toBe("Every day 07:30 (Asia/Saigon)");
  expect(describeRule({ kind: "weekdays", at: "09:00" }, tz)).toBe("Weekdays 09:00 (Asia/Saigon)");
  expect(describeRule({ kind: "interval", every: 30, unit: "minutes" }, tz)).toBe(
    "Every 30 min (Asia/Saigon)",
  );
  expect(describeRule({ kind: "interval", every: 2, unit: "hours" }, tz)).toBe(
    "Every 2 h (Asia/Saigon)",
  );
  expect(describeRule({ kind: "once", date: "2026-10-26", at: "15:00" }, tz)).toBe(
    "Once 2026-10-26 15:00 (Asia/Saigon)",
  );
});

test("timeZoneError flags an unknown zone only", () => {
  expect(timeZoneError("Mars/Base")).toBeDefined();
  expect(timeZoneError("Asia/Saigon")).toBeUndefined();
});

test("formatLocal prints weekday, day, month and time in the zone", () => {
  expect(formatLocal(Date.parse("2026-10-25T00:30:00Z"), "Asia/Saigon")).toBe("Sun 25 Oct 07:30");
});
