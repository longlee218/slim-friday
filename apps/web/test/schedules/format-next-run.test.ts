import { expect, test } from "vitest";
import { formatNextRun } from "../../src/components/schedules/format-next-run";

// 2026-10-26 10:00 in Ho Chi Minh (UTC+7) is 03:00 UTC.
const NOW = Date.UTC(2026, 9, 26, 3, 0);
const TZ = "Asia/Ho_Chi_Minh";
const at = (day: number, h: number, m: number) => Date.UTC(2026, 9, day, h - 7, m);

test("today, tomorrow, this week and later, in the schedule's time zone", () => {
  expect(formatNextRun(at(26, 14, 0), NOW, TZ)).toBe("Today 14:00");
  expect(formatNextRun(at(27, 7, 30), NOW, TZ)).toBe("Tomorrow 07:30");
  expect(formatNextRun(at(29, 8, 0), NOW, TZ)).toBe("Thu 08:00");
  expect(formatNextRun(at(30, 0, 0) + 9 * 86_400_000, NOW, TZ)).toBe("8 Nov 00:00");
});

test("the day is the schedule's day, not UTC's", () => {
  // 01:00 on Oct 27 in UTC+7 is still Oct 26 in UTC.
  expect(formatNextRun(at(27, 1, 0), NOW, TZ)).toBe("Tomorrow 01:00");
});
